import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MineruClient } from "./mineru/api";
import { ConversionPipeline } from "./mineru/pipeline";
import { isConvertiblePath } from "./utils";
import { Translator } from "./translate/translator";
import { LlmEngine } from "./translate/llm";
import { TranslationQueue } from "./translate/queue";
import { ConversionManager } from "./ui/manager";
import { ConversionWizard, type WizardDeps } from "./ui/wizard";
import { ProgressView, PROGRESS_VIEW_TYPE } from "./ui/progress-view";
import { TranslationModal } from "./ui/translation-modal";
import { DEFAULT_SETTINGS, mergeSettings, MineruSettingTab, type PluginSettings } from "./settings";
import type { ConvertOptions, ManagerState, TestResult } from "./types";

export default class MineruPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	client!: MineruClient;
	pipeline!: ConversionPipeline;
	translator!: Translator;
	queue!: TranslationQueue;
	manager!: ConversionManager;

	private wizardIconEl: HTMLElement | null = null;
	private convertIconEl: HTMLElement | null = null;
	private translateIconEl: HTMLElement | null = null;
	private progressIconEl: HTMLElement | null = null;
	private stateResetTimer: number | null = null;
	private translateStateTimer: number | null = null;
	private currentTranslationTimer: number | null = null;
	private progressOpenTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.client = new MineruClient(
			() => this.settings.mineruApiToken,
			() => this.settings.maxAutoRetries,
		);
		this.pipeline = new ConversionPipeline(this.app, this.client, () => this.settings);
		this.translator = new Translator(this.app);
		this.queue = new TranslationQueue(this.app, this.translator, () => this.settings);
		this.manager = new ConversionManager(this.pipeline);
		this.manager.onStateChange((state) => this.handleConversionState(state));

		this.registerView(
			PROGRESS_VIEW_TYPE,
			(leaf: WorkspaceLeaf) =>
				new ProgressView(leaf, {
					manager: this.manager,
					queue: this.queue,
					revealPath: (path) => this.revealPath(path),
				}),
		);

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
					if (!checking) void this.translateFile(file);
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "batch-translate",
			name: "MinerU：批量翻译（队列）",
			callback: () => {
				this.openTranslationModal();
			},
		});

		this.addCommand({
			id: "translate-all-notes",
			name: "MinerU：批量翻译整个文件夹",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.queueFolder(file);
				return true;
			},
		});

		this.addCommand({
			id: "retry-failed-conversion",
			name: "MinerU：重试上次失败的转换",
			callback: () => {
				void this.retryFailedConversion();
			},
		});

		this.addCommand({
			id: "open-progress-panel",
			name: "MinerU：打开进度面板",
			callback: () => {
				void this.activateProgressView();
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
								void this.translateFile(file);
							}),
					);
					menu.addItem((item) =>
						item
							.setTitle("用 MinerU 翻译所在文件夹")
							.setIcon("folder")
							.onClick(() => {
								this.queueFolder(file);
							}),
					);
				}
			}),
		);

		this.queue.onChange((state) => {
			if (state.status === "running") this.openProgressViewSoon();
		});
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
		for (const el of [
			this.wizardIconEl,
			this.convertIconEl,
			this.translateIconEl,
			this.progressIconEl,
		]) {
			el?.remove();
		}
		this.wizardIconEl = null;
		this.convertIconEl = null;
		this.translateIconEl = null;
		this.progressIconEl = null;

		this.wizardIconEl = this.addRibbonIcon("documents", "MinerU 转换向导", () => {
			new ConversionWizard(this.app, this.wizardDeps()).open();
		});

		if (this.settings.showQuickConvertButton) {
			this.convertIconEl = this.addRibbonIcon("file-plus", "MinerU：快速转换当前文件", () => {
				void this.quickConvert();
			});
		}

		if (this.settings.showQuickTranslateButton) {
			this.translateIconEl = this.addRibbonIcon("languages", "MinerU：快速翻译当前文件", () => {
				void this.quickTranslate();
			});
		}

		if (this.settings.showProgressButton) {
			this.progressIconEl = this.addRibbonIcon("activity", "MinerU：打开进度面板", () => {
				void this.activateProgressView();
			});
		}
	}

	private handleConversionState(state: ManagerState): void {
		if (this.wizardIconEl) {
			this.wizardIconEl.toggleClass("mineru-running", state.status === "running");
			this.wizardIconEl.toggleClass("mineru-done", state.status === "done");
			this.wizardIconEl.toggleClass("mineru-failed", state.status === "failed");
		}
		if (this.progressIconEl) {
			this.progressIconEl.toggleClass("mineru-running", state.status === "running" || this.queue.isRunning);
			this.progressIconEl.toggleClass("mineru-done", state.status === "done");
			this.progressIconEl.toggleClass("mineru-failed", state.status === "failed");
		}
		if (state.status === "running") this.openProgressViewSoon();
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

	/** 展开进度面板（去抖，避免同一批任务反复切换 leaf） */
	private openProgressViewSoon(): void {
		if (!this.settings.autoOpenProgressView) return;
		if (this.progressOpenTimer !== null) return;
		this.progressOpenTimer = window.setTimeout(() => {
			this.progressOpenTimer = null;
			void this.activateProgressView();
		}, 400);
	}

	/** 激活进度面板（已存在则复用） */
	async activateProgressView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(PROGRESS_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: PROGRESS_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private async revealPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
	}

	/** 当前笔记所在文件夹下的全部 Markdown 入队 */
	private queueFolder(file: TFile): void {
		const folder = file.parent?.path ?? "";
		const files = this.app.vault
			.getFiles()
			.filter((f) => f.extension === "md" && f.basename !== "README" && (!folder || f.path.startsWith(folder + "/")));
		if (files.length === 0) {
			new Notice("该文件夹下没有 Markdown 文件");
			return;
		}
		const added = this.queue.add(files);
		new Notice(`已加入翻译队列：${added} 个文件（共找到 ${files.length} 个）`, 4000);
		if (added > 0) this.openTranslationModal();
	}

	private openTranslationModal(): void {
		new TranslationModal(this.app, {
			app: this.app,
			queue: this.queue,
			getSettings: () => this.settings,
			openPath: (path) => void this.revealPath(path),
		}).open();
	}

	private async retryFailedConversion(): Promise<void> {
		if (!this.manager.canRetry) {
			new Notice("没有需要重试的失败项");
			return;
		}
		const count = this.manager.failedFiles.length;
		new Notice(`正在重试 ${count} 个失败文件…`, 3000);
		await this.activateProgressView();
		const report = await this.manager.retryFailed();
		if (report === null) new Notice("重试未能启动（可能已有任务在运行）", 4000);
	}

	private convertOptionsFromSettings(): ConvertOptions {
		const s = this.settings;
		return {
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
			collisionPolicy: s.conversionCollisionPolicy,
			imageCaptionNaming: s.imageCaptionNaming,
			showFigureCaption: s.showFigureCaption,
			removeCaptionLines: s.removeCaptionLines,
			split: {
				enabled: s.autoSplitEnabled,
				maxPages: s.autoSplitMaxPages,
				maxSizeMB: s.autoSplitMaxSizeMB,
				dedupeTitle: s.splitDedupeTitle,
			},
		};
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
		const started = await this.manager.start([file], this.convertOptionsFromSettings());
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