import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
	asciiSlug,
	assetFolderName,
	encodeLinkUrl,
	ensureFolderLevels,
	extractZip,
	isConvertiblePath,
	relativePath,
	sanitizeFileName,
	toArrayBuffer,
} from "../src/utils";
import { createVault } from "./helpers/vault";

/** JSZip 产出的是 Uint8Array，统一转成 extractZip 需要的 ArrayBuffer */
async function zipBuffer(zip: JSZip): Promise<ArrayBuffer> {
	return toArrayBuffer(await zip.generateAsync({ type: "uint8array" }));
}

test("isConvertiblePath 只认支持的扩展名（大小写不敏感）", () => {
	assert.equal(isConvertiblePath("笔记/a.PDF"), true);
	assert.equal(isConvertiblePath("a.docx"), true);
	assert.equal(isConvertiblePath("a.jpeg"), true);
	assert.equal(isConvertiblePath("a.md"), false);
	assert.equal(isConvertiblePath("无扩展名"), false);
});

test("sanitizeFileName 清理非法字符并限长", () => {
	assert.equal(sanitizeFileName('a/b:c*d?'), "abcd");
	assert.equal(sanitizeFileName("  多   空格  "), "多 空格");
	assert.equal(sanitizeFileName(""), "untitled");
	assert.equal(sanitizeFileName("   "), "untitled");
	assert.equal(sanitizeFileName("n".repeat(200)).length, 120);
});

test("asciiSlug 非 ASCII 转 - 并限长", () => {
	assert.equal(asciiSlug("报告 2024.pdf"), "---2024.pdf");
	assert.equal(asciiSlug("ok_name-1.2"), "ok_name-1.2");
	assert.equal(asciiSlug("中文"), "--", "两个非 ASCII 字符 → 两个 -");
	assert.equal(asciiSlug("n".repeat(300)).length, 128);
});

test("relativePath 计算库内相对路径", () => {
	assert.equal(relativePath("out", "out/sub/a.png"), "sub/a.png");
	assert.equal(relativePath("a/b", "c/d.png"), "../../c/d.png");
	assert.equal(relativePath("x", "x"), ".");
	assert.equal(relativePath("MinerU转换/文稿.assets", "MinerU转换/a.png"), "../a.png");
});

test("assetFolderName 剔除会让链接截断的字符", () => {
	// 真实案例：Analytical Mechanics of Space Systems (Aiaa Education)
	assert.equal(
		assetFolderName("Analytical Mechanics of Space Systems (Aiaa Education)"),
		"Analytical-Mechanics-of-Space-Systems-Aiaa-Education.assets",
	);
	assert.equal(assetFolderName("报告"), "报告.assets");
	assert.equal(assetFolderName("a/b:c"), "abc.assets");
	assert.equal(assetFolderName("   "), "assets");
	assert.equal(assetFolderName("(x)"), "x.assets");
});

test("assetFolderName 限制长度", () => {
	const name = assetFolderName("n".repeat(200));
	assert.equal(name.length, ".assets".length + 60);
	assert.ok(!name.includes(" "));
});

test("encodeLinkUrl 转义会破坏链接的字符", () => {
	assert.equal(
		encodeLinkUrl("Analytical Mechanics (Aiaa).assets/1.jpg"),
		"Analytical%20Mechanics%20%28Aiaa%29.assets/1.jpg",
	);
	assert.equal(encodeLinkUrl("图/1.jpg"), "图/1.jpg", "中文与斜杠保持原样");
	assert.equal(encodeLinkUrl("a%b"), "a%25b", "百分号自身需转义");
	assert.equal(encodeLinkUrl('a"b#c?d'), "a%22b%23c%3Fd");
});

test("toArrayBuffer 返回独立缓冲", () => {
	const source = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);
	const buf = toArrayBuffer(source);
	assert.equal(buf.byteLength, 3);
	assert.deepEqual([...new Uint8Array(buf)], [2, 3, 4]);
});

test("ensureFolderLevels 逐级创建文件夹", async () => {
	const vault = createVault();
	await ensureFolderLevels(vault as never, "a/b/c");
	assert.deepEqual(vault.createdFolders, ["a", "a/b", "a/b/c"]);
});

test("extractZip 优先取 full.md 并收集 images/", async () => {
	const zip = new JSZip();
	zip.file("文稿/full.md", "# 标题\n\n正文");
	zip.file("文稿/content_list.json", "[]");
	zip.file("文稿/layout.pdf", "x");
	zip.file("文稿/images/1.jpg", new Uint8Array([1, 2]));
	zip.file("文稿/images/sub/2.jpg", new Uint8Array([3]));
	const contents = await extractZip(await zipBuffer(zip), []);

	assert.equal(contents.markdown, "# 标题\n\n正文");
	assert.deepEqual(
		contents.images.map((i) => i.relPath),
		["1.jpg", "sub/2.jpg"],
	);
	assert.deepEqual([...contents.images[0].data], [1, 2]);
	assert.equal(contents.extras.length, 0);
});

test("extractZip 没有 full.md 时取最长的 md", async () => {
	const zip = new JSZip();
	zip.file("out/a.md", "短");
	zip.file("out/b.md", "明显更长的内容");
	const contents = await extractZip(await zipBuffer(zip), []);
	assert.equal(contents.markdown, "明显更长的内容");
});

test("extractZip 按请求收集附加格式（仅顶层文件）", async () => {
	const zip = new JSZip();
	zip.file("d/full.md", "正文");
	zip.file("d/文稿.docx", "docx-bytes");
	zip.file("d/文稿.html", "<html></html>");
	zip.file("d/文稿.tex", "\\documentclass");
	zip.file("d/notes/其他.docx", "不应被收集");
	const contents = await extractZip(await zipBuffer(zip), ["docx", "html", "latex"]);
	assert.deepEqual(
		contents.extras.map((e) => `${e.format}:${e.fileName}`),
		["docx:文稿.docx", "html:文稿.html", "latex:文稿.tex"],
	);
});

test("extractZip 找不到 md 时抛错", async () => {
	const zip = new JSZip();
	zip.file("d/a.txt", "x");
	const buffer = await zipBuffer(zip);
	await assert.rejects(() => extractZip(buffer, []), /未找到 Markdown/);
});