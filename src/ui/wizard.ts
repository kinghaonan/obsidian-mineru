import {
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	SliderComponent,
	TextComponent,
	ToggleComponent,
	DropdownComponent,
	App,
	TFile,
} from "obsidian";
import { COLLISION_POLICIES, WIZARD_EXTRA_FORMATS } from "../constants";
import type { CollisionPolicy, ConvertOptions, FileProgress, ManagerState } from "../types";
import type { ConversionPipeline } from "../mineru/pipeline";
import type { ConversionManager } from "./manager";
import type { PluginSettings } from "../settings";
import { FileSuggestModal } from "./file-suggest";

export interface WizardDeps {
	app: App;
	getSettings: () => PluginSettings;
	pipeline: ConversionPipeline;
	manager: ConversionManager;
}

/** 转换向导弹窗 */
export class ConversionWizard extends Modal {
	private deps: WizardDeps;
	private selectedFiles: TFile[];
	private progressRows = new Map<string, HTMLElement>();
	private unsubscribe: (() => void) | null = null;
	private fileListEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private cancelBtn!: ButtonComponent;
	private startBtn!: ButtonComponent;
	private retryBtn!: ButtonComponent;
	private outputInput!: TextComponent;
	private formatToggles: ToggleComponent[] = [];
	private downloadToggle!: ToggleComponent;
	private imageFolderInput!: TextComponent;
	private htmlToggle!: ToggleComponent;
	private widthSlider!: SliderComponent;
	private filenameToggle!: ToggleComponent;
	private collisionSelect!: DropdownComponent;
	private splitToggle!: ToggleComponent;
	private splitPagesInput!: TextComponent;

	constructor(app: App, deps: WizardDeps, preselected: TFile[] = []) {
		super(app);
		this.deps = deps;
		this.selectedFiles = preselected.slice();
	}

	onOpen(): void {
		this.titleEl.setText("MinerU 文档转换");
		this.contentEl.addClass("mineru-wizard");
		const settings = this.deps.getSettings();

		new Setting(this.contentEl).setName("选择要转换的文件").setHeading();

		new Setting(this.contentEl)
			.setName("文件")
			.setDesc("PDF / Word / PPT / Excel / 图片")
			.addButton((btn) =>
				btn.setButtonText("添加文件…").setCta().onClick(() => {
					new FileSuggestModal(this.app, (file) => {
						if (!this.selectedFiles.some((f) => f.path === file.path)) {
							this.selectedFiles.push(file);
							this.renderFileList();
						}
					}).open();
				}),
			);

		this.fileListEl = this.contentEl.createDiv({ cls: "mineru-progress-list" });
		this.renderFileList();

		const outputSetting = new Setting(this.contentEl)
			.setName("输出文件夹")
			.setDesc("库内文件夹，转换结果写入该目录（可每次修改）");
		this.outputInput = new TextComponent(outputSetting.controlEl)
			.setPlaceholder("例如：MinerU转换")
			.setValue(settings.outputFolder);

		const collisionSetting = new Setting(this.contentEl)
			.setName("同名文件处理")
			.setDesc("目标 Markdown 已存在时的行为");
		this.collisionSelect = new DropdownComponent(collisionSetting.controlEl);
		for (const policy of COLLISION_POLICIES) this.collisionSelect.addOption(policy.key, policy.label);
		this.collisionSelect.setValue(settings.conversionCollisionPolicy);

		for (const format of WIZARD_EXTRA_FORMATS) {
			const formatSetting = new Setting(this.contentEl).setName(format.label);
			this.formatToggles.push(
				new ToggleComponent(formatSetting.controlEl).setValue(settings.extraFormats.includes(format.key)),
			);
		}

		new Setting(this.contentEl).setName("大文件处理").setHeading();

		const splitSetting = new Setting(this.contentEl)
			.setName("自动切分并合并")
			.setDesc("PDF 页数或体积超过 MinerU 上限时，自动切成多个分片批量上传，再按顺序合并回一篇 Markdown");
		this.splitToggle = new ToggleComponent(splitSetting.controlEl).setValue(settings.autoSplitEnabled);

		const splitPagesSetting = new Setting(this.contentEl)
			.setName("每个分片页数上限")
			.setDesc("MinerU 单次解析上限 200 页，建议留出余量（默认 80）");
		this.splitPagesInput = new TextComponent(splitPagesSetting.controlEl)
			.setPlaceholder("80")
			.setValue(String(settings.autoSplitMaxPages));

		new Setting(this.contentEl).setName("图片处理").setHeading();

		const downloadSetting = new Setting(this.contentEl).setName("下载图片到库中");
		this.downloadToggle = new ToggleComponent(downloadSetting.controlEl).setValue(settings.downloadImages);

		const imageFolderSetting = new Setting(this.contentEl)
			.setName("图片保存文件夹")
			.setDesc("留空则自动保存为：{输出文件夹}/{文件名}.assets");
		this.imageFolderInput = new TextComponent(imageFolderSetting.controlEl)
			.setPlaceholder("留空自动生成")
			.setValue(settings.imageFolder);

		const htmlSetting = new Setting(this.contentEl).setName("图片居中显示并设置宽度");
		this.htmlToggle = new ToggleComponent(htmlSetting.controlEl).setValue(settings.convertImageToHtml);

		const widthSetting = new Setting(this.contentEl).setName("图片宽度");
		const widthLabel = widthSetting.nameEl.createSpan();
		this.widthSlider = new SliderComponent(widthSetting.controlEl)
			.setLimits(10, 100, 5)
			.setValue(settings.imageWidthPercent)
			.onChange((value) => {
				widthLabel.setText(` ${value}%`);
			});
		widthLabel.setText(` ${settings.imageWidthPercent}%`);

		const filenameSetting = new Setting(this.contentEl).setName("图片下方显示文件名（加粗）");
		this.filenameToggle = new ToggleComponent(filenameSetting.controlEl).setValue(settings.showImageFilename);

		this.progressEl = this.contentEl.createDiv({ cls: "mineru-progress-list" });

		const buttonContainer = this.contentEl.createDiv({ cls: "modal-button-container" });
		this.cancelBtn = new ButtonComponent(buttonContainer).setButtonText("取消").onClick(() => {
			if (this.deps.manager.isRunning) {
				this.deps.manager.cancel();
				this.cancelBtn.setButtonText("正在取消…");
			} else {
				this.close();
			}
		});
		this.retryBtn = new ButtonComponent(buttonContainer)
			.setButtonText("重试失败项")
			.onClick(() => void this.retryFailed());
		this.retryBtn.buttonEl.toggleClass("mineru-disabled", !this.deps.manager.canRetry);
		this.startBtn = new ButtonComponent(buttonContainer)
			.setButtonText("开始转换")
			.setCta()
			.onClick(() => {
				void this.startConversion();
			});

		this.unsubscribe = this.deps.manager.onStateChange((state) => this.renderState(state));
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** 读取向导当前设置并构造转换选项 */
	private buildOptions(): ConvertOptions {
		const settings = this.deps.getSettings();
		const extraFormats = WIZARD_EXTRA_FORMATS.filter(
			(_format, i) => this.formatToggles[i]?.getValue(),
		).map((format) => format.key);
		const pages = Number(this.splitPagesInput.getValue());
		return {
			outputFolder: this.outputInput.getValue().trim() || settings.outputFolder,
			params: {
				modelVersion: settings.parseModel,
				isOcr: settings.isOcr,
				enableFormula: settings.enableFormula,
				enableTable: settings.enableTable,
				language: settings.language,
				extraFormats,
			},
			downloadImages: this.downloadToggle.getValue(),
			imageFolder: this.imageFolderInput.getValue().trim(),
			convertImageToHtml: this.htmlToggle.getValue(),
			imageWidth: this.widthSlider.getValue(),
			showImageFilename: this.filenameToggle.getValue(),
			collisionPolicy: this.collisionSelect.getValue() as CollisionPolicy,
			split: {
				enabled: this.splitToggle.getValue(),
				maxPages: Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : settings.autoSplitMaxPages,
				maxSizeMB: settings.autoSplitMaxSizeMB,
				dedupeTitle: settings.splitDedupeTitle,
			},
		};
	}

	private async startConversion(): Promise<void> {
		if (this.deps.manager.isRunning) {
			new Notice("已有转换任务正在进行，请等待完成或先取消");
			return;
		}
		if (this.selectedFiles.length === 0) {
			new Notice("请先选择要转换的文件");
			return;
		}
		if (!this.deps.getSettings().mineruApiToken.trim()) {
			new Notice("请先在设置中配置 MinerU API Token");
			return;
		}
		const started = await this.deps.manager.start(this.selectedFiles.slice(), this.buildOptions());
		if (started === null) new Notice("已有转换任务正在进行");
	}

	private async retryFailed(): Promise<void> {
		const report = await this.deps.manager.retryFailed();
		if (report === null) new Notice("没有可重试的失败项");
		this.renderState(this.deps.manager.state);
	}

	private renderState(state: ManagerState): void {
		if (state.status === "running") {
			this.startBtn.setDisabled(true);
			this.startBtn.setButtonText("转换中…");
			this.cancelBtn.setButtonText("取消");
			this.retryBtn.buttonEl.toggleClass("mineru-disabled", true);
			if (state.progress) {
				for (const progress of state.progress.values()) this.upsertProgress(progress);
			}
		} else if (state.status === "done" || state.status === "failed") {
			this.startBtn.setDisabled(false);
			this.startBtn.setButtonText("开始转换");
			this.cancelBtn.setButtonText("取消");
			this.retryBtn.buttonEl.toggleClass("mineru-disabled", !this.deps.manager.canRetry);
			if (state.status === "done" && state.report) {
				this.addSummary(
					`✅ 转换完成：成功 ${state.report.succeeded}，失败 ${state.report.failed}` +
						(state.report.skipped > 0 ? `，跳过 ${state.report.skipped}` : ""),
				);
			} else if (state.status === "failed") {
				this.addSummary(`❌ ${state.error ?? "转换失败"}`);
			}
		} else {
			this.startBtn.setDisabled(false);
			this.startBtn.setButtonText("开始转换");
			this.cancelBtn.setButtonText("取消");
			this.retryBtn.buttonEl.toggleClass("mineru-disabled", !this.deps.manager.canRetry);
		}
	}

	private renderFileList(): void {
		this.fileListEl.empty();
		if (this.selectedFiles.length === 0) {
			this.fileListEl.createDiv({ cls: "setting-item-description", text: "尚未选择文件" });
			return;
		}
		for (const file of this.selectedFiles) {
			const row = this.fileListEl.createDiv({ cls: "mineru-progress-row" });
			row.createSpan({ text: file.name });
			row.createSpan({ cls: "setting-item-description", text: " · " + file.path });
			row
				.createEl("button", { text: "移除", cls: "clickable-icon" })
				.addEventListener("click", () => {
					this.selectedFiles = this.selectedFiles.filter((f) => f.path !== file.path);
					this.renderFileList();
				});
		}
	}

	private upsertProgress(progress: FileProgress): void {
		let row = this.progressRows.get(progress.fileName);
		if (!row) {
			row = this.progressEl.createDiv({ cls: "mineru-progress-row" });
			row.createSpan({ cls: "mineru-progress-name", text: progress.fileName });
			row.createSpan({ cls: "mineru-progress-state", text: "" });
			row.createSpan({ cls: "mineru-progress-detail", text: "" });
			this.progressRows.set(progress.fileName, row);
		}
		const stateEl = row.querySelector(".mineru-progress-state");
		const detailEl = row.querySelector(".mineru-progress-detail");
		const label =
			progress.state === "uploading"
				? "上传中"
				: progress.state === "parsing"
					? "解析中"
					: progress.state === "done"
						? "完成"
						: "失败";
		if (stateEl) {
			stateEl.textContent = label;
			stateEl.className = "mineru-progress-state " + progress.state;
		}
		if (detailEl) {
			detailEl.textContent = [progress.part, progress.detail].filter(Boolean).join(" · ");
		}
	}

	private addSummary(text: string): void {
		this.progressEl.createDiv({ cls: "mineru-progress-row" }).setText(text);
	}
}