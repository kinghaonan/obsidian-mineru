/** 占位符保护结果 */
export interface ProtectedText {
	text: string;
	restore: (text: string) => string;
}

/**
 * 把代码块 / $$公式$$ / `行内码` / $行内公式$（可选图片链接）
 * 替换为 ⟦MDC:n⟧ 占位符，翻译后用 restore 还原。
 */
export function protectPlaceholders(text: string, options: { protectImages?: boolean } = {}): ProtectedText {
	const patterns: string[] = [
		/```[\s\S]*?(?:```|$)/.source,
		/\$\$[\s\S]*?\$\$/.source,
		/`[^`\n]+`/.source,
		/\$[^$\n]+\$/.source,
	];
	if (options.protectImages) patterns.push(/!\[[^\]]*\]\([^)\n]*\)/.source);
	const regex = new RegExp(patterns.join("|"), "g");

	const store = new Map<number, string>();
	let index = 0;
	let out = "";
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text))) {
		out += text.slice(cursor, match.index);
		const id = index++;
		store.set(id, match[0]);
		out += `⟦MDC${id}⟧`;
		cursor = regex.lastIndex;
	}
	out += text.slice(cursor);

	const restore = (translated: string): string =>
		translated.replace(/⟦MDC(\d+)⟧/g, (_whole, id: string) => store.get(Number(id)) ?? "");

	return { text: out, restore };
}

/**
 * 图片链接：同时兼容三种写法
 *   ![alt](images/a.jpg)
 *   ![alt](<带 空格 的 文件.jpg>)
 *   ![alt](images/a.jpg "标题")
 */
const IMAGE_LINK_REGEX = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** 取出链接目标（去掉 <>/引号） */
function linkTarget(url: string): string {
	return url.replace(/^</, "").replace(/>$/, "").replace(/["']/g, "");
}

/** 用映射表改写 Markdown 图片链接（支持 images/ 前缀回退） */
export function rewriteImageLinks(markdown: string, urlMap: Map<string, string>): string {
	const { text, restore } = protectPlaceholders(markdown, { protectImages: false });
	const replaced = text.replace(IMAGE_LINK_REGEX, (whole, alt: string, url: string) => {
		const cleanUrl = linkTarget(url);
		const target = urlMap.get(cleanUrl) ?? urlMap.get(`images/${cleanUrl}`);
		return target ? `![${alt}](${target})` : whole;
	});
	return restore(replaced);
}

/** 把图片链接转换为居中 HTML（可选宽度与加粗文件名） */
export function imagesToCenteredHtml(
	markdown: string,
	widthPercent: number,
	showFilename: boolean,
	captions?: Map<string, string>,
): string {
	const { text, restore } = protectPlaceholders(markdown, { protectImages: false });
	const width = Math.max(10, Math.min(100, Math.round(widthPercent)));
	const replaced = text.replace(IMAGE_LINK_REGEX, (whole, alt: string, url: string) => {
		const cleanUrl = linkTarget(url);
		const safeAlt = (alt ?? "").replace(/"/g, "&quot;");
		const img = `<img src="${cleanUrl}" alt="${safeAlt}" width="${width}%"/>`;
		const caption = captions?.get(cleanUrl);
		// 优先展示图注；无图注时回退到文件名（沿用原有行为）
		const note = caption
			? `<br/><span class="mineru-figcaption">${escapeHtml(caption)}</span>`
			: showFilename
				? `<br/><strong>${displayName(cleanUrl)}</strong>`
				: "";
		if (!note) return `<div style="text-align:center">${img}</div>`;
		return `<div style="text-align:center">${img}${note}</div>`;
	});
	return restore(replaced);
}

/** 文件名（已解码）经 HTML 转义 */
function displayName(url: string): string {
	return escapeHtml(decodeURIComponent(url.split("/").pop() ?? ""));
}

/** HTML 文本转义（图注来自 PDF 文本，需防注入） */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * 删除原文中已被渲染到 HTML 图注区的行（图注行、子标签行）。
 * 用行号集合精确删除，避免正则误伤正文。
 */
export function dropLines(markdown: string, lines: Set<number>): string {
	if (lines.size === 0) return markdown;
	return markdown
		.split(/\r?\n/)
		.filter((_, i) => !lines.has(i))
		.join("\n");
}
