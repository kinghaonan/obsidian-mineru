import { Notice, Plugin, TFile } from "obsidian";
import { MineruClient } from "./mineru/api";
import { ConversionPipeline } from "./mineru/pipeline";
import { isConvertiblePath } from "./utils";
import { Translator } from "./translate/translator";
import { LlmEngine } from "./translate/llm";
import { ConversionManager } from "./ui/manager";
import { ConversionWizard, type WizardDeps } from "./ui/wizard";
import { DEFAULT_SETTINGS, mergeSettings, MineruSettingTab, type PluginSettings } from "./settings";
import type { ConvertOptions, ManagerState, TestResult } from "./types";

export default class MineruPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	client!: MineruClient;
	pipeline!: ConversionPipeline;
	translator!: Translator;
	manager!: ConversionManager;

	private wizardIconEl: HTMLElement | null = null;
	private convertIconEl: HTMLElement | null = null;
	private translateIconEl: HTMLElement | null = null;
	private stateResetTimer: number | null = null;
	private translateStateTimer: number | null = null;
	private currentTranslationTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.client = new MineruClient(() => this.settings.mineruApiToken);
		this.pipeline = new ConversionPipeline(this.app, this.client, () => this.settings);
		this.translator = new Translator(this.app);
		this.manager = new ConversionManager(this.pipeline);
		this.manager.onStateChange((state) => this.handleConversionState(state));

		this.setupRibbons();
		this.addSettingTab(new MineruSettingTab(this.app, this));

		this.addCommand({
			id: "open-conversion-wizard",
			name: "MinerU：打开转换向导",
			callback: () => {
				new ConversionWizard(this.app, this.wizardDeps()).open();
			},
		});

		this.addCommand({
			id: "convert-active-file",
			name: "MinerU：将当前文件转换为 Markdown",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file && isConvertiblePath(file.path)) {
					if (!checking) new ConversionWizard(this.app, this.wizardDeps(), [file]).open();
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "translate-current-note",
			name: "MinerU：翻译当前笔记",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file && file.extension === "md") {
					if (!checking) this.translateFile(file);
					return true;
				}
				return false;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (isConvertiblePath(file.path)) {
					menu.addItem((item) =>
						item
							.setTitle("用 MinerU 转换为 Markdown")
							.setIcon("documents")
							.onClick(() => {
								new ConversionWizard(this.app, this.wizardDeps(), [file]).open();
							}),
					);
				}
				if (file.extension === "md") {
					menu.addItem((item) =>
						item
							.setTitle("用 MinerU 翻译此文件")
							.setIcon("languages")
							.onClick(() => {
								this.translateFile(file);
							}),
					);
				}
			}),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	refreshRibbons(): void {
		this.setupRibbons();
	}

	private setupRibbons(): void {
		for (const el of [this.wizardIconEl, this.convertIconEl, this.translateIconEl]) el?.remove();
		this.wizardIconEl = null;
		this.convertIconEl = null;
		this.translateIconEl = null;

		this.wizardIconEl = this.addRibbonIcon("documents", "MinerU 转换向导", () => {
			new ConversionWizard(this.app, this.wizardDeps()).open();
		});

		if (this.settings.showQuickConvertButton) {
			this.convertIconEl = this.addRibbonIcon("file-plus", "MinerU：快速转换当前文件", () => {
				this.quickConvert();
			});
		}

		if (this.settings.showQuickTranslateButton) {
			this.translateIconEl = this.addRibbonIcon("languages", "MinerU：快速翻译当前文件", () => {
				this.quickTranslate();
			});
		}
	}

	private handleConversionState(state: ManagerState): void {
		if (this.wizardIconEl) {
			this.wizardIconEl.toggleClass("mineru-running", state.status === "running");
			this.wizardIconEl.toggleClass("mineru-done", state.status === "done");
			this.wizardIconEl.toggleClass("mineru-failed", state.status === "failed");
		}
		if (state.status === "done" || state.status === "failed") {
			if (this.stateResetTimer !== null) window.clearTimeout(this.stateResetTimer);
			this.stateResetTimer = window.setTimeout(() => {
				this.manager.reset();
				this.stateResetTimer = null;
			}, 6000);
		}
	}

	private setTranslateIcon(active: boolean, failed = false): void {
		if (!this.translateIconEl) return;
		this.translateIconEl.toggleClass("mineru-translating", active);
		this.translateIconEl.toggleClass("mineru-failed", failed);
		if (this.translateStateTimer !== null) {
			window.clearTimeout(this.translateStateTimer);
			this.translateStateTimer = null;
		}
		if (failed) {
			this.translateStateTimer = window.setTimeout(() => {
				this.translateIconEl?.removeClass("mineru-failed");
				this.translateStateTimer = null;
			}, 6000);
		}
	}

	private updateTranslateTooltip(done: number, total: number): void {
		if (!this.translateIconEl) return;
		this.translateIconEl.setAttribute(
			"aria-label",
			`正在翻译 ${done}/${total}${done >= total ? " · 完成" : ""}`,
		);
		if (this.currentTranslationTimer !== null) window.clearTimeout(this.currentTranslationTimer);
		this.currentTranslationTimer = window.setTimeout(() => {
			this.translateIconEl?.removeAttribute("aria-label");
			this.currentTranslationTimer = null;
		}, 5000);
	}

	private async quickConvert(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !isConvertiblePath(file.path)) {
			new Notice("请先打开一个支持转换的文件（PDF / Word / PPT / Excel / 图片）");
			return;
		}
		if (this.manager.isRunning) {
			new Notice("已有转换任务正在进行，请等待完成或先取消");
			return;
		}
		if (!this.settings.mineruApiToken.trim()) {
			new Notice("请先在设置中配置 MinerU API Token");
			return;
		}
		const s = this.settings;
		const options: ConvertOptions = {
			outputFolder: s.outputFolder,
			params: {
				modelVersion: s.parseModel,
				isOcr: s.isOcr,
				enableFormula: s.enableFormula,
				enableTable: s.enableTable,
				language: s.language,
				extraFormats: s.extraFormats,
			},
			downloadImages: s.downloadImages,
			imageFolder: s.imageFolder,
			convertImageToHtml: s.convertImageToHtml,
			imageWidth: s.imageWidthPercent,
			showImageFilename: s.showImageFilename,
		};
		const started = await this.manager.start([file], options);
		if (started === null) new Notice("已有转换任务正在进行");
	}

	private async quickTranslate(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			new Notice("请先打开一个 Markdown 笔记再翻译");
			return;
		}
		await this.translateFile(file);
	}

	private async translateFile(file: TFile): Promise<void> {
		const s = this.settings;
		const missing: string[] = [];
		if (s.llmProvider === "openai") {
			if (!s.openaiApiKey.trim()) missing.push("API Key");
			if (!s.openaiBaseUrl.trim()) missing.push("Base URL");
			if (!s.openaiModel.trim()) missing.push("模型");
		} else {
			if (!s.anthropicApiKey.trim()) missing.push("API Key");
			if (!s.anthropicModel.trim()) missing.push("模型");
		}
		if (missing.length > 0) {
			new Notice(`请先在设置中配置翻译服务：缺少 ${missing.join("、")}（设置 → LLM 翻译设置）`);
			return;
		}

		this.setTranslateIcon(true);
		try {
			const { file: translated, warnings } = await this.translator.translateFile(
				file,
				{
					targetLanguage: s.targetLanguage,
					preserveFrontmatter: s.preserveFrontmatter,
					translateFrontmatterTitle: s.translateFrontmatterTitle,
					chunkSizeChars: s.chunkSizeChars,
					collisionPolicy: s.collisionPolicy,
				},
				() => this.settings,
				(done, total) => this.updateTranslateTooltip(done, total),
			);
			await this.translator.reveal(translated);
			const suffix = warnings.length > 0 ? `（${warnings.join("；")}）` : "";
			new Notice(`翻译完成：${file.basename}.${s.targetLanguage || "翻译"}.md${suffix}`, 6000);
		} catch (e) {
			this.setTranslateIcon(false, true);
			new Notice(`翻译失败：${e instanceof Error ? e.message : String(e)}`, 12000);
		} finally {
			this.setTranslateIcon(false);
		}
	}

	private wizardDeps(): WizardDeps {
		return {
			app: this.app,
			getSettings: () => this.settings,
			pipeline: this.pipeline,
			manager: this.manager,
		};
	}

	async testTranslation(): Promise<TestResult> {
		const s = this.settings;
		if (s.llmProvider === "openai") {
			if (!s.openaiApiKey.trim()) return { ok: false, message: "缺少 OpenAI 兼容接口的 API Key" };
			if (!s.openaiBaseUrl.trim()) return { ok: false, message: "缺少 Base URL" };
			if (!s.openaiModel.trim()) return { ok: false, message: "缺少模型" };
		} else {
			if (!s.anthropicApiKey.trim()) return { ok: false, message: "缺少 Anthropic API Key" };
			if (!s.anthropicModel.trim()) return { ok: false, message: "缺少模型" };
		}
		const engine = new LlmEngine({
			provider: s.llmProvider,
			openaiBaseUrl: s.openaiBaseUrl,
			openaiApiKey: s.openaiApiKey,
			openaiModel: s.openaiModel,
			anthropicApiKey: s.anthropicApiKey,
			anthropicModel: s.anthropicModel,
			temperature: Math.min(s.temperature, 0.2),
			maxOutputTokens: 64,
		});
		try {
			const result = await engine.translate(
				"你是一个翻译引擎。把下面的内容翻译成英文。只输出译文。",
				"你好，这是一条测试消息。",
			);
			const ok = result.content.trim().length > 0;
			return {
				ok,
				message: ok
					? `✅ 连接正常！测试返回：${result.content.trim().slice(0, 60)}`
					: "❌ 服务返回了空内容，请检查模型配置",
			};
		} catch (e) {
			return { ok: false, message: `❌ 失败：${e instanceof Error ? e.message : String(e)}` };
		}
	}
}
