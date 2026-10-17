import { App, normalizePath, TFile } from "obsidian";
import { sanitizeFileName } from "../utils";
import { protectPlaceholders } from "../markdown";
import type { LlmConfig, TranslateOptions, TranslationResult } from "../types";
import { LlmEngine } from "./llm";
import { chunkText, splitInTwo } from "./chunker";
import { splitFrontmatter, translationPrompt, translateFrontmatterTitle } from "./placeholders";
import type { PluginSettings } from "../settings";

const MAX_SPLIT_DEPTH = 4;
const MIN_SPLIT_CHARS = 80;

export interface TranslateFileResult {
	file: TFile;
	warnings: string[];
}

type ProgressCallback = ((done: number, total: number) => void) | undefined;

/** 翻译整篇 Markdown：占位符保护 → 分块翻译 → 截断二分重译 → 写库 */
export class Translator {
	constructor(private app: App) {}

	async translateFile(
		file: TFile,
		options: TranslateOptions,
		getSettings: () => PluginSettings,
		onProgress?: ProgressCallback,
	): Promise<TranslateFileResult> {
		const settings = getSettings();
		const config: LlmConfig = {
			provider: settings.llmProvider,
			openaiBaseUrl: settings.openaiBaseUrl,
			openaiApiKey: settings.openaiApiKey,
			openaiModel: settings.openaiModel,
			anthropicApiKey: settings.anthropicApiKey,
			anthropicModel: settings.anthropicModel,
			temperature: settings.temperature,
			maxOutputTokens: settings.maxOutputTokens,
		};
		const engine = new LlmEngine(config);
		const content = await this.app.vault.read(file);

		const targetLanguage = options.targetLanguage.trim() || "目标语言";
		const warnings: string[] = [];
		const { frontmatter, body } = splitFrontmatter(content);

		let frontmatterOut = "";
		if (frontmatter && options.preserveFrontmatter) {
			frontmatterOut = options.translateFrontmatterTitle
				? await translateFrontmatterTitle(frontmatter, targetLanguage, engine, warnings)
				: frontmatter;
		}

		const { text, restore } = protectPlaceholders(body, { protectImages: true });
		const chunks = chunkText(text, options.chunkSizeChars);
		if (chunks.length === 0) warnings.push("文档没有可翻译的正文内容");

		const translated: string[] = [];
		for (let i = 0; i < chunks.length; i++) {
			onProgress?.(i + 1, chunks.length);
			const chunk = chunks[i];
			translated.push(await this.translateWithSplit(engine, translationPrompt(targetLanguage), chunk, warnings));
		}
		onProgress?.(chunks.length, chunks.length);

		const joined = translated.join("\n\n");
		const restored = restore(joined);
		const leftover = (restored.match(/⟦MDC\d+⟧/g) ?? []).length;
		if (leftover > 0) {
			warnings.push(`${leftover} 处代码/公式占位符未被正确还原，请检查翻译结果`);
		}

		const output = (frontmatterOut ? frontmatterOut + "\n" : "") + restored;

		const folderSetting = settings.translationOutputFolder || "";
		let dir = "";
		if (folderSetting.trim()) {
			dir = normalizePath(folderSetting);
			await this.ensureFolder(dir);
		} else if (file.path.includes("/")) {
			dir = normalizePath(file.path.slice(0, file.path.lastIndexOf("/")));
		}

		const langSafe = sanitizeFileName(targetLanguage);
		const baseSafe = sanitizeFileName(file.basename);
		const target = normalizePath(`${dir}/${baseSafe}.${langSafe}.md`);
		return { file: await this.writeWithPolicy(target, output, options.collisionPolicy), warnings };
	}

	async translateWithSplit(
		engine: LlmEngine,
		system: string,
		chunk: string,
		warnings: string[],
		depth = 0,
	): Promise<string> {
		const result: TranslationResult = await engine.translate(system, chunk);
		if (!result.truncated) return result.content;
		if (depth >= MAX_SPLIT_DEPTH || chunk.length <= MIN_SPLIT_CHARS) {
			warnings.push(
				"有内容因超过输出上限被截断且无法继续拆分，请增大“单次最大输出 Tokens”或减小分块大小",
			);
			return result.content;
		}
		const [head, tail] = splitInTwo(chunk);
		const headTranslated = await this.translateWithSplit(engine, system, head, warnings, depth + 1);
		const tailTranslated = await this.translateWithSplit(engine, system, tail, warnings, depth + 1);
		return headTranslated + "\n\n" + tailTranslated;
	}

	private async ensureFolder(folder: string): Promise<void> {
		const parts = normalizePath(folder)
			.split("/")
			.filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch {
					// 已存在
				}
			}
		}
	}

	private async writeWithPolicy(
		path: string,
		content: string,
		policy: "rename" | "overwrite",
	): Promise<TFile> {
		const vault = this.app.vault;
		const existing = vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			if (policy === "overwrite") {
				await vault.modify(existing, content);
				return existing;
			}
			const renamed = this.uniquePath(path);
			await vault.create(renamed, content);
			const created = vault.getAbstractFileByPath(renamed);
			if (!(created instanceof TFile)) throw new Error("创建翻译文件失败");
			return created;
		}
		await vault.create(path, content);
		const created = vault.getAbstractFileByPath(path);
		if (!(created instanceof TFile)) throw new Error("创建翻译文件失败");
		return created;
	}

	private uniquePath(path: string): string {
		const dot = path.lastIndexOf(".");
		const base = dot > 0 ? path.slice(0, dot) : path;
		const ext = dot > 0 ? path.slice(dot) : "";
		let n = 1;
		let candidate = `${base} (${n})${ext}`;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			n++;
			candidate = `${base} (${n})${ext}`;
		}
		return candidate;
	}

	async reveal(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}
}
