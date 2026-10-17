import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { FileProgress, ManagerState } from "../types";
import type { ConversionManager } from "./manager";
import type { TranslationQueue } from "../translate/queue";

export const PROGRESS_VIEW_TYPE = "mineru-progress-view";

export interface ProgressViewDeps {
	manager: ConversionManager;
	queue: TranslationQueue;
	revealPath: (path: string) => Promise<void>;
}

/**
 * 侧边栏进度面板：转换与翻译队列都汇总到这里。
 * 关闭向导/弹窗后任务继续在后台跑，进度随时可回来看。
 */
export class ProgressView extends ItemView {
	private unsubscribeManager: (() => void) | null = null;
	private unsubscribeQueue: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private deps: ProgressViewDeps,
	) {
		super(leaf);
	}

	getViewType(): string {
		return PROGRESS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "MinerU 进度";
	}

	getIcon(): string {
		return "documents";
	}

	async onOpen(): Promise<void> {
		this.unsubscribeManager = this.deps.manager.onStateChange(() => this.render());
		this.unsubscribeQueue = this.deps.queue.onChange(() => this.render());
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribeManager?.();
		this.unsubscribeQueue?.();
		this.unsubscribeManager = null;
		this.unsubscribeQueue = null;
	}

	async revealPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.deps.revealPath(path);
		} else {
			new Notice(`找不到文件：${path}`, 4000);
		}
	}

	render(): void {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		const root = container ?? this.contentEl;
		root.empty();
		root.addClass("mineru-progress-view");

		this.renderConversion(root);
		this.renderQueue(root);
	}

	private renderConversion(root: HTMLElement): void {
		const state: ManagerState = this.deps.manager.state;
		root.createEl("h3", { text: "文档转换" });

		const toolbar = root.createDiv({ cls: "mineru-toolbar" });
		const statusText =
			state.status === "running"
				? "转换进行中…"
				: state.status === "done"
					? `完成：成功 ${state.report.succeeded}，失败 ${state.report.failed}，跳过 ${state.report.skipped}`
					: state.status === "failed"
						? `失败：${state.error}`
						: "空闲";
		toolbar.createSpan({ text: statusText, cls: "mineru-toolbar-status " + state.status });

		const cancelBtn = toolbar.createEl("button", { text: "取消", cls: "clickable-icon" });
		cancelBtn.toggleClass("mineru-disabled", state.status !== "running");
		cancelBtn.addEventListener("click", () => this.deps.manager.cancel());

		const retryBtn = toolbar.createEl("button", { text: "重试失败项", cls: "clickable-icon" });
		retryBtn.toggleClass("mineru-disabled", !this.deps.manager.canRetry);
		retryBtn.addEventListener("click", () => {
			void this.deps.manager.retryFailed().then((report) => {
				if (report === null) new Notice("没有可重试的失败项", 3000);
			});
		});

		const clearBtn = toolbar.createEl("button", { text: "清空", cls: "clickable-icon" });
		clearBtn.toggleClass("mineru-disabled", state.status === "running");
		clearBtn.addEventListener("click", () => this.deps.manager.clear());

		const progress =
			state.status === "idle" ? new Map<string, FileProgress>() : state.progress;
		const list = root.createDiv({ cls: "mineru-progress-list" });
		if (progress.size === 0 && (!this.deps.manager.lastReport || this.deps.manager.lastReport.results.length === 0)) {
			list.createDiv({ cls: "setting-item-description", text: "暂无转换任务" });
			return;
		}
		for (const item of progress.values()) {
			list.createDiv({ cls: "mineru-progress-row" }, (row) => {
				row.createSpan({ cls: "mineru-progress-name", text: item.fileName });
				row.createSpan({
					cls: "mineru-progress-state " + item.state,
					text: progressLabel(item.state),
				});
				const detail = [item.part, item.detail].filter(Boolean).join(" · ");
				row.createSpan({ cls: "mineru-progress-detail", text: detail });
			});
		}
		const results = this.deps.manager.lastReport?.results ?? [];
		for (const result of results.filter((r) => r.error || r.skipped || r.parts)) {
			list.createDiv({ cls: "mineru-progress-row" }, (row) => {
				row.createSpan({ cls: "mineru-progress-name", text: result.fileName });
				row.createSpan({
					cls: "mineru-progress-state " + (result.skipped ? "skipped" : result.error ? "failed" : "done"),
					text: result.skipped ? "已跳过" : result.error ? "失败" : "完成",
				});
				const extra: string[] = [];
				if (result.parts && result.parts > 1) extra.push(`${result.parts} 个分片已合并`);
				if (result.skipped) extra.push("目标文件已存在");
				if (result.error) extra.push(result.error);
				if (result.outputPath) extra.push(result.outputPath);
				row.createSpan({ cls: "mineru-progress-detail", text: extra.join(" · ") });
			});
		}
	}

	private renderQueue(root: HTMLElement): void {
		const state = this.deps.queue.state;
		root.createEl("h3", { text: "翻译队列" });

		const toolbar = root.createDiv({ cls: "mineru-toolbar" });
		toolbar.createSpan({
			cls: "mineru-toolbar-status " + state.status,
			text:
				state.total === 0
					? "队列为空"
					: `共 ${state.total} 项 · 完成 ${state.done} · 失败 ${state.failed} · 跳过 ${state.skipped}` +
						(state.status === "running" ? " · 进行中" : ""),
		});

		const cancelBtn = toolbar.createEl("button", { text: "取消", cls: "clickable-icon" });
		cancelBtn.toggleClass("mineru-disabled", !this.deps.queue.isRunning);
		cancelBtn.addEventListener("click", () => this.deps.queue.cancel());

		const retryBtn = toolbar.createEl("button", { text: "重置失败项", cls: "clickable-icon" });
		retryBtn.toggleClass(
			"mineru-disabled",
			this.deps.queue.isRunning || state.failed + state.skipped === 0,
		);
		retryBtn.addEventListener("click", () => this.deps.queue.resetFailed());

		const clearBtn = toolbar.createEl("button", { text: "清空", cls: "clickable-icon" });
		clearBtn.toggleClass("mineru-disabled", state.total === 0);
		clearBtn.addEventListener("click", () => this.deps.queue.clear());

		const list = root.createDiv({ cls: "mineru-progress-list" });
		if (state.items.length === 0) {
			list.createDiv({ cls: "setting-item-description", text: "队列为空，用「批量翻译」添加笔记" });
			return;
		}
		for (const item of state.items) {
			list.createDiv({ cls: "mineru-progress-row" }, (row) => {
				row.createSpan({ cls: "mineru-progress-name", text: item.basename });
				row.createSpan({
					cls: "mineru-progress-state " + item.status,
					text: queueLabel(item.status),
				});
				const detail =
					item.status === "running" && item.total
						? `${item.done ?? 0}/${item.total} 块`
						: item.status === "failed"
							? (item.error ?? "")
							: item.status === "skipped"
								? "队列取消，未执行"
								: item.status === "done" && item.warnings?.length
									? item.warnings.join("；")
									: (item.outputPath ?? "");
				row.createSpan({ cls: "mineru-progress-detail", text: detail });
				if (item.status === "done" && item.outputPath) {
					row
						.createEl("button", { text: "打开", cls: "clickable-icon" })
						.addEventListener("click", () => void this.revealPath(item.outputPath!));
				}
			});
		}
	}
}

function progressLabel(state: FileProgress["state"]): string {
	switch (state) {
		case "uploading":
			return "上传中";
		case "parsing":
			return "解析中";
		case "done":
			return "完成";
		default:
			return "失败";
	}
}

function queueLabel(state: "pending" | "running" | "done" | "failed" | "skipped"): string {
	switch (state) {
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