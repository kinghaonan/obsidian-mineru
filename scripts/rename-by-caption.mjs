/**
 * 用图注重命名**已转换**产物里的图片，并同步更新 Markdown 链接。
 * 纯本地操作，不调用 MinerU API、不消耗额度。
 *
 * 适用于：升级旧版本转换出的、仍是哈希命名的图片。
 *
 * 用法：
 *   node --experimental-strip-types scripts/rename-by-caption.mjs "<md 文件>" [--dry]
 *   --dry 只预览，不改动任何文件
 */
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import path from "node:path";
import { analyzeCaptions, captionFileName, subLabelFileName } from "../src/mineru/captions.ts";

/** 链接目标转义（与 src/utils.ts#encodeLinkUrl 保持一致） */
const LINK_ESCAPES = {
	"%": "%25", " ": "%20", "(": "%28", ")": "%29", "<": "%3C", ">": "%3E",
	'"': "%22", "'": "%27", "`": "%60", "[": "%5B", "]": "%5D", "{": "%7B",
	"}": "%7D", "|": "%7C", "^": "%5E", "#": "%23", "?": "%3F", "&": "%26",
};
const encodeLinkUrl = (p) => [...p].map((c) => LINK_ESCAPES[c] ?? c).join("");

const mdPath = process.argv[2];
const dryRun = process.argv.includes("--dry");
if (!mdPath) {
	console.error("用法：node --experimental-strip-types scripts/rename-by-caption.mjs <md 文件> [--dry]");
	process.exit(1);
}
if (!existsSync(mdPath)) {
	console.error(`找不到文件：${mdPath}`);
	process.exit(1);
}

const mdDir = path.dirname(mdPath);
const md = readFileSync(mdPath, "utf8");
const analysis = analyzeCaptions(md);

/** 旧文件名 → 新文件名 */
const plan = new Map();
const used = new Set();

function claim(stem) {
	if (!used.has(stem)) {
		used.add(stem);
		return `${stem}.jpg`;
	}
	let n = 2;
	while (used.has(`${stem}-${n}`)) n++;
	const name = `${stem}-${n}.jpg`;
	used.add(name);
	return name;
}

// 子图先占短名，主图拿到完整名
for (const [url, sub] of analysis.subLabels) {
	plan.set(basename(url), claim(subLabelFileName(sub.number, sub.label, 0).replace(/\.jpg$/, "")));
}
for (const [url, caption] of analysis.captions) {
	const fileName = captionFileName(caption.number, caption.text);
	if (fileName) plan.set(basename(url), claim(fileName.replace(/\.jpg$/, "")));
}

// 同目录已有文件：避免新名与现存文件冲突（且不是自己）
const existing = new Set(existsSync(mdDir) ? readdirSync(mdDir) : []);
const sourceNames = new Set(plan.keys());
for (const oldName of sourceNames) existing.delete(oldName);

/** 替换 URL 末段文件名，返回新 URL */
function rewriteUrl(url) {
	const dir = url.slice(0, url.lastIndexOf("/") + 1);
	const file = basename(url);
	const next = plan.get(file);
	if (!next) return undefined;
	return encodeLinkUrl(dir + next);
}

const IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<[^>\n]*>|[^\s)]+)|<img\b[^>]*?\bsrc="[^"]+"/gi;
const URL_IN_MD = /(!\[[^\]]*\]\(\s*(?:<|>)?)([^)\s>]*)(>?\s*\))|(<img\b[^>]*?\bsrc=")([^"]+)("[^>]*>)/gi;

let renamed = 0;
let skipped = 0;
let missing = 0;
const details = [];

function applyRename(url) {
	const plain = url.replace(/^<|>$/g, "");
	let decoded = plain;
	try {
		decoded = decodeURIComponent(plain);
	} catch {
		/* 保留原样 */
	}
	const next = rewriteUrl(decoded);
	if (!next) return undefined;

	const abs = path.resolve(mdDir, decoded);
	const newAbs = path.resolve(mdDir, decodeURIComponent(next));
	if (!existsSync(abs)) {
		missing++;
		return undefined;
	}
	const newFileName = path.basename(newAbs);
	if (abs !== newAbs && existing.has(newFileName)) {
		skipped++;
		details.push(`跳过（目标已存在）: ${path.basename(decoded)} → ${newFileName}`);
		return undefined;
	}
	if (!dryRun) renameSync(abs, newAbs);
	renamed++;
	details.push(`${path.basename(decoded)} → ${newFileName}`);
	return next;
}

const nextMd = md.replace(URL_IN_MD, (whole, mdHead, mdUrl, mdTail, imgHead, imgUrl, imgTail) => {
	if (mdUrl !== undefined) {
		const next = applyRename(mdUrl);
		return next ? `${mdHead}${next}${mdTail}` : whole;
	}
	const next = applyRename(imgUrl);
	return next ? `${imgHead}${next}${imgTail}` : whole;
});

void IMAGE_RE;

if (!dryRun && renamed > 0) writeFileSync(mdPath, nextMd, "utf8");

console.log(`文件        : ${mdPath}${dryRun ? "   [试运行，未改动任何文件]" : ""}`);
console.log(`识别到图注  : ${analysis.captions.size}   子图: ${analysis.subLabels.size}`);
console.log(`计划重命名  : ${plan.size}`);
console.log(`实际重命名  : ${renamed}`);
if (skipped) console.log(`跳过        : ${skipped}（目标文件已存在）`);
if (missing) console.log(`找不到源文件: ${missing}（链接与磁盘不一致，可先跑 fix-assets-links.mjs）`);
console.log(`\n明细（前 15 条）:`);
for (const d of details.slice(0, 15)) console.log(`  ${d}`);
if (details.length > 15) console.log(`  …共 ${details.length} 条`);

function basename(url) {
	return url.split("/").pop() ?? url;
}