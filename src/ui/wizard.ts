import {
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	SliderComponent,
	TextComponent,
	ToggleComponent,
	App,
	TFile,
} from "obsidian";
import { WIZARD_EXTRA_FORMATS } from "../constants";
import type { ConvertOptions, FileProgress, ManagerState } from "../types";
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
		const outputInput = new TextComponent(outputSetting.controlEl)
			.setPlaceholder("例如：MinerU转换")
			.setValue(settings.outputFolder);

		const formatToggles: ToggleComponent[] = [];
		for (const format of WIZARD_EXTRA_FORMATS) {
			const formatSetting = new Setting(this.contentEl).setName(format.label);
			const toggle = new ToggleComponent(formatSetting.controlEl).setValue(
				settings.extraFormats.includes(format.key),
			);
			formatToggles.push(toggle);
		}

		new Setting(this.contentEl).setName("图片处理").setHeading();

		const downloadSetting = new Setting(this.contentEl).setName("下载图片到库中");
		const downloadToggle = new ToggleComponent(downloadSetting.controlEl).setValue(settings.downloadImages);

		const imageFolderSetting = new Setting(this.contentEl)
			.setName("图片保存文件夹")
			.setDesc("留空则自动保存为：{输出文件夹}/{文件名}.assets");
		const imageFolderInput = new TextComponent(imageFolderSetting.controlEl)
			.setPlaceholder("留空自动生成")
			.setValue(settings.imageFolder);

		const htmlSetting = new Setting(this.contentEl).setName("图片居中显示并设置宽度");
		const htmlToggle = new ToggleComponent(htmlSetting.controlEl).setValue(settings.convertImageToHtml);

		const widthSetting = new Setting(this.contentEl).setName("图片宽度");
		const widthLabel = widthSetting.nameEl.createSpan();
		const widthSlider = new SliderComponent(widthSetting.controlEl)
			.setLimits(10, 100, 5)
			.setValue(settings.imageWidthPercent)
			.onChange((value) => {
				widthLabel.setText(` ${value}%`);
			});
		widthLabel.setText(` ${settings.imageWidthPercent}%`);

		const filenameSetting = new Setting(this.contentEl).setName("图片下方显示文件名（加粗）");
		const filenameToggle = new ToggleComponent(filenameSetting.controlEl).setValue(settings.showImageFilename);

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
		this.startBtn = new ButtonComponent(buttonContainer)
			.setButtonText("开始转换")
			.setCta()
			.onClick(() => {
				this.startConversion(outputInput, formatToggles, downloadToggle, imageFolderInput, htmlToggle, widthSlider, filenameToggle);
			});

		this.unsubscribe = this.deps.manager.onStateChange((state) => this.renderState(state));
	}

	onClose(): void {
		this.unsubscribe?.();
	}

	private async startConversion(
		outputInput: TextComponent,
		formatToggles: ToggleComponent[],
		downloadToggle: ToggleComponent,
		imageFolderInput: TextComponent,
		htmlToggle: ToggleComponent,
		widthSlider: SliderComponent,
		filenameToggle: ToggleComponent,
	): Promise<void> {
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
		const settings = this.deps.getSettings();
		const extraFormats = WIZARD_EXTRA_FORMATS.filter((f, i) => formatToggles[i].getValue()).map((f) => f.key);
		const options: ConvertOptions = {
			outputFolder: outputInput.getValue().trim() || settings.outputFolder,
			params: {
				modelVersion: settings.parseModel,
				isOcr: settings.isOcr,
				enableFormula: settings.enableFormula,
				enableTable: settings.enableTable,
				language: settings.language,
				extraFormats,
			},
			downloadImages: downloadToggle.getValue(),
			imageFolder: imageFolderInput.getValue().trim(),
			convertImageToHtml: htmlToggle.getValue(),
			imageWidth: widthSlider.getValue(),
			showImageFilename: filenameToggle.getValue(),
		};
		const started = await this.deps.manager.start(this.selectedFiles.slice(), options);
		if (started === null) {
			new Notice("已有转换任务正在进行");
		}
	}

	private renderState(state: ManagerState): void {
		if (state.status === "running") {
			this.startBtn.setDisabled(true);
			this.startBtn.setButtonText("转换中…");
			this.cancelBtn.setButtonText("取消");
			if (state.progress) {
				for (const progress of state.progress.values()) this.upsertProgress(progress);
			}
		} else if (state.status === "done" || state.status === "failed") {
			this.startBtn.setDisabled(false);
			this.startBtn.setButtonText("开始转换");
			this.cancelBtn.setButtonText("取消");
			if (state.status === "done" && state.report) {
				this.addSummary(`✅ 转换完成：成功 ${state.report.succeeded}，失败 ${state.report.failed}`);
			} else if (state.status === "failed") {
				this.addSummary(`❌ ${state.error ?? "转换失败"}`);
			}
		} else {
			this.startBtn.setDisabled(false);
			this.startBtn.setButtonText("开始转换");
			this.cancelBtn.setButtonText("取消");
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
		if (detailEl) detailEl.textContent = progress.detail ?? "";
	}

	private addSummary(text: string): void {
		this.progressEl.createDiv({ cls: "mineru-progress-row" }).setText(text);
	}
}
