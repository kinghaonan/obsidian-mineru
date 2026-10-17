import type { LlmEngine } from "./llm";

export { protectPlaceholders } from "../markdown";
export type { ProtectedText } from "../markdown";

/** 剥离 YAML frontmatter（--- ... ---），返回原文与正文 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
	if (match) {
		return { frontmatter: match[0], body: text.slice(match[0].length) };
	}
	return { frontmatter: null, body: text };
}

/** 翻译系统提示词 */
export function translationPrompt(targetLanguage: string): string {
	return `你是一名专业的文档翻译引擎。请把用户提供的 Markdown 内容翻译成 ${targetLanguage}。
规则：
1) 保留全部 Markdown 语法结构（标题、列表、表格、链接、引用、粗体斜体等）；
2) 必须原样保留所有形如 ⟦MDC:n⟧ 的占位符，不得改动、翻译或删除；
3) 不翻译其中的代码、数学公式、图片链接；
4) 只输出翻译后的内容，不要任何解释、前言或后缀。`;
}

/** 仅翻译 frontmatter 中的 title 字段，失败时保留原值 */
export async function translateFrontmatterTitle(
	frontmatter: string,
	targetLanguage: string,
	engine: LlmEngine,
	warnings: string[],
): Promise<string> {
	const match = frontmatter.match(/^(title:\s*)(.+?)\s*$/m);
	if (!match) return frontmatter;
	const original = match[2].trim();
	try {
		const result = await engine.translate(
			`你是一名翻译引擎。把下面的 ${targetLanguage} 标题翻译出来，只输出译文本身，不要任何引号或前后缀。`,
			original,
		);
		const title = result.content
			.trim()
			.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
		if (title) {
			return frontmatter.replace(
				/^(title:\s*)(.+?)\s*$/m,
				`$1${title.includes(" ") ? `"${title}"` : title}`,
			);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		warnings.push(`前言 title 翻译失败，已保留原值：${msg}`);
	}
	return frontmatter;
}
