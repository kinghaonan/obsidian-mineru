import assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { ConversionManager } from "../src/ui/manager";
import type { ConversionPipeline } from "../src/mineru/pipeline";
import type { ConvertOptions, ConvertReport, FileProgress, ManagerState } from "../src/types";
import { takeNotices } from "./helpers/obsidian-mock";
import { makeTFile } from "./helpers/vault";

const OPTIONS = { outputFolder: "out" } as unknown as ConvertOptions;

function report(overrides: Partial<ConvertReport> = {}): ConvertReport {
	return {
		total: 1,
		succeeded: 1,
		failed: 0,
		skipped: 0,
		results: [{ fileName: "a.pdf", outputPath: "out/a.md" }],
		...overrides,
	};
}

function pipelineStub(
	impl: (
		files: TFile[],
		options: ConvertOptions,
		onProgress: (p: FileProgress) => void,
		signal: { cancelled: boolean },
	) => Promise<ConvertReport>,
) {
	return { convertFiles: impl } as unknown as ConversionPipeline;
}

test("start 驱动 idle → running → done 并广播状态", async (t) => {
	t.after(() => takeNotices());
	const emitted: ManagerState[] = [];
	const manager = new ConversionManager(
		pipelineStub(async (_files, _options, onProgress) => {
			onProgress({ fileName: "a.pdf", state: "uploading" });
			onProgress({ fileName: "a.pdf", state: "done" });
			return report();
		}),
	);
	manager.onStateChange((s) => emitted.push(s));

	const result = await manager.start([makeTFile("a.pdf")], OPTIONS);

	assert.deepEqual(
		emitted.map((s) => s.status),
		["idle", "running", "running", "running", "done"],
	);
	assert.equal(manager.isRunning, false);
	assert.equal(result?.succeeded, 1);

	const last = emitted[emitted.length - 1];
	assert.equal(last.status, "done");
	assert.deepEqual(last.status === "done" ? [...last.progress.values()] : [], [
		{ fileName: "a.pdf", state: "done" },
	]);
	assert.match(takeNotices().join("|"), /MinerU 转换完成：成功 1，失败 0/);
});

test("start 记录最近一次提交的文件列表（activeFiles）", async (t) => {
	t.after(() => takeNotices());
	const manager = new ConversionManager(pipelineStub(async () => report()));
	await manager.start([makeTFile("a.pdf"), makeTFile("b.pdf")], OPTIONS);
	assert.deepEqual(manager.activeFiles.map((f) => f.path), ["a.pdf", "b.pdf"]);
});

test("转换失败进入 failed 状态并提示", async (t) => {
	t.after(() => takeNotices());
	const manager = new ConversionManager(
		pipelineStub(async () => {
			throw new Error("网络炸了");
		}),
	);

	const result = await manager.start([makeTFile("a.pdf")], OPTIONS);
	assert.equal(result, null);
	assert.equal(manager.state.status, "failed");
	assert.equal(manager.state.status === "failed" ? manager.state.error : "", "网络炸了");
	assert.match(takeNotices().join("|"), /MinerU 转换失败：网络炸了/);
});

test("cancel 触发 failed 且不提示完成", async (t) => {
	t.after(() => takeNotices());
	const manager = new ConversionManager(
		pipelineStub(async (_files, _options, onProgress, signal) => {
			onProgress({ fileName: "a.pdf", state: "parsing" });
			signal.cancelled = true;
			return report({ succeeded: 0, failed: 1 });
		}),
	);

	await manager.start([makeTFile("a.pdf")], OPTIONS);
	assert.equal(manager.state.status, "failed");
	const messages = takeNotices().join("|");
	assert.match(messages, /MinerU 转换已取消/);
	assert.ok(!/转换完成/.test(messages));
});

test("运行中重复 start 返回 null", async (t) => {
	t.after(() => takeNotices());
	const gate: { resolve: ((r: ConvertReport) => void) | null } = { resolve: null };
	const manager = new ConversionManager(
		pipelineStub(
			() =>
				new Promise<ConvertReport>((resolve) => {
					gate.resolve = resolve;
				}),
		),
	);
	const first = manager.start([makeTFile("a.pdf")], OPTIONS);
	await Promise.resolve();
	assert.equal(await manager.start([makeTFile("b.pdf")], OPTIONS), null);
	gate.resolve?.(report());
	await first;
});

test("运行中 cancel() 只置位信号，reset() 不生效", async (t) => {
	t.after(() => takeNotices());
	const holder: { signal: { cancelled: boolean } | null } = { signal: null };
	const manager = new ConversionManager(
		pipelineStub(
			(_files, _options, _onProgress, signal) =>
				new Promise<ConvertReport>(() => {
					holder.signal = signal;
				}),
		),
	);
	void manager.start([makeTFile("a.pdf")], OPTIONS);
	await Promise.resolve();

	manager.cancel();
	assert.equal(holder.signal?.cancelled, true);
	manager.reset();
	assert.equal(manager.state.status, "running", "运行中不应被 reset 回 idle");
});

test("空闲时 reset 回到 idle，退订后不再收到事件", () => {
	const manager = new ConversionManager(pipelineStub(async () => report()));
	let calls = 0;
	const off = manager.onStateChange(() => calls++);
	off();
	manager.reset();
	assert.equal(manager.state.status, "idle");
	assert.equal(calls, 1, "退订后不应再收到事件");
});
/* ------------------------------------------------------------ 失败重试 */

function perFileReport(outcomes: Record<string, "ok" | "fail">): ConvertReport {
	const results = Object.entries(outcomes).map(([fileName, state]) =>
		state === "ok"
			? { fileName, outputPath: `out/${fileName}.md` }
			: { fileName, error: "解析失败" },
	);
	return {
		total: results.length,
		succeeded: results.filter((r) => !r.error).length,
		failed: results.filter((r) => r.error).length,
		skipped: 0,
		results,
	};
}

test("failedFiles 只挑出本轮失败的文件", async (t) => {
	t.after(() => takeNotices());
	const manager = new ConversionManager(
		pipelineStub(async () => perFileReport({ "a.pdf": "ok", "b.pdf": "fail" })),
	);
	await manager.start([makeTFile("a.pdf"), makeTFile("b.pdf")], OPTIONS);
	assert.deepEqual(manager.failedFiles.map((f) => f.path), ["b.pdf"]);
	assert.equal(manager.canRetry, true);
});

test("retryFailed 只重跑失败项并合并历史结果", async (t) => {
	t.after(() => takeNotices());
	const seen: string[][] = [];
	let round = 0;
	const manager = new ConversionManager(
		pipelineStub(async (files) => {
			const names = files.map((f) => f.path);
			seen.push(names);
			round++;
			return round === 1
				? perFileReport({ "a.pdf": "ok", "b.pdf": "fail" })
				: perFileReport({ "b.pdf": "ok" });
		}),
	);

	await manager.start([makeTFile("a.pdf"), makeTFile("b.pdf")], OPTIONS);
	assert.deepEqual(seen[0], ["a.pdf", "b.pdf"]);

	const merged = await manager.retryFailed();
	assert.deepEqual(seen[1], ["b.pdf"], "重试只应包含失败项");
	assert.equal(merged?.succeeded, 2, "合并后 a 与 b 都算成功");
	assert.equal(merged?.failed, 0);
	assert.equal(merged?.total, 2);
	assert.equal(merged?.results.find((r) => r.fileName === "b.pdf")?.attempts, 2, "重试过的文件累计 2 次");
	assert.equal(manager.canRetry, false);
});

test("retryFailed 在全部失败被修复后不再累计", async (t) => {
	t.after(() => takeNotices());
	let round = 0;
	const manager = new ConversionManager(
		pipelineStub(async (files) => {
			round++;
			return round === 1
				? perFileReport({ "a.pdf": "fail" })
				: perFileReport({ "a.pdf": "ok" });
		}),
	);
	await manager.start([makeTFile("a.pdf")], OPTIONS);
	await manager.retryFailed();
	assert.equal(manager.lastReport?.succeeded, 1);
	assert.equal(manager.failedFiles.length, 0);
	assert.equal(await manager.retryFailed(), null, "没有失败项时返回 null");
});

test("retryFailed 无失败项时返回 null 且不启动转换", async (t) => {
	t.after(() => takeNotices());
	let calls = 0;
	const manager = new ConversionManager(
		pipelineStub(async () => {
			calls++;
			return perFileReport({ "a.pdf": "ok" });
		}),
	);
	await manager.start([makeTFile("a.pdf")], OPTIONS);
	assert.equal(await manager.retryFailed(), null);
	assert.equal(calls, 1);
});

test("重试沿用上次的选项", async (t) => {
	t.after(() => takeNotices());
	const used: ConvertOptions[] = [];
	let round = 0;
	const manager = new ConversionManager(
		pipelineStub(async (_files, options) => {
			used.push(options);
			round++;
			return round === 1
				? perFileReport({ "a.pdf": "fail" })
				: perFileReport({ "a.pdf": "ok" });
		}),
	);
	await manager.start([makeTFile("a.pdf")], OPTIONS);
	await manager.retryFailed();
	assert.equal(used.length, 2);
	assert.equal(used[1], used[0], "重试应复用同一份选项对象");
});

test("clear 清空记录后无法重试", async (t) => {
	t.after(() => takeNotices());
	const manager = new ConversionManager(
		pipelineStub(async () => perFileReport({ "a.pdf": "fail" })),
	);
	await manager.start([makeTFile("a.pdf")], OPTIONS);
	assert.equal(manager.canRetry, true);
	manager.clear();
	assert.equal(manager.canRetry, false);
	assert.equal(manager.lastReport, null);
	assert.deepEqual(manager.activeFiles, []);
	assert.equal(manager.state.status, "idle");
});
