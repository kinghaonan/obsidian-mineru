import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversionPipeline } from "../src/mineru/pipeline";
import type { ConvertOptions } from "../src/types";
import { createApp, createVault } from "./helpers/vault";
import { fakeClient, makePdf } from "./helpers/fake-client";
import type { FakeClient } from "./helpers/fake-client";

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

/** 建一个含二进制 PDF 的库 */
async function vaultWithPdf(name: string, pages: number) {
	const vault = createVault();
	const file = vault.seed(name, await makePdf(pages));
	return { vault, file };
}

function pipelineFor(vault: ReturnType<typeof createVault>, fake: FakeClient) {
	return new ConversionPipeline(createApp(vault) as never, fake.client, () => ({ mineruApiToken: "t" }));
}

/* ---------------------------------------------------- 覆盖策略 */

test("collisionPolicy=overwrite 覆盖已有 Markdown 与图片", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const pipeline = pipelineFor(vault, fakeClient());
	const contents = (markdown: string, bytes: number[]) => ({
		markdown,
		images: [{ relPath: "1.jpg", data: new Uint8Array(bytes) }],
		extras: [],
	});

	const first = await pipeline.writeResult(vault.getFiles()[0], "文档", contents("旧内容", [1]), {
		...OPTIONS,
		collisionPolicy: "overwrite",
	});
	const second = await pipeline.writeResult(vault.getFiles()[0], "文档", contents("新内容", [2, 2]), {
		...OPTIONS,
		collisionPolicy: "overwrite",
	});

	assert.equal(first.outputPath, second.outputPath, "应写回同一个文件");
	assert.equal(await vault.read(vault.getAbstractFileByPath(second.outputPath) as never), "新内容");
	assert.deepEqual([...vault.entries.get("MinerU转换/文档.assets/1.jpg")!.data], [2, 2], "图片应被覆盖");
});

test("collisionPolicy=overwrite 覆盖附加产物", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const pipeline = pipelineFor(vault, fakeClient());
	const withExtra = (text: string) => ({
		markdown: "正文",
		images: [],
		extras: [{ format: "docx", fileName: "x.docx", data: new Uint8Array([text.length]) }],
	});
	await pipeline.writeResult(vault.getFiles()[0], "文档", withExtra("a"), {
		...OPTIONS,
		collisionPolicy: "overwrite",
	});
	await pipeline.writeResult(vault.getFiles()[0], "文档", withExtra("bbb"), {
		...OPTIONS,
		collisionPolicy: "overwrite",
	});
	assert.deepEqual([...vault.entries.get("MinerU转换/文档.docx")!.data], [3], "附加产物应被覆盖");
});

test("collisionPolicy=skip 跳过已存在目标且不改动文件", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const pipeline = pipelineFor(vault, fakeClient());
	await pipeline.writeResult(
		vault.getFiles()[0],
		"文档",
		{ markdown: "旧内容", images: [], extras: [] },
		{ ...OPTIONS, collisionPolicy: "overwrite" },
	);
	const skipped = await pipeline.writeResult(
		vault.getFiles()[0],
		"文档",
		{ markdown: "新内容", images: [], extras: [] },
		{ ...OPTIONS, collisionPolicy: "skip" },
	);
	assert.equal(skipped.skipped, true);
	assert.equal(await vault.read(vault.getAbstractFileByPath("MinerU转换/文档.md") as never), "旧内容");
});

test("convertFiles 汇总 skipped 计数", async () => {
	const vault = createVault();
	vault.seed("报告.pdf", "x");
	vault.seed("MinerU转换/报告.md", "已有");
	const pipeline = pipelineFor(vault, fakeClient());
	const report = await pipeline.convertFiles(
		vault.getFiles().filter((f) => f.path === "报告.pdf"),
		{ ...OPTIONS, collisionPolicy: "skip" },
		() => {},
		{ cancelled: false },
	);
	assert.equal(report.skipped, 1);
	assert.equal(report.succeeded, 0);
	assert.equal(report.failed, 0);
	assert.equal(report.results[0].skipped, true);
});

/* --------------------------------------------- 图片路径与链接可用性 */

test("文档名含空格括号时图片目录与链接都可用", async () => {
	const vault = createVault();
	vault.seed("Analytical Mechanics of Space Systems (Aiaa Education).pdf", "x");
	const pipeline = pipelineFor(vault, fakeClient());
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		"Analytical Mechanics of Space Systems (Aiaa Education)",
		{ markdown: "![](images/a.jpg)", images: [{ relPath: "a.jpg", data: new Uint8Array([1]) }], extras: [] },
		OPTIONS,
	);

	const folder = "MinerU转换/Analytical-Mechanics-of-Space-Systems-Aiaa-Education.assets";
	assert.ok(vault.entries.has(`${folder}/a.jpg`), "图片应落在链接安全的目录里");
	const md = await vault.read(vault.getAbstractFileByPath(written.outputPath) as never);
	assert.equal(md, "![](Analytical-Mechanics-of-Space-Systems-Aiaa-Education.assets/a.jpg)");
	assert.ok(!md.includes(" "), "链接里不能出现裸空格");
});

test("自定义图片目录含空格时链接会被编码", async () => {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const pipeline = pipelineFor(vault, fakeClient());
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		"文档",
		{ markdown: "![](images/a.jpg)", images: [{ relPath: "a.jpg", data: new Uint8Array([1]) }], extras: [] },
		{ ...OPTIONS, imageFolder: "附件 图" },
	);
	const md = await vault.read(vault.getAbstractFileByPath(written.outputPath) as never);
	// 相对路径回退到上一级；中文保持原样，空格编码为 %20
	assert.equal(md, "![](../附件%20图/a.jpg)");
	assert.ok(vault.entries.has("附件 图/a.jpg"), "磁盘上的目录名保持用户填写的原样");
});

/* ------------------------------------------------ 大文件切分合并 */

test("大文件 PDF 自动切分、上传并按顺序合并", async () => {
	const { vault, file } = await vaultWithPdf("长文.pdf", 10);
	const fake = fakeClient();
	const pipeline = pipelineFor(vault, fake);
	const report = await pipeline.convertFiles(
		[file],
		{ ...OPTIONS, split: { enabled: true, maxPages: 4, maxSizeMB: 100, dedupeTitle: true } },
		() => {},
		{ cancelled: false },
	);

	assert.equal(fake.calls.targets.length, 3, "10 页按 4 页/片应切 3 片");
	assert.ok(fake.calls.targets.every((n) => /^长文__p\d+-\d+-\d+\.pdf$/.test(n)), fake.calls.targets.join(","));
	assert.equal(fake.calls.put.length, 3, "全部分片应一次性上传（同一批次）");
	assert.equal(report.succeeded, 1);
	assert.equal(report.results[0].parts, 3);

	const md = await vault.read(vault.getAbstractFileByPath("MinerU转换/长文.md") as never);
	assert.ok(md.includes("分片1 第1-4页"));
	assert.ok(md.includes("分片2 第5-8页"));
	assert.ok(md.includes("分片3 第9-10页"));
	assert.ok(md.indexOf("分片1") < md.indexOf("分片2"), "应按页码顺序合并");
	assert.ok(md.includes("<!-- MinerU 分片"));
	assert.ok(vault.entries.has("MinerU转换/长文.assets/p1_1.jpg"), "跨分片同名图片应带前缀");
	assert.ok(vault.entries.has("MinerU转换/长文.assets/p3_1.jpg"));
	assert.ok(md.includes("长文.assets/p2_1.jpg"), "合并后的链接应指向最终图片");
});

test("切分时进度带分片标记", async () => {
	const { vault, file } = await vaultWithPdf("长文.pdf", 6);
	const pipeline = pipelineFor(vault, fakeClient());
	const parts = new Set<string>();
	await pipeline.convertFiles(
		[file],
		{ ...OPTIONS, split: { enabled: true, maxPages: 3, maxSizeMB: 100, dedupeTitle: true } },
		(p) => {
			if (p.part) parts.add(p.part);
		},
		{ cancelled: false },
	);
	assert.deepEqual([...parts].sort(), ["1/2 分片", "2/2 分片"]);
});

test("分片之一失败时整份文件失败并说明页码", async () => {
	const { vault, file } = await vaultWithPdf("六页.pdf", 6);
	const fake = fakeClient({
		pollOverride: (targets) =>
			targets.map((name, i) =>
				i === 1
					? { fileName: name, state: "failed", errMsg: "分片解析失败" }
					: { fileName: name, state: "done", fullZipUrl: `https://zip/${encodeURIComponent(name)}` },
			),
	});
	const pipeline = pipelineFor(vault, fake);
	const report = await pipeline.convertFiles(
		[file],
		{ ...OPTIONS, split: { enabled: true, maxPages: 3, maxSizeMB: 100, dedupeTitle: true } },
		() => {},
		{ cancelled: false },
	);
	assert.equal(report.failed, 1);
	assert.match(report.results[0].error ?? "", /分片解析失败/);
	assert.match(report.results[0].error ?? "", /第 4-6 页/);
	assert.equal(vault.entries.size, 1, "失败时不应写出结果文件");
});

test("未开启切分时超页数 PDF 原样上传", async () => {
	const { vault, file } = await vaultWithPdf("十页.pdf", 10);
	const fake = fakeClient();
	const pipeline = pipelineFor(vault, fake);
	const report = await pipeline.convertFiles([file], OPTIONS, () => {}, { cancelled: false });
	assert.deepEqual(fake.calls.targets, ["十页.pdf"]);
	assert.equal(report.succeeded, 1);
	assert.equal(report.results[0].parts, 1);
});

test("切分关闭时即便页数超限也只上传一个文件", async () => {
	const { vault, file } = await vaultWithPdf("十页.pdf", 10);
	const fake = fakeClient();
	const pipeline = pipelineFor(vault, fake);
	await pipeline.convertFiles(
		[file],
		{ ...OPTIONS, split: { enabled: false, maxPages: 1, maxSizeMB: 1, dedupeTitle: true } },
		() => {},
		{ cancelled: false },
	);
	assert.equal(fake.calls.targets.length, 1);
});

test("非 PDF 文件不做切分", async () => {
	const vault = createVault();
	vault.seed("报表.xlsx", "binary");
	const fake = fakeClient();
	const pipeline = pipelineFor(vault, fake);
	await pipeline.convertFiles(
		vault.getFiles(),
		{ ...OPTIONS, split: { enabled: true, maxPages: 1, maxSizeMB: 1, dedupeTitle: true } },
		() => {},
		{ cancelled: false },
	);
	assert.deepEqual(fake.calls.targets, ["报表.xlsx"]);
});