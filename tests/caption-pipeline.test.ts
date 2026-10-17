import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversionPipeline } from "../src/mineru/pipeline";
import type { ConvertOptions } from "../src/types";
import { createApp, createVault } from "./helpers/vault";
import { fakeClient } from "./helpers/fake-client";

/** 图注命名端到端：文件名、HTML 图注区、原文行移除 */

const BASE: ConvertOptions = {
	outputFolder: "文献",
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
	convertImageToHtml: true,
	imageWidth: 80,
	showImageFilename: true,
	collisionPolicy: "rename",
	split: { enabled: false, maxPages: 80, maxSizeMB: 100, dedupeTitle: true },
};

async function convert(
	markdown: string,
	images: string[],
	options: Partial<ConvertOptions> = {},
	basename = "论文",
) {
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const { client } = fakeClient();
	const pipeline = new ConversionPipeline(createApp(vault) as never, client, () => ({ mineruApiToken: "t" }));
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		basename,
		{
			markdown,
			images: images.map((relPath) => ({ relPath, data: new Uint8Array([relPath.length]) })),
			extras: [],
		},
		{ ...BASE, ...options },
	);
	return { vault, md: await vault.read(vault.getAbstractFileByPath(written.outputPath) as never) };
}

const asset = (name: string) => `文献/论文.assets/${name}`;

test("按图注重命名图片并写入 HTML 图注区", async () => {
	const { vault, md } = await convert(
		["# 章节", "", "![](images/p1_a.jpg)", "Fig. 1.2 The cylindrical coordinate system.", "", "正文段落。", ""].join("\n"),
		["p1_a.jpg"],
	);
	const name = "Fig.1.2-The-cylindrical-coordinate-system.jpg";
	assert.ok(vault.entries.has(asset(name)), `图片应以图注命名：${[...vault.entries.keys()].join(", ")}`);
	assert.ok(!vault.entries.has(asset("p1_a.jpg")), "旧哈希名不应保留");
	assert.ok(md.includes(`src="${asset(name).replace("文献/", "")}"`), md);
	assert.ok(md.includes('<span class="mineru-figcaption">Fig. 1.2 The cylindrical coordinate system.</span>'));
});

test("原文图注行被移除，不重复显示", async () => {
	const { md } = await convert(
		["![](images/a.jpg)", "Fig. 1.1 标题", "", "正文保持。", ""].join("\n"),
		["a.jpg"],
	);
	assert.ok(!md.includes("\nFig. 1.1 标题"), "原图注行应被删除");
	assert.ok(md.includes("正文保持。"), "正文不应受影响");
	assert.equal(md.match(/Fig\. 1\. 1|Fig\. 1\.1/g)?.length ?? 0, 1, "图注只应出现一次");
});

test("无图注时回退显示文件名", async () => {
	const { md } = await convert(["![](images/p1_b.jpg)", "", "正文。", ""].join("\n"), ["p1_b.jpg"]);
	assert.ok(md.includes("<strong>p1_b.jpg</strong>"), "无图注应回退到文件名加粗");
	assert.ok(!md.includes("mineru-figcaption"));
});

test("imageCaptionNaming=false 只关闭命名，不影响图注展示", async () => {
	const { vault, md } = await convert(
		["![](images/a.jpg)", "Fig. 1.2 标题", ""].join("\n"),
		["a.jpg"],
		{ imageCaptionNaming: false },
	);
	assert.ok(vault.entries.has(asset("a.jpg")), "关闭命名功能应保留原名");
	assert.ok(
		md.includes("Fig. 1.2 标题"),
		"命名与展示相互独立，关闭命名后图注仍应显示",
	);
});

test("showFigureCaption=false 时不注入图注", async () => {
	const { md } = await convert(
		["![](images/a.jpg)", "Fig. 1.2 标题", ""].join("\n"),
		["a.jpg"],
		{ showFigureCaption: false },
	);
	assert.ok(md.includes("<strong>Fig.1.2-标题.jpg</strong>"), "关闭图注展示则显示文件名");
});

test("子图：共用图注只显示一次，子图用标签命名", async () => {
	const { vault, md } = await convert(
		[
			"![](images/1.jpg)",
			"c) Maximum energy case",
			"![](images/2.jpg)",
			"Fig. 4.9 Special cases of kinetic energy ellipsoid.",
			"",
		].join("\n"),
		["1.jpg", "2.jpg"],
	);
	const main = "Fig.4.9-Special-cases-of-kinetic-energy-ellipsoid.jpg";
	assert.ok(vault.entries.has(asset(main)), [...vault.entries.keys()].join(","));
	assert.ok(vault.entries.has(asset("Fig.4.9-Maximum-energy-case.jpg")), "子图用子标签命名");
	assert.equal(
		(md.match(/Fig\. 4\.9 Special cases/g) ?? []).length,
		1,
		"整组图注只应渲染一次",
	);
	assert.ok(md.includes("Maximum energy case"), "子图标签应显示在子图下");
});

test("图号与标题完全相同时自动去重", async () => {
	const { vault } = await convert(
		["![](images/1.jpg)", "Fig. 1.3 Duplicate.", "", "![](images/2.jpg)", "Fig. 1.3 Duplicate.", ""].join("\n"),
		["1.jpg", "2.jpg"],
	);
	const names = [...vault.entries.keys()].filter((k) => k.includes("Fig.1.3"));
	assert.equal(names.length, 2, "同名应生成两个文件");
	assert.ok(names.some((n) => n.endsWith("-2.jpg")), [...names].join(","));
	assert.ok(vault.entries.has(asset("Fig.1.3-Duplicate.jpg")), "第一个保持原名");
});

test("closeImageCaption=false 时保留原文图注行", async () => {
	const { md } = await convert(
		["![](images/a.jpg)", "Fig. 1.2 标题", ""].join("\n"),
		["a.jpg"],
		{ removeCaptionLines: false },
	);
	assert.ok(md.includes("Fig. 1.2 标题"), "关闭移除时应保留原文图注行");
	assert.ok(md.includes("mineru-figcaption"), "HTML 图注仍应渲染");
});

test("图注文本做 HTML 转义防注入", async () => {
	const { md } = await convert(
		['![](images/a.jpg)', 'Fig. 1.2 <script>alert(1)</script> & "x"', ""].join("\n"),
		["a.jpg"],
	);
	assert.ok(!md.includes("<script>"), "不应注入原始 HTML");
	assert.ok(md.includes("&lt;script&gt;"), md);
	assert.ok(md.includes("&amp;"), "与号需转义");
});

test("closeMarkdown 时用 Markdown 语法渲染图注", async () => {
	const { md } = await convert(
		["![](images/a.jpg)", "Fig. 1.2 标题", ""].join("\n"),
		["a.jpg"],
		{ convertImageToHtml: false },
	);
	assert.ok(md.includes("![](论文.assets/Fig.1.2-标题.jpg)"), md);
	assert.ok(!md.includes("Fig. 1.2 标题"), "原文行应移除");
});

test("图片在表格式排版中也能识别", async () => {
	const { md } = await convert(
		["| 图 | 说明 |", "| --- | --- |", "| ![](images/a.jpg) | 示意图 |", "Fig. 2.1 表格用图", ""].join("\n"),
		["a.jpg"],
	);
	assert.ok(md.includes("mineru-figcaption"), md);
});