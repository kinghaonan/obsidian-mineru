import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversionPipeline } from "../src/mineru/pipeline";
import { MineruError } from "../src/mineru/errors";
import type { ConvertOptions, FileProgress } from "../src/types";
import type { MineruClient } from "../src/mineru/api";
import { createApp, createVault } from "./helpers/vault";
import { buildZip, fakeClient, type FakeClientOptions } from "./helpers/fake-client";

const OPTIONS: ConvertOptions = {
	outputFolder: "MinerU转换",
	params: {
		modelVersion: "vlm",
		isOcr: false,
		enableFormula: true,
		enableTable: true,
		language: "ch",
		extraFormats: [],
	},
	downloadImages: true,
	imageFolder: "",
	convertImageToHtml: false,
	imageWidth: 80,
	showImageFilename: false,
	collisionPolicy: "rename",
	split: { enabled: false, maxPages: 80, maxSizeMB: 100, dedupeTitle: true },
};

// 假客户端与结果 zip 生成集中在 tests/helpers/fake-client.ts

function setup(files: Record<string, string>, opts: FakeClientOptions = {}) {
	const vault = createVault();
	for (const [path, content] of Object.entries(files)) vault.seed(path, content);
	const app = createApp(vault);
	const { client, calls } = fakeClient(opts);
	const pipeline = new ConversionPipeline(app as never, client, () => ({ mineruApiToken: "t" }));
	return { vault, pipeline, calls, fileList: vault.getFiles() };
}

test("convertFiles 写入 Markdown、图片并改写相对链接", async () => {
	const { vault, pipeline, calls } = setup({ "报告.pdf": "%PDF-1.4" }, { zip: await buildZip() });
	const events: FileProgress[] = [];
	const report = await pipeline.convertFiles(
		vault.getFiles(),
		OPTIONS,
		(e) => events.push(e),
		{ cancelled: false },
	);

	assert.equal(report.total, 1);
	assert.equal(report.succeeded, 1);
	assert.equal(report.failed, 0);
	assert.deepEqual(calls.put, ["https://up/0"]);

	const result = report.results[0];
	assert.equal(result.outputPath, "MinerU转换/报告.md");
	assert.equal(result.images, 1);
	assert.equal(result.extras, 0);

	const md = await vault.read(vault.getAbstractFileByPath("MinerU转换/报告.md") as never);
	assert.equal(md, "# 标题\n\n![图](报告.assets/1.jpg)");
	assert.ok(vault.entries.has("MinerU转换/报告.assets/1.jpg"));
	assert.deepEqual([...vault.entries.get("MinerU转换/报告.assets/1.jpg")!.data], [9, 8, 7]);

	assert.ok(events.some((e) => e.state === "uploading"));
	assert.ok(events.some((e) => e.state === "parsing"));
	assert.ok(events.some((e) => e.state === "done"));
});

test("convertFiles 附加格式按 EXTRA_EXT_MAP 落盘", async () => {
	const { vault, pipeline } = setup({ "报告.pdf": "x" }, { zip: await buildZip() });
	const report = await pipeline.convertFiles(
		vault.getFiles(),
		{ ...OPTIONS, params: { ...OPTIONS.params, extraFormats: ["docx", "latex"] } },
		() => {},
		{ cancelled: false },
	);
	assert.equal(report.results[0].extras, 2);
	assert.ok(vault.entries.has("MinerU转换/报告.docx"));
	assert.ok(vault.entries.has("MinerU转换/报告.tex"), "latex 应导出为 .tex");
});

test("convertFiles 申请上传地址报 -500 时去掉附加格式重试", async () => {
	const vault = createVault();
	vault.seed("报告.pdf", "x");
	const { client, calls } = fakeClient({
		zip: await buildZip(),
		failUploadAttempt: { attempt: 1, error: new MineruError("请求参数错误", -500) },
	});
	const pipeline = new ConversionPipeline(createApp(vault) as never, client, () => ({ mineruApiToken: "t" }));
	const report = await pipeline.convertFiles(
		vault.getFiles(),
		{ ...OPTIONS, params: { ...OPTIONS.params, extraFormats: ["docx"] } },
		() => {},
		{ cancelled: false },
	);

	assert.equal(calls.uploadRequests.length, 2, "应重试一次");
	assert.deepEqual(calls.uploadRequests[0].extraFormats, ["docx"]);
	assert.deepEqual(calls.uploadRequests[1].extraFormats, [], "重试时去掉 extraFormats");
	assert.equal(report.succeeded, 1);
	assert.equal(report.results[0].extras, 0, "降级后不再导出附加格式");
	assert.ok(vault.entries.has("MinerU转换/报告.md"));
});

test("convertFiles 超过 200MB 的文件被跳过并记为失败", async () => {
	const vault = createVault();
	vault.seed("超大.pdf", "x");
	const app = {
		vault: {
			...vault,
			readBinary: async () => ({ byteLength: 201 * 1024 * 1024 }) as ArrayBuffer,
			getFiles: () => vault.getFiles(),
		},
	};
	const { client } = fakeClient({ zip: await buildZip() });
	const pipeline = new ConversionPipeline(app as never, client, () => ({ mineruApiToken: "t" }));
	const report = await pipeline.convertFiles(app.vault.getFiles(), OPTIONS, () => {}, { cancelled: false });

	assert.equal(report.failed, 1);
	assert.match(report.results[0].error ?? "", /200MB/);
});

test("convertFiles 未配置 Token 直接报错", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const { client } = fakeClient();
	const pipeline = new ConversionPipeline(createApp(vault) as never, client, () => ({ mineruApiToken: "" }));
	await assert.rejects(
		() => pipeline.convertFiles(vault.getFiles(), OPTIONS, () => {}, { cancelled: false }),
		/MinerU API Token/,
	);
});

test("convertFiles 取消信号立即中断", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const { client } = fakeClient();
	const pipeline = new ConversionPipeline(createApp(vault) as never, client, () => ({ mineruApiToken: "t" }));
	await assert.rejects(
		() => pipeline.convertFiles(vault.getFiles(), OPTIONS, () => {}, { cancelled: true }),
		(e: unknown) => e instanceof MineruError && e.code === "CANCELLED",
	);
});

test("convertFiles 解析失败的文件单独记为失败", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const client = {
		async getUploadUrls() {
			return { batchId: "b", urls: ["u"] };
		},
		async putFile() {},
		async pollBatch(_id: string, onUpdate: (r: unknown[]) => void) {
			onUpdate([{ fileName: "a.pdf", state: "failed", errMsg: "文件已损坏" }]);
			return [{ fileName: "a.pdf", state: "failed", errMsg: "文件已损坏" }];
		},
		async downloadZip() {
			throw new Error("不应被调用");
		},
	} as unknown as MineruClient;
	const pipeline = new ConversionPipeline(createApp(vault) as never, client, () => ({ mineruApiToken: "t" }));
	const report = await pipeline.convertFiles(vault.getFiles(), OPTIONS, () => {}, { cancelled: false });
	assert.equal(report.failed, 1);
	assert.equal(report.results[0].error, "文件已损坏");
});

test("writeResult 目标已存在时追加 (1)", async () => {
	const { vault, pipeline } = setup({ "a.pdf": "x" });
	const contents = { markdown: "正文", images: [], extras: [] };
	await pipeline.writeResult(vault.getFiles()[0], "文档", contents, OPTIONS);
	await pipeline.writeResult(vault.getFiles()[0], "文档", contents, OPTIONS);
	assert.ok(vault.entries.has("MinerU转换/文档.md"));
	assert.ok(vault.entries.has("MinerU转换/文档 (1).md"));
});

test("writeResult 关闭图片下载时保留原链接", async () => {
	const { vault, pipeline } = setup({ "a.pdf": "x" });
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		"文档",
		{ markdown: "![图](images/1.jpg)", images: [{ relPath: "1.jpg", data: new Uint8Array([1]) }], extras: [] },
		{ ...OPTIONS, downloadImages: false },
	);
	assert.equal(written.imageCount, 0);
	const md = await vault.read(vault.getAbstractFileByPath(written.outputPath) as never);
	assert.equal(md, "![图](images/1.jpg)");
});

test("writeResult 居中 HTML + 加粗文件名", async () => {
	const { vault, pipeline } = setup({ "a.pdf": "x" });
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		"文档",
		{ markdown: "![甲](文档.assets/1.jpg)", images: [], extras: [] },
		{ ...OPTIONS, convertImageToHtml: true, imageWidth: 60, showImageFilename: true },
	);
	const md = await vault.read(vault.getAbstractFileByPath(written.outputPath) as never);
	assert.equal(
		md,
		'<div style="text-align:center"><img src="文档.assets/1.jpg" alt="甲" width="60%"/><br/><strong>1.jpg</strong></div>',
	);
});

test("writeResult 自定义图片目录逐级创建", async () => {
	const { vault, pipeline } = setup({ "a.pdf": "x" });
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		"文档",
		{ markdown: "![图](1.jpg)", images: [{ relPath: "1.jpg", data: new Uint8Array([2]) }], extras: [] },
		{ ...OPTIONS, imageFolder: "附件/文档图" },
	);
	assert.ok(vault.folders.has("附件/文档图"));
	const md = await vault.read(vault.getAbstractFileByPath(written.outputPath) as never);
	assert.equal(md, "![图](../附件/文档图/1.jpg)");
});