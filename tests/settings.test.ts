import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings } from "../src/settings";
import { errorMessageFor } from "../src/mineru/errors";
import { ERROR_MESSAGES, stateLabel } from "../src/constants";

test("mergeSettings 非对象回落到默认值", () => {
	for (const input of [null, undefined, 42, "x", []]) {
		assert.deepEqual(mergeSettings(input), DEFAULT_SETTINGS);
	}
});

test("mergeSettings 覆盖已存字段、忽略未知字段", () => {
	const merged = mergeSettings({ outputFolder: "文献", unknownField: 1, chunkSizeChars: null });
	assert.equal(merged.outputFolder, "文献");
	assert.equal(merged.chunkSizeChars, DEFAULT_SETTINGS.chunkSizeChars, "null 应回落默认");
	assert.ok(!("unknownField" in merged), "未知字段应被丢弃");
});

test("mergeSettings 不会污染默认对象", () => {
	const merged = mergeSettings({ extraFormats: ["docx"] });
	merged.extraFormats.push("html");
	assert.deepEqual(DEFAULT_SETTINGS.extraFormats, [], "DEFAULT_SETTINGS 不应被测试污染");
});

test("mergeSettings 保留数组类型字段", () => {
	const merged = mergeSettings({ extraFormats: ["latex"] }) as PluginSettings;
	assert.deepEqual(merged.extraFormats, ["latex"]);
});

test("errorMessageFor 命中错误码表", () => {
	assert.equal(errorMessageFor("A0202"), ERROR_MESSAGES.A0202);
	assert.equal(errorMessageFor(-60005), ERROR_MESSAGES["-60005"]);
});

test("errorMessageFor 未知码给出通用文案", () => {
	assert.equal(errorMessageFor("12345"), "API 错误（12345）");
	assert.equal(errorMessageFor(undefined as unknown as string), "API 错误（undefined）");
});

test("stateLabel 覆盖批次状态并回落原值", () => {
	assert.equal(stateLabel("pending"), "排队中");
	assert.equal(stateLabel("running"), "解析中");
	assert.equal(stateLabel("converting"), "格式转换");
	assert.equal(stateLabel("waiting-file"), "等待上传");
	assert.equal(stateLabel("done"), "完成");
	assert.equal(stateLabel("failed"), "失败");
	assert.equal(stateLabel("brand-new"), "brand-new");
});