#!/usr/bin/env node
/**
 * 一致性校验：确认当前 src/ 打包产物 main.js 与原始产物 main.js.orig
 * 在"用户可见行为"层面保持一致。
 *
 * 校验两类内容：
 *   1) 全部中文字符串（UI 文案、提示、错误码说明、系统提示词…）
 *   2) 关键字面量（API 端点、URL、CSS 类名、状态/字段名、请求头）
 *
 * 用法：
 *   node scripts/check-parity.mjs            # 对比 main.js.orig 与 main.js
 *   node scripts/check-parity.mjs --strict   # 存在差异即退出码 1
 *
 * 说明：main.js.orig 是复刻参照物，已被 .gitignore 排除；
 *      文件不存在时脚本会提示并以 0 退出，保证 CI/新克隆仓库可用。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIG = path.join(root, "main.js.orig");
const NEW = path.join(root, "main.js");
const strict = process.argv.includes("--strict");

/** 反转义 \uXXXX，便于直接比对中文字面量 */
const decode = (file) =>
	readFileSync(file, "utf8").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

if (!existsSync(ORIG)) {
	console.log("ℹ 未找到 main.js.orig（原始打包产物，仅作复刻参照），跳过一致性校验。");
	process.exit(0);
}
if (!existsSync(NEW)) {
	console.error("✗ 未找到 main.js，请先执行 npm run build");
	process.exit(1);
}

const origText = decode(ORIG);
const newText = decode(NEW);

/** 抽取中文文案字面量（跳过明显是代码片段的） */
function cjkStrings(text) {
	const out = new Set();
	const re = /"([^"\n]{2,200})"/g;
	let m;
	while ((m = re.exec(text))) {
		const v = m[1];
		if (!/[\u4e00-\u9fff]/.test(v)) continue;
		// 模板字符串片段会因引号配对错位被误识别，这里排除含插值/代码痕迹的候选
		if (/\$\{|`|=>|\bvar\b|\bfunction\b|require\(|;\w+=/.test(v)) continue;
		out.add(v.trim());
	}
	return out;
}

const origCjk = cjkStrings(origText);
const newCjk = cjkStrings(newText);

/** 关键标识符字面量：必须逐字出现在新产物中 */
const CRITICAL = [
	// 端点与地址
	"https://mineru.net/api/v4",
	"/file-urls/batch",
	"/extract-results/batch/",
	"__token_probe__",
	"https://api.anthropic.com/v1/messages",
	"/chat/completions",
	"anthropic-version",
	"x-api-key",
	"Content-Type",
	"application/json",
	"Bearer ",
	// 请求字段
	"model_version",
	"is_ocr",
	"enable_formula",
	"enable_table",
	"extra_formats",
	"batch_id",
	"file_urls",
	"file_name",
	"full_zip_url",
	"err_code",
	"err_msg",
	"extract_result",
	"max_tokens",
	"finish_reason",
	"max_tokens",
	"stop_reason",
	// 状态与错误码
	"CANCELLED",
	"TIMEOUT",
	"A0202",
	"waiting-file",
	"converting",
	// 样式类名
	"mineru-wizard",
	"mineru-progress-list",
	"mineru-progress-row",
	"mineru-progress-name",
	"mineru-progress-state",
	"mineru-progress-detail",
	"mineru-running",
	"mineru-done",
	"mineru-failed",
	"mineru-translating",
	// 菜单 / 命令
	"open-conversion-wizard",
	"convert-active-file",
	"translate-current-note",
	"file-menu",
	// 设置字段
	"mineruApiToken",
	"imageWidthPercent",
	"showQuickConvertButton",
	"showQuickTranslateButton",
	"translationOutputFolder",
	"translateFrontmatterTitle",
	"collisionPolicy",
	"chunkSizeChars",
	"maxOutputTokens",
	// 占位符协议
	"⟦MDC",
];

const missingCjk = [...origCjk].filter((s) => !newText.includes(s));
const missingCritical = CRITICAL.filter((s) => !newText.includes(s));

console.log(`原始产物中文字面量：${origCjk.size} 项`);
console.log(`当前产物中文字面量：${newCjk.size} 项`);
console.log(`关键标识符校验项：${CRITICAL.length} 项`);

let failed = false;

if (missingCjk.length > 0) {
	failed = true;
	console.log(`\n✗ 原包存在但当前产物缺失的中文文案（${missingCjk.length}）：`);
	for (const s of missingCjk) console.log(`   ${JSON.stringify(s)}`);
}

if (missingCritical.length > 0) {
	failed = true;
	console.log(`\n✗ 缺失的关键标识符（${missingCritical.length}）：`);
	for (const s of missingCritical) console.log(`   ${JSON.stringify(s)}`);
}

const added = [...newCjk].filter((s) => !origText.includes(s));
if (added.length > 0) {
	console.log(`\n${strict ? "✗" : "ℹ"} 当前产物新增的中文文案（${added.length}${strict ? "，--strict 模式下视为失败" : "，复刻允许的增量"}）：`);
	for (const s of added) console.log(`   ${JSON.stringify(s)}`);
}

if (failed || (strict && added.length > 0)) {
	console.log("\n结论：与原始产物存在差异，请复核后重试。");
	process.exit(1);
}

console.log("\n✅ 与原始产物一致：所有原包中文字面量与关键标识符均已覆盖。");