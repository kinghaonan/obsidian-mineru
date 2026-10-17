import { PART_MARKER_PREFIX } from "../constants";
import { rewriteImageLinks } from "../markdown";
import type { MergedPart } from "../types";

/** 分片合并结果：markdown + 合并后的图片列表（relPath 已加分片前缀） */
export interface MergeResult {
	markdown: string;
	images: { relPath: string; data: Uint8Array }[];
}

/**
 * 把多个分片的解析结果按顺序合并成一篇：
 * - 图片统一改名为 `p{分片号}_{原名}` 并重写链接，避免跨分片重名互相覆盖；
 * - 各分片之间插入 `<!-- MinerU 分片 x-y -->` 标记，便于回溯；
 * - 可选去掉后续分片重复的一级标题。
 */
export function mergeParts(
	parts: MergedPart[],
	options: { dedupeTitle: boolean; addMarkers?: boolean },
): MergeResult {
	const usable = parts.filter((p) => p && typeof p.markdown === "string");
	if (usable.length === 0) return { markdown: "", images: [] };
	if (usable.length === 1) {
		const only = usable[0];
		return {
			markdown: normalize(only.markdown),
			images: usable[0].images.map((img) => ({ ...img })),
		};
	}

	const firstTitle = options.dedupeTitle ? leadingHeading(usable[0].markdown) : null;
	const images: { relPath: string; data: Uint8Array }[] = [];
	const blocks: string[] = [];

	usable.forEach((part, i) => {
		const prefix = `p${i + 1}_`;
		const map = new Map<string, string>();
		for (const img of part.images) {
			const relPath = `${prefix}${sanitizeRelName(img.relPath)}`;
			map.set(img.relPath, `images/${relPath}`);
			map.set(`images/${img.relPath}`, `images/${relPath}`);
			images.push({ relPath, data: img.data });
		}

		let md = normalize(part.markdown);
		if (map.size > 0) md = rewriteImageLinks(md, map);
		if (i > 0 && options.dedupeTitle && firstTitle) md = stripLeadingHeading(md, firstTitle);
		if (options.addMarkers !== false) {
			blocks.push(`${PART_MARKER_PREFIX} ${part.start}-${part.end} 页 -->\n\n${md}`);
		} else {
			blocks.push(md);
		}
	});

	return { markdown: blocks.join("\n\n"), images };
}

/** 归一化：统一换行、去掉首尾空行 */
function normalize(markdown: string): string {
	return markdown.replace(/\r\n/g, "\n").trim();
}

/** 取首个一级标题（# 或 ##），没有则返回 null */
function leadingHeading(markdown: string): string | null {
	const match = markdown.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/m);
	return match ? match[2].trim() : null;
}

/** 若开头标题与 given 相同则移除 */
function stripLeadingHeading(markdown: string, given: string): string {
	const match = markdown.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*(?:\n|$)/);
	if (match && match[2].trim() === given) return markdown.slice(match[0].length).replace(/^\n+/, "");
	return markdown;
}

/** 图片文件名去前缀目录，避免 relPath 含 / 破坏输出路径 */
function sanitizeRelName(relPath: string): string {
	const name = relPath.split("/").pop() ?? relPath;
	return name.replace(/[\\/]/g, "_").trim() || "image";
}