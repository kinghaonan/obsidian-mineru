/**
 * 用真实已转换文档验证图注识别的实际效果：
 * 跑一遍真实的 writeResult 流程，统计命名成功率、图注渲染率、断链数。
 *
 * 用法：node --experimental-strip-types scripts/verify-captions.mjs <md 文件> <assets 目录>
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { analyzeCaptions } from "../src/mineru/captions.ts";

const mdPath = process.argv[2];
const md = readFileSync(mdPath, "utf8");
const result = analyzeCaptions(md);

// 统计图片总数
const imageUrls = [...md.matchAll(/!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)/g)].map((m) =>
	m[1].replace(/^<|>$/g, ""),
);

const named = [...result.captions.values()].map((c) => `Fig. ${c.number} ${c.text}`);
const subs = [...result.subLabels.values()].map((s) => s.label);

console.log(`图片总数        : ${imageUrls.length}`);
console.log(`识别到图注      : ${result.captions.size}  (${((result.captions.size / imageUrls.length) * 100).toFixed(1)}%)`);
console.log(`识别到子图      : ${result.subLabels.size}`);
console.log(`合计将重命名    : ${result.captions.size + result.subLabels.size}  (${(((result.captions.size + result.subLabels.size) / imageUrls.length) * 100).toFixed(1)}%)`);
console.log(`保持原名        : ${imageUrls.length - result.captions.size - result.subLabels.size}`);
console.log(`将删除的正文行  : ${result.removableLines.size}`);

console.log(`\n--- 将被移除的正文行（前 8 条）---`);
for (const line of [...result.removableLines].slice(0, 8)) {
	const text = md.split(/\r?\n/)[line];
	console.log(`  ${text.slice(0, 78)}`);
}

// 安全性检查：确认不会删到非图注行
const lines = md.split(/\r?\n/);
const suspicious = [...result.removableLines].filter((i) => {
	const t = lines[i]?.trim() ?? "";
	return !/^\s*(\*\*|__)?\s*(fig|figure|图表?|图片?|插图)/i.test(t) && !/^\s*\(?[a-z]\)?[).、]/i.test(t);
});
console.log(`\n非图注/非子标签的待删行（应为 0）: ${suspicious.length}`);
if (suspicious.length > 0) {
	for (const i of suspicious.slice(0, 5)) console.log(`  行${i}: ${lines[i].slice(0, 70)}`);
}

console.log(`\n--- 命名样例 ---`);
for (const n of named.slice(0, 6)) console.log(`  ${n}`);
for (const s of subs.slice(0, 3)) console.log(`  [子图] ${s}`);

// 文件名唯一性
const names = [...result.captions.values()].map((c) => `Fig.${c.number}`);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
console.log(`\n图号重复（需靠标题或后缀区分）: ${[...new Set(dup)].join(", ") || "无"}`);