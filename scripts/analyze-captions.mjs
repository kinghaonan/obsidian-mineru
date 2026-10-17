/**
 * 图注（caption）可识别性摸底：扫描已转换的 Markdown，
 * 统计图片邻近文本里图注的存在率、位置分布与格式种类。
 *
 * 用法：node scripts/analyze-captions.mjs "<md 文件>"
 */
import { readFileSync } from "node:fs";

const mdPath = process.argv[2];
if (!mdPath) {
	console.error("用法：node scripts/analyze-captions.mjs <md 文件>");
	process.exit(1);
}
const md = readFileSync(mdPath, "utf8");
const lines = md.split(/\r?\n/);

// 图片位置：Markdown 链接与 <img> 两种形态
const IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)|<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;

/** 图注候选：Fig./Figure/图 + 编号，支持 1.2 / 1-2 / P1.4 / A1.2 等带前缀编号 */
const CAPTION_RE =
	/^\s*(?:\*\*|__)?\s*(fig(?:ure)?s?\.?|图表?|图片?|插图)\s*[\.:]?\s*([A-Za-z]?\d+(?:[.\-–]\d+)*)\s*(?:[\.\):：–—-]|、)?\s*(.*)$/i;

const isImageLine = (line) => IMAGE_RE.test(line) && (IMAGE_RE.lastIndex = 0);

let images = 0;
let withCaption = 0;
const formats = new Map();
const positionStats = { nextLine: 0, next2Lines: 0, prevLine: 0, none: 0 };
const noCaptionSamples = [];
const captionSamples = [];
const captionTexts = [];
/** 清洗成候选文件名后的名字，用于统计冲突 */
const candidateNames = new Map();

function toFileStem(text) {
	return text
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, "-")
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 60);
}

for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	IMAGE_RE.lastIndex = 0;
	if (!IMAGE_RE.test(line)) continue;
	images++;

	// 收集前后各 3 行的非图片、非空行
	const after = [];
	for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
		if (isImageLine(lines[k]) || !lines[k].trim()) break;
		after.push(lines[k]);
	}
	const before = [];
	for (let k = i - 1; k > Math.max(i - 4, -1); k--) {
		if (isImageLine(lines[k]) || !lines[k].trim()) break;
		before.unshift(lines[k]);
	}

	let hit = null;
	let hitPos = "none";
	for (const [idx, text] of after.entries()) {
		const m = text.match(CAPTION_RE);
		if (m) {
			hit = { text: text.trim(), prefix: m[1], number: m[2], rest: m[3] ?? "" };
			hitPos = idx === 0 ? "nextLine" : "next2Lines";
			break;
		}
	}
	if (!hit) {
		for (const text of before) {
			const m = text.match(CAPTION_RE);
			if (m) {
				hit = { text: text.trim(), prefix: m[1], number: m[2], rest: m[3] ?? "" };
				hitPos = "prevLine";
				break;
			}
		}
	}

	positionStats[hitPos]++;
	if (hit) {
		withCaption++;
		formats.set(hit.prefix.toLowerCase(), (formats.get(hit.prefix.toLowerCase()) ?? 0) + 1);
		captionTexts.push(hit.text);
		const stem = toFileStem(`fig${hit.number.toLowerCase()}`);
		candidateNames.set(stem, (candidateNames.get(stem) ?? 0) + 1);
		if (captionSamples.length < 12) captionSamples.push(`${hitPos}: ${hit.text.slice(0, 90)}`);
	} else if (noCaptionSamples.length < 10) {
		const ctx = [...before.slice(-1), ...after.slice(0, 2)].join(" ⏎ ").trim();
		noCaptionSamples.push(ctx.slice(0, 90) || "(图片前后均为空行)");
	}
}

const pct = (n) => ((n / Math.max(1, images)) * 100).toFixed(1);
const dupNames = [...candidateNames.entries()].filter(([, c]) => c > 1);

console.log(`文件          : ${mdPath}`);
console.log(`图片总数      : ${images}`);
console.log(`识别到图注    : ${withCaption}  (${pct(withCaption)}%)`);
console.log(`位置分布      : 紧邻下一行 ${positionStats.nextLine} / 下两行 ${positionStats.next2Lines} / 上一行 ${positionStats.prevLine} / 无 ${positionStats.none}`);
console.log(`前缀格式分布  :`);
for (const [k, v] of [...formats.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`   ${k.padEnd(10)} ${v}  (${pct(v)}%)`);
}
console.log(`清洗后重名    : ${dupNames.length} 组${dupNames.length ? " → " + dupNames.slice(0, 8).map(([k, c]) => `${k}×${c}`).join(", ") : ""}`);

console.log(`\n--- 图注样例 ---`);
for (const s of captionSamples) console.log("  " + s);

console.log(`\n--- 未识别到图注的上下文（前 10）---`);
for (const s of noCaptionSamples) console.log("  " + s);

console.log(`\n--- 识别到但可能有歧义的图注（编号重复/超长）---`);
const long = captionTexts.filter((t) => t.length > 120);
console.log(`  超长(>120字符): ${long.length}  示例: ${long[0]?.slice(0, 80) ?? "-"}`);