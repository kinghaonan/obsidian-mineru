import {
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	App,
	TFile,
} from "obsidian";
import type { QueueItem, QueueState } from "../types";
import type { PluginSettings } from "../settings";
import type { TranslationQueue } from "../translate/queue";
import { MultiSelectSuggestModal } from "./file-suggest";
import { TARGET_LANGUAGES } from "../constants";

export interface TranslationModalDeps {
	app: App;
	queue: TranslationQueue;
	getSettings: () => PluginSettings;
	openPath?: (path: string) => void;
}

/** 批量翻译弹窗：选文件 → 入队 → 并发翻译 → 查看结果 */
export class TranslationModal extends Modal {
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private startBtn!: ButtonComponent;
	private cancelBtn!: ButtonComponent;
	private retryBtn!: ButtonComponent;
	private clearBtn!: ButtonComponent;
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, private deps: TranslationModalDeps) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("MinerU 批量翻译");
		this.contentEl.addClass("mineru-queue");

		const s = this.deps.getSettings();

		new Setting(this.contentEl)
			.setName("添加文件")
			.setDesc("逐个点击选择 Markdown，可多选；选择完成后点底部「完成」")
			.addButton((btn) =>
				btn
					.setButtonText("选择 Markdown…")
					.setCta()
					.onClick(() => {
						const picker = new MultiSelectSuggestModal<TFile>(this.app, {
							placeholder: "搜索 Markdown 文件",
							getItems: () => this.app.vault.getFiles().filter((f) => f.extension === "md"),
							getKey: (f) => f.path,
							getLabel: (f) => f.path,
							onSubmit: (files) => {
								const added = this.deps.queue.add(files);
								if (added === 0) new Notice("没有新增文件（可能已在队列中）");
								else new Notice(`已加入队列：${added} 个文件`, 3000);
								this.render();
							},
						});
						picker.open();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("当前笔记").onClick(() => {
					const file = this.app.workspace.getActiveFile();
					if (!file || file.extension !== "md") {
						new Notice("请先打开一个 Markdown 笔记");
						return;
					}
					this.deps.queue.add([file]);
					this.render();
				}),
			);

		const langSetting = new Setting(this.contentEl).setName("目标语言");
		const known = TARGET_LANGUAGES.some(([code]) => code === s.targetLanguage);
		let languageOverride: string | null = null;
		langSetting
			.addDropdown((dd) => {
				dd.addOption("__keep__", `跟随设置（当前：${s.targetLanguage || known ? "en" : s.targetLanguage}）`);
				for (const [code, label] of TARGET_LANGUAGES) dd.addOption(code, `${label} (${code})`);
				dd.setValue("__keep__");
				dd.onChange((value) => {
					languageOverride = value === "__keep__" ? null : value;
				});
			})
			.setDesc("仅对本次队列生效，不修改全局设置");

		this.summaryEl = this.contentEl.createDiv({ cls: "mineru-queue-summary" });
		this.listEl = this.contentEl.createDiv({ cls: "mineru-progress-list mineru-queue-list" });

		const buttonContainer = this.contentEl.createDiv({ cls: "modal-button-container" });
		this.cancelBtn = new ButtonComponent(buttonContainer).setButtonText("取消队列").onClick(() => {
			this.deps.queue.cancel();
		});
		this.retryBtn = new ButtonComponent(buttonContainer)
			.setButtonText("重置失败项")
			.onClick(() => {
				const n = this.deps.queue.resetFailed();
				new Notice(n > 0 ? `已重置 ${n} 项，可重新开始` : "没有需要重置的失败项", 3000);
				this.render();
			});
		this.clearBtn = new ButtonComponent(buttonContainer).setButtonText("清空队列").onClick(() => {
			this.deps.queue.clear();
			this.render();
		});
		this.startBtn = new ButtonComponent(buttonContainer)
			.setButtonText("开始翻译")
			.setCta()
			.onClick(() => {
				const queue = this.deps.queue;
				if (queue.state.total === 0) {
					new Notice("请先添加要翻译的 Markdown 文件");
					return;
				}
				const missing = missingSettings(this.deps.getSettings());
				if (missing.length > 0) {
					new Notice(`请先在设置中配置翻译服务：缺少 ${missing.join("、")}`);
					return;
				}
				queue.start(languageOverride ? { targetLanguage: languageOverride } : undefined);
				this.render();
			});

		this.unsubscribe = this.deps.queue.onChange(() => this.render());
		this.render();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private render(): void {
		const state = this.deps.queue.state;
		this.summaryEl.setText(
			`共 ${state.total} 项 · 完成 ${state.done} · 失败 ${state.failed} · 跳过 ${state.skipped}` +
				(state.status === "running" ? " · 进行中" : ""),
		);
		this.startBtn.setDisabled(state.status === "running");
		this.startBtn.setButtonText(state.status === "running" ? "翻译中…" : "开始翻译");
		this.cancelBtn.setDisabled(state.status !== "running");
		this.retryBtn.setDisabled(state.status === "running" || state.failed + state.skipped === 0);
		this.clearBtn.setDisabled(state.total === 0);

		this.listEl.empty();
		if (state.total === 0) {
			this.listEl.createDiv({ cls: "setting-item-description", text: "队列为空，先添加 Markdown 文件" });
			return;
		}
		for (const item of state.items) this.renderItem(item);
	}

	private renderItem(item: QueueItem): void {
		const row = this.listEl.createDiv({ cls: "mineru-progress-row" });
		row.createSpan({ cls: "mineru-progress-name", text: item.basename });
		const stateEl = row.createSpan({ cls: "mineru-progress-state " + item.status, text: statusLabel(item) });
		const detail = row.createSpan({ cls: "mineru-progress-detail", text: "" });
		if (item.status === "running" && item.total) {
			detail.setText(`${item.done ?? 0}/${item.total} 块`);
		} else if (item.status === "failed" && item.error) {
			detail.setText(item.error);
		} else if (item.status === "done" && item.outputPath) {
			detail.setText(item.outputPath);
		} else if (item.status === "skipped") {
			detail.setText("队列取消，未执行");
		} else if (item.status === "done" && item.warnings?.length) {
			detail.setText(item.warnings.join("；"));
		}
		stateEl.className = "mineru-progress-state " + item.status;

		if (item.status === "done" && item.outputPath && this.deps.openPath) {
			row
				.createEl("button", { text: "打开", cls: "clickable-icon" })
				.addEventListener("click", () => this.deps.openPath?.(item.outputPath!));
		}
		if (item.status !== "running") {
			row
				.createEl("button", { text: "移除", cls: "clickable-icon" })
				.addEventListener("click", () => {
					this.deps.queue.remove(item.id);
					this.render();
				});
		}
	}
}

function statusLabel(item: QueueItem): string {
	switch (item.status) {
		case "pending":
			return "等待中";
		case "running":
			return "翻译中";
		case "done":
			return "完成";
		case "failed":
			return "失败";
		default:
			return "已跳过";
	}
}

/** 与单文件翻译一致的配置检查 */
export function missingSettings(s: PluginSettings): string[] {
	const missing: string[] = [];
	if (s.llmProvider === "openai") {
		if (!s.openaiApiKey.trim()) missing.push("API Key");
		if (!s.openaiBaseUrl.trim()) missing.push("Base URL");
		if (!s.openaiModel.trim()) missing.push("模型");
	} else {
		if (!s.anthropicApiKey.trim()) missing.push("API Key");
		if (!s.anthropicModel.trim()) missing.push("模型");
	}
	return missing;
}