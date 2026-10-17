/**
 * 修复既有产物：把含空格括号的 .assets 目录改名，并同步修正 Markdown 里的链接。
 * 用法：node scripts/fix-assets-links.mjs "<md 文件路径>"
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { assetFolderName, encodeLinkUrl } from "../src/utils.ts";

const mdPath = process.argv[2];
if (!mdPath) {
	console.error("用法：node scripts/fix-assets-links.mjs <md 文件路径>");
	process.exit(1);
}
const mdDir = path.dirname(mdPath);
const base = path.basename(mdPath, ".md");
const oldDirName = `${base}.assets`;
const oldDir = path.join(mdDir, oldDirName);
const newDirName = assetFolderName(base);

const md = readFileSync(mdPath, "utf8");
const oldRef = `${oldDirName}/`;
const hits = md.split(oldRef).length - 1;

console.log(`md      : ${mdPath}`);
console.log(`旧目录  : ${oldDirName}${existsSync(oldDir) ? "" : "（不存在）"}`);
console.log(`新目录  : ${newDirName}`);
console.log(`引用数  : ${hits}`);

if (hits === 0) {
	console.log("无需修改（Markdown 中没有引用该目录）。");
	process.exit(0);
}

if (existsSync(oldDir) && oldDirName !== newDirName) {
	renameSync(oldDir, path.join(mdDir, newDirName));
	console.log(`已重命名目录 → ${newDirName}`);
}

const fixed = md.split(oldRef).join(`${encodeLinkUrl(newDirName)}/`);
writeFileSync(mdPath, fixed, "utf8");

const remaining = fixed.split(oldDirName).length - 1;
const links = [...fixed.matchAll(/!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)/g)].map((m) =>
	m[1].replace(/^<|>$/g, ""),
);
const broken = links.filter((l) => !existsSync(path.join(mdDir, decodeURIComponent(l))));
console.log(`剩余旧引用: ${remaining}`);
console.log(`图片链接数: ${links.length}，其中指向不存在文件的: ${broken.length}`);
if (broken.length > 0) console.log("示例:", broken.slice(0, 3).join(", "));