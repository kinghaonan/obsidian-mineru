import JSZip from "jszip";
import { normalizePath } from "obsidian";
import { SUPPORTED_EXTENSIONS } from "./constants";
import type { ZipContents } from "./types";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断库内路径是否为支持转换的文件 */
export function isConvertiblePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	const ext = path.slice(dot + 1).toLowerCase();
	return SUPPORTED_EXTENSIONS.has(ext);
}

/** 净化文件名：去非法字符、压缩空白、限 120 字符 */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return cleaned.length > 0 ? cleaned : "untitled";
}

/** 生成 ASCII 化的 data_id 前缀 */
export function asciiSlug(name: string): string {
	const slug = name
		.split("")
		.map((ch) => (ch.match(/[A-Za-z0-9_.-]/) ? ch : "-"))
		.join("")
		.slice(0, 128);
	return slug.length > 0 ? slug : "document";
}

/**
 * 生成可安全写进 Markdown 链接的图片目录名。
 * 文档名常含空格与括号（如 "Analytical Mechanics (AIAA)"），
 * 直接拼进 `![](路径)` 会让链接在第一个空格处截断，因此：
 * 空格 → 连字符，剔除括号等链接敏感字符，并限制长度。
 */
export function assetFolderName(basename: string): string {
	const cleaned = basename
		// 文件系统非法字符
		.replace(/[<>:"/\\|?*]/g, "")
		// Markdown/HTML 链接里会导致截断或解析异常的字符
		.replace(/[()[\]{}'!^`]/g, "")
		// 空白统一换成连字符（链接里必须转义，不如直接换掉）
		.replace(/\s+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 60)
		.trim();
	return cleaned.length > 0 ? `${cleaned}.assets` : "assets";
}

/** 链接目标里必须转义的字符 → 百分号编码 */
const LINK_ESCAPES: Record<string, string> = {
	"%": "%25",
	" ": "%20",
	"(": "%28",
	")": "%29",
	"<": "%3C",
	">": "%3E",
	'"': "%22",
	"'": "%27",
	"`": "%60",
	"[": "%5B",
	"]": "%5D",
	"{": "%7B",
	"}": "%7D",
	"|": "%7C",
	"^": "%5E",
	"#": "%23",
	"?": "%3F",
	"&": "%26",
};

/** 对写进 Markdown/HTML 的链接目标做百分号编码（中文等非 ASCII 保持原样） */
export function encodeLinkUrl(path: string): string {
	let out = "";
	for (const ch of path) out += LINK_ESCAPES[ch] ?? ch;
	return out;
}

/** 从 typed array 拷贝出独立的 ArrayBuffer（createBinary 需要） */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** 计算库内两个路径之间的相对路径（用于改写 Markdown 图片链接） */
export function relativePath(from: string, to: string): string {
	const a = from.split("/").filter((v) => v.length > 0 && v !== ".");
	const b = to.split("/").filter((v) => v.length > 0 && v !== ".");
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const ups = new Array(a.length - i).fill("..");
	const rest = b.slice(i);
	const joined = ups.concat(rest).join("/");
	return joined.length > 0 ? joined : ".";
}

/**
 * 解压 MinerU 结果 zip：
 * - Markdown 取 full.md，否则取最长的 .md
 * - 收集 Markdown 同目录下 images/ 内的图片
 * - 按附加格式收集 .tex/.latex/.docx/.html
 */
export async function extractZip(buffer: ArrayBuffer, extraFormats: string[]): Promise<ZipContents> {
	const zip = await JSZip.loadAsync(buffer);
	const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir);

	let mdPath: string | null = null;
	let markdown = "";
	const mdEntries = entries.filter((p) => p.toLowerCase().endsWith(".md"));
	const fullMd = mdEntries.find(
		(p) => p.toLowerCase() === "full.md" || p.toLowerCase().endsWith("/full.md"),
	);
	if (fullMd) {
		mdPath = fullMd;
		markdown = await zip.files[fullMd].async("string");
	} else if (mdEntries.length > 0) {
		let longest = "";
		for (const p of mdEntries) {
			const text = await zip.files[p].async("string");
			if (text.length > longest.length) {
				longest = text;
				mdPath = p;
			}
		}
		markdown = longest;
	}
	if (!mdPath) throw new Error("结果包中未找到 Markdown 文件");

	const dir = mdPath.includes("/") ? mdPath.slice(0, mdPath.lastIndexOf("/")) : "";
	const prefix = dir ? dir + "/" : "";

	const images: ZipContents["images"] = [];
	for (const p of entries) {
		const entry = zip.files[p];
		if (!entry.dir && p.startsWith(prefix + "images/")) {
			const relPath = p.slice(prefix.length + 7);
			const data = await entry.async("uint8array");
			images.push({ relPath, data });
		}
	}

	const extras: ZipContents["extras"] = [];
	for (const format of extraFormats) {
		if (format === "latex") {
			for (const p of entries) {
				const rel = p.slice(prefix.length);
				if (/\.(tex|latex)$/i.test(rel) && !rel.includes("/")) {
					const data = await zip.files[p].async("uint8array");
					extras.push({ format, fileName: rel, data });
				}
			}
		} else if (format === "docx" || format === "html") {
			const suffix = "." + format;
			for (const p of entries) {
				const rel = p.slice(prefix.length);
				if (rel.toLowerCase().endsWith(suffix) && !rel.includes("/")) {
					const data = await zip.files[p].async("uint8array");
					extras.push({ format, fileName: rel, data });
				}
			}
		}
	}

	return { markdown, images, extras };
}

/** 逐级创建库内文件夹 */
export async function ensureFolderLevels(vault: VaultLike, folder: string): Promise<void> {
	const parts = normalizePath(folder)
		.split("/")
		.filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!vault.getAbstractFileByPath(current)) {
			try {
				await vault.createFolder(current);
			} catch {
				// 并发创建时可能已存在，忽略
			}
		}
	}
}

/** 仅需要 vault 通用能力时的最小接口（便于复用） */
export interface VaultLike {
	getAbstractFileByPath(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
}
