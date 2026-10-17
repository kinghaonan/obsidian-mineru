import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCaptions, captionFileName, subLabelFileName } from "../src/mineru/captions";

const md = (lines: string[]) => lines.join("\n");

test("紧邻下一行的图注被识别", () => {
	const source = md([
		"![](images/a.jpg)",
		"Fig. 1.2 The cylindrical coordinate system.",
		"",
		"正文段落。",
	]);
	const result = analyzeCaptions(source);
	const caption = result.captions.get("images/a.jpg");
	assert.ok(caption);
	assert.equal(caption.number, "1.2");
	assert.equal(caption.text, "The cylindrical coordinate system.");
	assert.equal(caption.position, "below");
	assert.equal(source.split("\n")[caption.line], "Fig. 1.2 The cylindrical coordinate system.");
});

test("图注在图片上方也能识别", () => {
	const source = md(["Figure 3.1 Block diagram of the pipeline.", "![](images/b.jpg)", ""]);
	const caption = analyzeCaptions(source).captions.get("images/b.jpg");
	assert.ok(caption);
	assert.equal(caption.number, "3.1");
	assert.equal(caption.position, "above");
});

test("不带 images/ 前缀的链接同样识别", () => {
	const source = md(["![](a.jpg)", "Fig. 2.5 标题", ""]);
	assert.ok(analyzeCaptions(source).captions.has("a.jpg"));
});

test("HTML img 标签同样识别", () => {
	const source = md(['<img src="images/c.jpg" width="80%"/>', "Fig. 4.9 标题", ""]);
	assert.ok(analyzeCaptions(source).captions.has("images/c.jpg"));
});

test("真实 MinerU 子图排版：图片与标签之间隔空行", () => {
	// 取自真实转换结果（MinerU 输出）：标签在**后一张图之前**，且与前一张图之间有空行
	const source = md([
		"Note that any small departure from the pure spin case…",
		"",
		"![](images/p3_cf58.jpg)",
		"",
		"c) Maximum energy case",
		"![](images/p3_fba1.jpg)",
		"Fig. 4.9 Special cases of kinetic energy ellipsoid.",
		"",
		"As the kinetic energy is enlarged…",
		"",
	]);
	const result = analyzeCaptions(source);
	// 语义：整组图注挂在组内**第一张**图上；子标签归属其后那张图
	assert.ok(result.captions.has("images/p3_cf58.jpg"), "组内第一张持有图注");
	assert.ok(!result.captions.has("images/p3_fba1.jpg"), "子图不重复持有图注");
	assert.ok(
		result.subLabels.has("images/p3_fba1.jpg"),
		"标签在图之前 → 归属其后那张图；跨空行相连的图纳入同组",
	);
	assert.equal(result.subLabels.get("images/p3_fba1.jpg")?.number, "4.9");
	assert.equal(result.subLabels.get("images/p3_fba1.jpg")?.label, "c) Maximum energy case");
});

test("跨空行但无子标签相连时不纳入（避免误吞相邻图）", () => {
	const source = md([
		"![](images/a.jpg)",
		"",
		"![](images/b.jpg)",
		"Fig. 1.1 标题",
		"",
	]);
	const result = analyzeCaptions(source);
	assert.ok(result.captions.has("images/b.jpg"));
	assert.ok(!result.captions.has("images/a.jpg"), "无标签相连的图不应被归组");
	assert.equal(result.subLabels.size, 0);
});

test("子图组合：多图共用一个图注", () => {
	const source = md([
		"![](images/1.jpg)",
		"c) Maximum energy case",
		"![](images/2.jpg)",
		"Fig. 4.9 Special cases of kinetic energy ellipsoid.",
		"",
	]);
	const result = analyzeCaptions(source);
	assert.ok(result.captions.has("images/1.jpg"), "主图持有图注");
	assert.ok(!result.captions.has("images/2.jpg"), "子图不重复持有图注");
	assert.equal(result.subLabels.get("images/2.jpg")?.label, "c) Maximum energy case");
	assert.equal(result.subLabels.get("images/2.jpg")?.number, "4.9", "子图应继承所属图组的图号");
});

test("正文中的 Fig. 引用不会被误判为图注", () => {
	const source = md([
		"![](images/a.jpg)",
		"",
		"Fig. 3.2 shows the relationship between the two coordinate systems.",
		"",
	]);
	const result = analyzeCaptions(source);
	assert.equal(result.captions.size, 0, "隔空行的正文不应被当作图注");
	assert.equal(result.removableLines.size, 0, "不应删除任何行");
});

test("只有图号没有文字的行不算图注", () => {
	const source = md(["![](images/a.jpg)", "Fig. 1", ""]);
	assert.equal(analyzeCaptions(source).captions.size, 0);
});

test("超长行不算图注（防误判）", () => {
	const source = md(["![](images/a.jpg)", `Fig. 2.1 ${"很长的描述".repeat(40)}`, ""]);
	assert.equal(analyzeCaptions(source).captions.size, 0);
});

test("图注行记录在 removableLines 中便于删除原文", () => {
	const source = md(["![](images/a.jpg)", "Fig. 1.1 标题", "", "正文"]);
	const result = analyzeCaptions(source);
	assert.equal(result.removableLines.size, 1);
	assert.equal(result.removableLines.has(1), true);
});

test("无图注的图片不产生任何映射", () => {
	const source = md(["![](images/a.jpg)", "", "![](images/b.jpg)", "", "正文"]);
	const result = analyzeCaptions(source);
	assert.equal(result.captions.size, 0);
	assert.equal(result.subLabels.size, 0);
	assert.equal(result.removableLines.size, 0);
});

test("captionFileName 生成图号+标题的文件名", () => {
	assert.equal(captionFileName("1.2", "The cylindrical coordinate system."), "Fig.1.2-The-cylindrical-coordinate-system.jpg");
	assert.equal(captionFileName("P1.4", "Particle in rotating tube."), "Fig.P1.4-Particle-in-rotating-tube.jpg");
});

test("captionFileName 处理空文本与超长", () => {
	assert.equal(captionFileName("3.6", ""), "Fig.3.6.jpg");
	assert.equal(captionFileName("", "ignored"), "", "无图号时不改名");
	const long = captionFileName("1.2", "word ".repeat(80));
	assert.ok(long.length <= 84, `文件名过长：${long.length}`);
});

test("captionFileName 去除非法字符", () => {
	assert.equal(captionFileName("1.1", 'a/b:c*d?e "quoted"'), "Fig.1.1-abcde-quoted.jpg");
});

test("subLabelFileName 生成子图文件名", () => {
	assert.equal(subLabelFileName("4.9", "c) Maximum energy case", 1), "Fig.4.9-Maximum-energy-case.jpg");
	assert.equal(subLabelFileName("4.9", undefined, 1), "Fig.4.9-2.jpg");
});

test("subLabelFileName 限制超长子标签", () => {
	const name = subLabelFileName("4.9", `f) ${"很长的一句话说明 ".repeat(10)}`, 5);
	assert.ok(name.length <= 85, `文件名过长：${name.length}`);
	assert.ok(name.startsWith("Fig.4.9-"));
});

test("中文图注也能识别并命名", () => {
	const source = md(["![](images/a.jpg)", "图 1-2 圆柱坐标系", ""]);
	const caption = analyzeCaptions(source).captions.get("images/a.jpg");
	assert.ok(caption);
	assert.equal(caption.number, "1-2");
	assert.equal(captionFileName(caption.number, caption.text), "Fig.1-2-圆柱坐标系.jpg");
});