import assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { TranslationQueue, translateOptionsFromSettings } from "../src/translate/queue";
import type { Translator } from "../src/translate/translator";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/settings";
import { takeNotices } from "./helpers/obsidian-mock";
import { createApp, createVault, makeTFile } from "./helpers/vault";
import type { TranslateOptions } from "../src/types";

interface RunOutcome {
	file: TFile;
	warnings: string[];
}

/** 假翻译器：记录调用顺序，可控制失败与并发观测 */
function fakeTranslator(options: {
	delay?: () => Promise<void>;
	failFor?: Set<string>;
	onProgress?: (file: TFile) => void;
} = {}) {
	const calls: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const translator = {
		async translateFile(file: TFile, _opts: TranslateOptions, _settings: () => PluginSettings, onProgress?: (d: number, t: number) => void) {
			calls.push(file.path);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if (options.delay) await options.delay();
				onProgress?.(1, 2);
				onProgress?.(2, 2);
				options.onProgress?.(file);
				if (options.failFor?.has(file.path)) throw new Error("翻译接口报错");
				return { file, warnings: [] } as RunOutcome;
			} finally {
				inFlight--;
			}
		},
		async reveal() {},
	} as unknown as Translator;
	return { translator, calls, maxInFlight: () => maxInFlight };
}

function setup(files: Record<string, string>, settings: Partial<PluginSettings> = {}, translatorOpts = {}) {
	const vault = createVault();
	for (const [path, content] of Object.entries(files)) vault.seed(path, content);
	const app = createApp(vault);
	const fake = fakeTranslator(translatorOpts);
	const resolved: PluginSettings = {
		...DEFAULT_SETTINGS,
		openaiApiKey: "sk-test",
		...settings,
	};
	const queue = new TranslationQueue(app as never, fake.translator, () => resolved);
	return { vault, app, queue, ...fake };
}

test("translateOptionsFromSettings 与单文件翻译保持一致", () => {
	const s = { ...DEFAULT_SETTINGS, targetLanguage: "ja", chunkSizeChars: 1234, collisionPolicy: "overwrite" as const };
	assert.deepEqual(translateOptionsFromSettings(s), {
		targetLanguage: "ja",
		preserveFrontmatter: DEFAULT_SETTINGS.preserveFrontmatter,
		translateFrontmatterTitle: DEFAULT_SETTINGS.translateFrontmatterTitle,
		chunkSizeChars: 1234,
		collisionPolicy: "overwrite",
	});
});

test("add 只接受 Markdown 且忽略重复项", () => {
	const { queue, vault } = setup({ "a.md": "x", "b.md": "y", "c.pdf": "z" });
	assert.equal(queue.add(vault.getFiles()), 2);
	assert.equal(queue.add([makeTFile("a.md")]), 0);
	assert.deepEqual(queue.state.items.map((i) => i.path), ["a.md", "b.md"]);
	assert.equal(queue.state.total, 2);
});

test("start 逐项翻译并统计完成数", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault, calls } = setup({ "a.md": "x", "b.md": "y" });
	queue.add(vault.getFiles());
	queue.start();
	await waitIdle(queue);
	assert.deepEqual(calls.sort(), ["a.md", "b.md"]);
	assert.equal(queue.state.done, 2);
	assert.equal(queue.state.failed, 0);
	assert.equal(queue.isRunning, false);
});

test("并发数受设置限制", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault, maxInFlight } = setup(
		{ "a.md": "1", "b.md": "2", "c.md": "3", "d.md": "4" },
		{ translationConcurrency: 2 },
		{ delay: () => new Promise((r) => setTimeout(r, 5)) },
	);
	queue.add(vault.getFiles());
	queue.start();
	await waitIdle(queue);
	assert.equal(maxInFlight(), 2, "同时进行的翻译不应超过并发上限");
	assert.equal(queue.state.done, 4);
});

test("并发数为 1 时串行", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault, maxInFlight } = setup(
		{ "a.md": "1", "b.md": "2" },
		{ translationConcurrency: 1 },
		{ delay: () => new Promise((r) => setTimeout(r, 5)) },
	);
	queue.add(vault.getFiles());
	queue.start();
	await waitIdle(queue);
	assert.equal(maxInFlight(), 1);
});

test("失败项被记录且可重置重试", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault } = setup(
		{ "a.md": "1", "b.md": "2" },
		{},
		{ failFor: new Set(["b.md"]) },
	);
	queue.add(vault.getFiles());
	queue.start();
	await waitIdle(queue);

	assert.equal(queue.state.failed, 1);
	const failed = queue.state.items.find((i) => i.path === "b.md");
	assert.match(failed?.error ?? "", /翻译接口报错/);

	assert.equal(queue.resetFailed(), 1);
	assert.equal(queue.pending.length, 1, "重置后应回到待处理");
});

test("cancel 让未开始项标记为跳过", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault } = setup(
		{ "a.md": "1", "b.md": "2", "c.md": "3" },
		{ translationConcurrency: 1 },
		{ delay: () => new Promise((r) => setTimeout(r, 10)) },
	);
	queue.add(vault.getFiles());
	queue.start();
	await new Promise((r) => setTimeout(r, 1));
	queue.cancel();
	await waitIdle(queue);

	assert.equal(queue.state.skipped, 2, "未开始的项应被跳过");
	assert.equal(queue.state.done, 1);
});

test("remove 与 clear 生效", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault } = setup({ "a.md": "1", "b.md": "2" });
	queue.add(vault.getFiles());
	const first = queue.state.items[0];
	queue.remove(first.id);
	assert.equal(queue.state.total, 1);
	queue.clear();
	assert.equal(queue.state.total, 0);
	assert.deepEqual(queue.state.items, []);
});

test("运行中 clear 只清掉未开始的部分", async (t) => {
	t.after(() => takeNotices());
	const { queue, vault } = setup(
		{ "a.md": "1", "b.md": "2", "c.md": "3" },
		{ translationConcurrency: 1 },
		{ delay: () => new Promise((r) => setTimeout(r, 10)) },
	);
	queue.add(vault.getFiles());
	queue.start();
	await new Promise((r) => setTimeout(r, 1));
	queue.clear();
	assert.equal(queue.state.total, 1, "只保留正在执行的那一项");
	await waitIdle(queue);
	assert.equal(queue.state.done, 1);
});

test("start 可临时覆盖目标语言", async (t) => {
	t.after(() => takeNotices());
	const seen: TranslateOptions[] = [];
	const vault = createVault();
	vault.seed("a.md", "x");
	const app = createApp(vault);
	const translator = {
		async translateFile(_f: TFile, opts: TranslateOptions) {
			seen.push(opts);
			return { file: makeTFile("a.en.md"), warnings: [] };
		},
	} as unknown as Translator;
	const queue = new TranslationQueue(app as never, translator, () => ({
		...DEFAULT_SETTINGS,
		targetLanguage: "en",
	}));

	queue.add(vault.getFiles());
	queue.start({ targetLanguage: "ja" });
	await waitIdle(queue);
	assert.equal(seen[0].targetLanguage, "ja");
});

test("空队列 start 不报错", async (t) => {
	t.after(() => takeNotices());
	const { queue } = setup({});
	queue.start();
	assert.equal(queue.state.total, 0);
	assert.equal(queue.isRunning, false);
});

/** 等待队列跑到空闲 */
async function waitIdle(queue: TranslationQueue, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (queue.isRunning && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.equal(queue.isRunning, false, "队列未在预期时间内结束");
}