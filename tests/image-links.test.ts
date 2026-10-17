import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversionPipeline } from "../src/mineru/pipeline";
import { assetFolderName, encodeLinkUrl } from "../src/utils";
import type { ConvertOptions } from "../src/types";
import { createApp, createVault } from "./helpers/vault";
import { fakeClient } from "./helpers/fake-client";

/**
 * 回归：真实案例「Analytical Mechanics of Space Systems (Aiaa Education)」
 * 文档名带空格与括号时，生成的图片链接不能被 Markdown 截断。
 */

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

const NAME = "Analytical Mechanics of Space Systems (Aiaa Education)";

/** 模拟 Markdown 解析器：URL 遇到空格或未闭合括号即截断 */
function parsedUrl(link: string): string {
	const m = link.match(/^!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)/);
	return (m?.[1] ?? "").replace(/^<|>$/g, "");
}

async function convert(overrides: Partial<ConvertOptions> = {}) {
	const vault = createVault();
	vault.seed(`${NAME}.pdf`, "x");
	const { client } = fakeClient();
	const pipeline = new ConversionPipeline(
		createApp(vault) as never,
		client,
		() => ({ mineruApiToken: "t" }),
	);
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		NAME,
		{
			markdown: `# 标题\n\n![](images/p1_abc.jpg)\n\n![](images/p1_def.jpg)\n`,
			images: [
				{ relPath: "p1_abc.jpg", data: new Uint8Array([1]) },
				{ relPath: "p1_def.jpg", data: new Uint8Array([2]) },
			],
			extras: [],
		},
		{ ...OPTIONS, ...overrides },
	);
	return { vault, md: await vault.read(vault.getAbstractFileByPath(written.outputPath) as never) };
}

test("Markdown 链接模式下图片链接不被截断", async () => {
	const { vault, md } = await convert();
	const folder = assetFolderName(NAME);
	const link = md.split("\n").find((l) => l.includes("assets"))!;

	assert.equal(folder, "Analytical-Mechanics-of-Space-Systems-Aiaa-Education.assets");
	assert.ok(vault.entries.has(`MinerU转换/${folder}/p1_abc.jpg`), "图片应落在该目录");
	assert.equal(parsedUrl(link), `${folder}/p1_abc.jpg`, "Markdown 解析出的 URL 应完整");
	assert.ok(!/[ ()]/.test(parsedUrl(link)), "URL 中不能有空格或括号");
});

test("居中 HTML 模式下图片链接不被截断", async () => {
	const { md } = await convert({ convertImageToHtml: true, showImageFilename: true });
	const folder = assetFolderName(NAME);
	assert.ok(md.includes(`<img src="${folder}/p1_abc.jpg"`), md.slice(0, 200));
	assert.ok(md.includes("<strong>p1_abc.jpg</strong>"), "文件名应正确解码显示");
});

test("带空格的自定义图片目录会做百分号编码", async () => {
	const { md } = await convert({ imageFolder: "My Images" });
	const link = md.split("\n").find((l) => l.includes("assets") || l.includes("My"))!;
	assert.equal(parsedUrl(link), encodeLinkUrl("../My Images/p1_abc.jpg"));
	assert.ok(!parsedUrl(link).includes(" "), "空格必须编码为 %20");
});

test("合并分片后的图片链接同样可用", async () => {
	const vault = createVault();
	vault.seed(`${NAME}.pdf`, "x");
	const { client } = fakeClient();
	const pipeline = new ConversionPipeline(createApp(vault) as never, client, () => ({ mineruApiToken: "t" }));
	const written = await pipeline.writeResult(
		vault.getFiles()[0],
		NAME,
		{
			markdown: `分片1\n\n![](images/p1_a.jpg)\n\n<!-- MinerU 分片 81-160 页 -->\n\n分片2\n\n![](images/p2_b.jpg)\n`,
			images: [
				{ relPath: "p1_a.jpg", data: new Uint8Array([1]) },
				{ relPath: "p2_b.jpg", data: new Uint8Array([2]) },
			],
			extras: [],
		},
		OPTIONS,
	);
	const md = await vault.read(vault.getAbstractFileByPath(written.outputPath) as never);
	const folder = assetFolderName(NAME);
	for (const link of md.split("\n").filter((l) => l.includes("!["))) {
		const url = parsedUrl(link);
		assert.ok(url.startsWith(`${folder}/`), `链接应在同一 assets 目录：${link}`);
		assert.ok(vault.entries.has(`MinerU转换/${url}`), `磁盘上应存在 ${url}`);
	}
});