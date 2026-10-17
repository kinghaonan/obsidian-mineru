import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { countPdfPages, needsSplit, planPageRanges, splitPdf } from "../src/mineru/split";
import { mergeParts } from "../src/mineru/merge";

/** 生成指定页数的空白 PDF */
async function makePdf(pages: number): Promise<ArrayBuffer> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
	const bytes = await doc.save();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test("planPageRanges 页数不足时返回单区间", () => {
	assert.deepEqual(planPageRanges(10, 80), [{ index: 1, start: 1, end: 10 }]);
	assert.deepEqual(planPageRanges(0, 80), []);
});

test("planPageRanges 均分且完整覆盖", () => {
	// 10 页按上限 4 切：分片数向上取整为 3，每片 4/4/2 页，均不超过上限
	assert.deepEqual(planPageRanges(10, 4), [
		{ index: 1, start: 1, end: 4 },
		{ index: 2, start: 5, end: 8 },
		{ index: 3, start: 9, end: 10 },
	]);
	const ranges = planPageRanges(201, 50);
	assert.equal(ranges.length, 5);
	assert.equal(ranges[0].start, 1);
	assert.equal(ranges[ranges.length - 1].end, 201);
	for (const range of ranges) assert.ok(range.end - range.start + 1 <= 50, "单片不得超过上限");
	for (let i = 1; i < ranges.length; i++) {
		assert.equal(ranges[i].start, ranges[i - 1].end + 1, "区间应连续无重叠");
	}
});

test("needsSplit 受开关、页数与体积控制", () => {
	const base = { enabled: true, maxPages: 80, maxSizeMB: 100, dedupeTitle: true };
	assert.equal(needsSplit(50, 1024, base), false);
	assert.equal(needsSplit(100, 1024, base), true, "页数超限");
	assert.equal(needsSplit(10, 150 * 1024 * 1024, base), true, "体积超限");
	assert.equal(needsSplit(100, 1024, { ...base, enabled: false }), false, "关闭开关不切分");
});

test("countPdfPages 读取页数，非 PDF 返回 0", async () => {
	assert.equal(await countPdfPages(await makePdf(7)), 7);
	assert.equal(await countPdfPages(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer), 0);
});

test("splitPdf 真正切开 PDF 并可读回页数", async () => {
	const source = await makePdf(10);
	const chunks = await splitPdf(source, 4);
	assert.equal(chunks.length, 3);
	let total = 0;
	for (const chunk of chunks) total += await countPdfPages(chunk.data);
	assert.equal(total, 10, "切分后总页数应保持不变");
	assert.deepEqual(
		chunks.map((c) => [c.start, c.end]),
		[
			[1, 4],
			[5, 8],
			[9, 10],
		],
	);
});

test("splitPdf 未超页数时返回空数组", async () => {
	assert.deepEqual(await splitPdf(await makePdf(3), 10), []);
});

test("mergeParts 合并分片、重命名图片并插入标记", () => {
	const merged = mergeParts(
		[
			{ markdown: "# 标题\n\n第一部分 ![图1](images/1.jpg)", images: [{ relPath: "1.jpg", data: new Uint8Array([1]) }], start: 1, end: 80 },
			{ markdown: "第二部分 ![图2](images/1.jpg)", images: [{ relPath: "1.jpg", data: new Uint8Array([2]) }], start: 81, end: 160 },
		],
		{ dedupeTitle: true },
	);

	assert.deepEqual(
		merged.images.map((i) => i.relPath),
		["p1_1.jpg", "p2_1.jpg"],
		"跨分片同名图片应加前缀",
	);
	assert.ok(merged.markdown.includes("<!-- MinerU 分片 1-80 页 -->"));
	assert.ok(merged.markdown.includes("<!-- MinerU 分片 81-160 页 -->"));
	assert.ok(merged.markdown.includes("![图1](images/p1_1.jpg)"));
	assert.ok(merged.markdown.includes("![图2](images/p2_1.jpg)"));
});

test("mergeParts 去掉后续分片重复的标题", () => {
	const merged = mergeParts(
		[
			{ markdown: "# 标题\n\n甲", images: [], start: 1, end: 5 },
			{ markdown: "# 标题\n\n乙", images: [], start: 6, end: 10 },
		],
		{ dedupeTitle: true },
	);
	assert.equal((merged.markdown.match(/^# 标题$/gm) ?? []).length, 1);
	assert.ok(merged.markdown.includes("甲") && merged.markdown.includes("乙"));
});

test("mergeParts 关闭去重时保留各分片标题", () => {
	const merged = mergeParts(
		[
			{ markdown: "# 标题\n\n甲", images: [], start: 1, end: 5 },
			{ markdown: "# 标题\n\n乙", images: [], start: 6, end: 10 },
		],
		{ dedupeTitle: false },
	);
	assert.equal((merged.markdown.match(/^# 标题$/gm) ?? []).length, 2);
});

test("mergeParts 单分片与空输入", () => {
	const single = mergeParts([{ markdown: "只有一段\r\n", images: [], start: 1, end: 3 }], { dedupeTitle: true });
	assert.equal(single.markdown, "只有一段");
	assert.deepEqual(mergeParts([], { dedupeTitle: true }), { markdown: "", images: [] });
});

test("mergeParts 可关闭分片标记", () => {
	const merged = mergeParts(
		[
			{ markdown: "甲", images: [], start: 1, end: 5 },
			{ markdown: "乙", images: [], start: 6, end: 10 },
		],
		{ dedupeTitle: true, addMarkers: false },
	);
	assert.ok(!merged.markdown.includes("MinerU 分片"));
});