import { Notice, TFile } from "obsidian";
import type { CancelSignal, ConvertOptions, ConvertReport, FileProgress, ManagerState } from "../types";
import type { ConversionPipeline } from "../mineru/pipeline";

type StateListener = (state: ManagerState) => void;

/** 转换状态机：面板关闭后转换继续在后台跑，状态供 ribbon 指示 */
export class ConversionManager {
	private listeners = new Set<StateListener>();
	private signal: CancelSignal | null = null;
	private progress = new Map<string, FileProgress>();
	private _state: ManagerState = { status: "idle" };
	private pipeline: ConversionPipeline;
	/** 最近一次提交的文件列表（原包保留字段，便于重试/查询） */
	activeFiles: TFile[] = [];

	get state(): ManagerState {
		return this._state;
	}

	get isRunning(): boolean {
		return this._state.status === "running";
	}

	onStateChange(listener: StateListener): () => void {
		this.listeners.add(listener);
		listener(this._state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	constructor(pipeline: ConversionPipeline) {
		this.pipeline = pipeline;
	}

	async start(files: TFile[], options: ConvertOptions): Promise<ConvertReport | null> {
		if (this.isRunning) return null;
		this.activeFiles = files.slice();
		this.progress.clear();
		const signal: CancelSignal = { cancelled: false };
		this.signal = signal;
		this.emit({ status: "running", progress: this.progress });
		try {
			const report = await this.pipeline.convertFiles(
				files,
				options,
				(p) => {
					this.progress.set(p.fileName, p);
					this.emit({ status: "running", progress: this.progress });
				},
				signal,
			);
			if (signal.cancelled) {
				this.emit({ status: "failed", error: "转换已取消", progress: this.progress });
				new Notice("MinerU 转换已取消");
				return report;
			}
			this.emit({ status: "done", report, progress: this.progress });
			new Notice(`MinerU 转换完成：成功 ${report.succeeded}，失败 ${report.failed}`, 5000);
			return report;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.emit({ status: "failed", error: message, progress: this.progress });
			new Notice(`MinerU 转换失败：${message}`, 8000);
			return null;
		} finally {
			this.signal = null;
		}
	}

	cancel(): void {
		if (this.signal) this.signal.cancelled = true;
	}

	reset(): void {
		if (!this.isRunning) this.emit({ status: "idle" });
	}

	private emit(state: ManagerState): void {
		this._state = state;
		for (const listener of this.listeners) listener(state);
	}
}
