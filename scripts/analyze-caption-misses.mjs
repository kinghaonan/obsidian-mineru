/**
 * 评估「用图注给图片命名」的可实现性：检查剩余 25% 未识别图注的上下文，
 * 判断它们是真没有图注，还是图注被 MinerU 拆散/变形了。
 */
import { readFileSync } from "node:fs";

const mdPath = process.argv[2];
const md = readFileSync(mdPath, "utf8");
const lines = md.split(/\r?\n/);
const IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)|<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
const CAPTION_RE =
	/^\s*(?:\*\*|__)?\s*(fig(?:ure)?s?\.?|图表?|图片?|插图)\s*[\.:]?\s*([A-Za-z]?\d+(?:[.\-–]\d+)*)\s*(?:[\.\):：–—-]|、)?\s*(.*)$/i;

const isImage = (l) => {
	IMAGE_RE.lastIndex = 0;
	return IMAGE_RE.test(l);
};

let i = 0;
const misses = [];
for (let n = 0; n < lines.length; n++) {
	if (!isImage(lines[n])) continue;
	i++;
	const after = [];
	for (let k = n + 1; k < Math.min(n + 4, lines.length); k++) {
		if (isImage(lines[k]) || !lines[k].trim()) break;
		after.push(lines[k]);
	}
	if (after.some((t) => CAPTION_RE.test(t))) continue;
	misses.push({
		line: n + 1,
		before: lines[n - 1] ?? "",
		after: after[0] ?? "",
		distance: (() => {
			// 往后 8 行内还有没有 Fig.
			for (let k = n + 1; k < Math.min(n + 9, lines.length); k++) {
				if (CAPTION_RE.test(lines[k])) return k - n;
			}
			return -1;
		})(),
	});
}

console.log(`未识别到图注的图片: ${misses.length} / ${i}`);

const buckets = { "前后均空行": 0, "下一行有别的文字": 0, "2~8 行内能找到 Fig.": 0 };
for (const m of misses) {
	if (!m.before.trim() && !m.after.trim()) buckets["前后均空行"]++;
	else if (m.distance > 0) buckets["2~8 行内能找到 Fig."]++;
	else buckets["下一行有别的文字"]++;
}
console.log("\n未识别原因分布:");
for (const [k, v] of Object.entries(buckets)) console.log(`   ${k.padEnd(22)} ${v}`);

console.log("\n可挽救样例（2~8 行内能找到图注）:");
for (const m of misses.filter((x) => x.distance > 0).slice(0, 6)) {
	console.log(`   行${m.line} 间隔${m.distance}行 → "${m.after.slice(0, 60)}"`);
}

console.log("\n彻底无图注样例:");
for (const m of misses.filter((x) => x.distance <= 0).slice(0, 6)) {
	console.log(`   行${m.line} 前:"${m.before.slice(0, 45)}" 后:"${m.after.slice(0, 45)}"`);
}