import { App, TFile } from "obsidian";
import type { QueueItem, QueueListener, QueueState, TranslateOptions } from "../types";
import type { PluginSettings } from "../settings";
import type { Translator } from "./translator";

/** 从设置里取出翻译所需配置（与单文件翻译保持一致） */
export function translateOptionsFromSettings(s: PluginSettings): TranslateOptions {
	return {
		targetLanguage: s.targetLanguage,
		preserveFrontmatter: s.preserveFrontmatter,
		translateFrontmatterTitle: s.translateFrontmatterTitle,
		chunkSizeChars: s.chunkSizeChars,
		collisionPolicy: s.collisionPolicy,
	};
}

/**
 * 翻译队列：把多个 Markdown 文件排成队列，按并发数依次/并行翻译。
 * 支持取消、单条重试、清空；面板关闭后仍可在进度面板观察。
 */
export class TranslationQueue {
	private items: QueueItem[] = [];
	private listeners = new Set<QueueListener>();
	private running = false;
	private cancelled = false;
	private active = 0;
	private seq = 0;
	/** 本轮队列的临时选项覆盖 */
	private override: Partial<TranslateOptions> | null = null;

	constructor(
		private app: App,
		private translator: Translator,
		private getSettings: () => PluginSettings,
	) {}

	get state(): QueueState {
		const items = this.items;
		return {
			status: this.running ? "running" : "idle",
			items,
			done: items.filter((i) => i.status === "done").length,
			failed: items.filter((i) => i.status === "failed").length,
			skipped: items.filter((i) => i.status === "skipped").length,
			total: items.length,
		};
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** 尚未处理的项（pending） */
	get pending(): QueueItem[] {
		return this.items.filter((i) => i.status === "pending");
	}

	onChange(listener: QueueListener): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 加入队列：忽略非 Markdown 与重复项，返回实际新增数量 */
	add(files: TFile[]): number {
		const known = new Set(this.items.map((i) => i.path));
		let added = 0;
		for (const file of files) {
			if (file.extension !== "md") continue;
			if (known.has(file.path)) continue;
			known.add(file.path);
			this.items.push({
				id: `q${++this.seq}`,
				path: file.path,
				basename: file.basename,
				status: "pending",
			});
			added++;
		}
		if (added > 0) this.emit();
		return added;
	}

	remove(id: string): void {
		const item = this.items.find((i) => i.id === id);
		if (!item || item.status === "running") return;
		this.items = this.items.filter((i) => i.id !== id);
		this.emit();
	}

	/** 清空队列（运行中只保留正在执行的那几项） */
	clear(): void {
		if (!this.running) {
			this.items = [];
			this.emit();
			return;
		}
		this.items = this.items.filter((i) => i.status === "running");
		if (this.items.length === 0) {
			this.running = false;
			this.emit();
		}
	}

	/** 把失败的项重置为 pending（不自动开始） */
	resetFailed(): number {
		let count = 0;
		for (const item of this.items) {
			if (item.status !== "failed" && item.status !== "skipped") continue;
			item.status = "pending";
			item.error = undefined;
			item.done = undefined;
			item.total = undefined;
			count++;
		}
		if (count > 0) this.emit();
		return count;
	}

	/** 开始翻译队列；override 可临时覆盖目标语言等选项 */
	start(override?: Partial<TranslateOptions>): void {
		if (this.running) return;
		if (this.items.length === 0) return;
		for (const item of this.items) {
			if (item.status === "skipped") item.status = "pending";
		}
		this.override = override ?? null;
		this.running = true;
		this.cancelled = false;
		this.emit();
		this.pump();
	}

	/** 取消：正在执行的让其自然结束，未开始的标记为跳过 */
	cancel(): void {
		if (!this.running) return;
		this.cancelled = true;
		for (const item of this.items) {
			if (item.status === "pending") item.status = "skipped";
		}
		this.emit();
	}

	/** 取出下一个待处理项，受并发数限制 */
	private pump(): void {
		if (!this.running) return;
		const concurrency = Math.max(1, Math.floor(this.getSettings().translationConcurrency));
		while (!this.cancelled && this.active < concurrency) {
			const next = this.items.find((i) => i.status === "pending");
			if (!next) break;
			this.runItem(next);
		}
		if (this.active === 0) {
			this.running = false;
			this.emit();
		}
	}

	private async runItem(item: QueueItem): Promise<void> {
		item.status = "running";
		item.error = undefined;
		item.done = 0;
		this.active++;
		this.emit();
		try {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (!(file instanceof TFile)) {
				throw new Error("文件已被删除或移动");
			}
			const options = { ...translateOptionsFromSettings(this.getSettings()), ...this.override };
			const result = await this.translator.translateFile(
				file,
				options,
				this.getSettings,
				(done, total) => {
					item.done = done;
					item.total = total;
					this.emit();
				},
			);
			item.status = "done";
			item.outputPath = result.file.path;
			item.warnings = result.warnings;
		} catch (e) {
			item.status = "failed";
			item.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.active--;
			this.emit();
			this.pump();
		}
	}

	private emit(): void {
		const snapshot = this.state;
		for (const listener of this.listeners) listener(snapshot);
	}
}