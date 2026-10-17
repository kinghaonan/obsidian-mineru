import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText, splitInTwo } from "../src/translate/chunker";

test("chunkText 短文不分块", () => {
	assert.deepEqual(chunkText("a\n\nb", 1000), ["a\n\nb"]);
});

test("chunkText 纯空白返回空数组", () => {
	assert.deepEqual(chunkText("   \n\n  ", 100), []);
});

test("chunkText 按空行聚合成不超过上限的块", () => {
	const para = "x".repeat(40);
	const source = Array.from({ length: 20 }, () => para).join("\n\n");
	const chunks = chunkText(source, 100);
	assert.ok(chunks.length > 1, "应被拆成多块");
	for (const chunk of chunks) {
		assert.ok(chunk.length <= 100, `块长度超限：${chunk.length}`);
	}
	assert.equal(chunks.join("\n\n"), source, "拼接后应还原原文");
});

test("chunkText 超长段落按行二次拆分", () => {
	const line = "y".repeat(30);
	const source = Array.from({ length: 10 }, () => line).join("\n");
	const chunks = chunkText(source, 100);
	assert.ok(chunks.length >= 3);
	for (const chunk of chunks) assert.ok(chunk.length <= 100);
	assert.equal(chunks.join("\n"), source);
});

test("chunkText 单行超过上限时仍完整保留", () => {
	const source = "z".repeat(500);
	assert.deepEqual(chunkText(source, 100), [source]);
});

test("splitInTwo 按空行近似对半且不丢内容", () => {
	const para = "x".repeat(30);
	const source = Array.from({ length: 10 }, () => para).join("\n\n");
	const [head, tail] = splitInTwo(source);
	assert.ok(head.length > 0 && tail.length > 0);
	assert.equal(head + "\n\n" + tail, source);
	assert.ok(Math.abs(head.length - tail.length) < source.length / 2);
});

test("splitInTwo 无空行时整段作为前半段（原包既有行为）", () => {
	// 注意：原实现里 `if (!acc)` 分支在真实输入下不可达（首段总会先被赋给 acc），
	// 因此没有空行的文本会整体作为 head、tail 为空。这里锁定该行为以防无意改动。
	const source = ["a", "b", "c", "d"].join("\n");
	const [head, tail] = splitInTwo(source);
	assert.equal(head, source);
	assert.equal(tail, "");
});

test("splitInTwo 空字符串返回两个空串", () => {
	assert.deepEqual(splitInTwo(""), ["", ""]);
});