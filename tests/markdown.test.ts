import assert from "node:assert/strict";
import { test } from "node:test";
import { imagesToCenteredHtml, protectPlaceholders, rewriteImageLinks } from "../src/markdown";

test("protectPlaceholders 保护代码块/公式/行内码/图片", () => {
	const source = [
		"# 标题",
		"",
		"```js",
		"const a = 1;",
		"```",
		"",
		"公式 $$x^2 + y^2$$ 与行内 $a+b$ 还有 `code`。",
		"",
		"![图](images/a.jpg)",
	].join("\n");

	const { text, restore } = protectPlaceholders(source, { protectImages: true });
	assert.ok(!text.includes("const a = 1"), "代码块应被替换");
	assert.ok(!text.includes("$$"), "块级公式应被替换");
	assert.ok(!text.includes("images/a.jpg"), "图片链接应被替换");
	assert.match(text, /⟦MDC\d+⟧/);
	assert.equal(restore(text), source, "还原后应与原文完全一致");
});

test("protectPlaceholders 不保护图片时保留图片链接", () => {
	const source = "![图](images/a.jpg)";
	const { text, restore } = protectPlaceholders(source, { protectImages: false });
	assert.equal(text, source);
	assert.equal(restore(text), source);
});

test("protectPlaceholders 对未知占位符还原为空串", () => {
	const { restore } = protectPlaceholders("hello");
	assert.equal(restore("⟦MDC7⟧"), "");
});

test("rewriteImageLinks 支持 images/ 前缀回退（管线写入的映射表用法）", () => {
	// 管线会同时写入 "x.jpg" 与 "images/x.jpg" 两个键；此处只给带前缀的键验证回退
	const map = new Map([["images/a.jpg", "文稿.assets/a.jpg"]]);
	const md = "![甲](a.jpg)\n\n![乙](images/a.jpg)\n\n![丙](missing.png)";
	const out = rewriteImageLinks(md, map);
	assert.equal(out, "![甲](文稿.assets/a.jpg)\n\n![乙](文稿.assets/a.jpg)\n\n![丙](missing.png)");
});

test("rewriteImageLinks 同时命中无前缀与带前缀的键", () => {
	const map = new Map([
		["a.jpg", "文稿.assets/a.jpg"],
		["images/b.jpg", "文稿.assets/b.jpg"],
	]);
	const md = "![甲](a.jpg)\n\n![乙](images/b.jpg)";
	assert.equal(rewriteImageLinks(md, map), "![甲](文稿.assets/a.jpg)\n\n![乙](文稿.assets/b.jpg)");
});

test("rewriteImageLinks 不破坏代码块里的图片语法", () => {
	const map = new Map([["a.jpg", "x/a.jpg"]]);
	const md = "```\n![图](a.jpg)\n```\n\n![图](a.jpg)";
	const out = rewriteImageLinks(md, map);
	assert.ok(out.startsWith("```\n![图](a.jpg)\n```"), "代码块内应保持原样");
	assert.ok(out.endsWith("![图](x/a.jpg)"));
});

test("imagesToCenteredHtml 居中 + 宽度 + 加粗文件名", () => {
	const out = imagesToCenteredHtml("![a](文稿.assets/1.jpg)", 80, true);
	assert.equal(
		out,
		'<div style="text-align:center"><img src="文稿.assets/1.jpg" alt="a" width="80%"/><br/><strong>1.jpg</strong></div>',
	);
});

test("imagesToCenteredHtml 宽度被夹到 10~100", () => {
	assert.ok(imagesToCenteredHtml("![a](1.jpg)", 3, false).includes('width="10%"'));
	assert.ok(imagesToCenteredHtml("![a](1.jpg)", 480, false).includes('width="100%"'));
});

test("imagesToCenteredHtml 不显示文件名时省略 strong", () => {
	const out = imagesToCenteredHtml("![a](1.jpg)", 50, false);
	assert.equal(out, '<div style="text-align:center"><img src="1.jpg" alt="a" width="50%"/></div>');
});

test("rewriteImageLinks 识别带空格的 <...> 写法", () => {
	const map = new Map([["a b.jpg", "文稿.assets/a%20b.jpg"]]);
	const out = rewriteImageLinks("![x](<a b.jpg>)", map);
	assert.equal(out, "![x](文稿.assets/a%20b.jpg)");
});

test("rewriteImageLinks 未命中的链接原样保留", () => {
	const md = "![远程](https://example.com/a.png)\n\n![本地](images/zzz.jpg)";
	assert.equal(rewriteImageLinks(md, new Map([["images/q.jpg", "x.jpg"]])), md);
});

test("imagesToCenteredHtml 转义 alt 引号并解码文件名", () => {
	const out = imagesToCenteredHtml('![a"b](文稿.assets/x%20y&z.png)', 50, true);
	assert.ok(out.includes('alt="a&quot;b"'));
	assert.ok(out.includes("<strong>x y&amp;z.png</strong>"), `实际输出：${out}`);
});