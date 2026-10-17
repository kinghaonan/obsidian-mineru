import { Notice, TFile } from "obsidian";
import type {
	CancelSignal,
	ConvertOptions,
	ConvertReport,
	FileProgress,
	FileResult,
	ManagerState,
} from "../types";
import type { ConversionPipeline } from "../mineru/pipeline";

type StateListener = (state: ManagerState) => void;

/**
 * 汇总报告（多次尝试后按文件名合并）。
 * 注意：新一轮结果里没有 error/skipped 时要显式清除上一轮的标记，
 * 否则重试成功的文件仍会被算作失败。
 */
function mergeReports(reports: ConvertReport[], total: number): ConvertReport {
	const byName = new Map<string, FileResult>();
	for (const report of reports) {
		for (const result of report.results) {
			const attempts = (byName.get(result.fileName)?.attempts ?? 0) + 1;
			byName.set(result.fileName, { ...result, error: result.error, skipped: result.skipped, attempts });
		}
	}
	const results = [...byName.values()];
	return {
		total,
		succeeded: results.filter((r) => !r.error && !r.skipped).length,
		failed: results.filter((r) => Boolean(r.error)).length,
		skipped: results.filter((r) => Boolean(r.skipped)).length,
		results,
	};
}

/**
 * 转换状态机：面板关闭后转换继续在后台跑，状态供 ribbon 指示。
 * 支持对失败文件重新发起转换（retryFailed）。
 */
export class ConversionManager {
	private listeners = new Set<StateListener>();
	private signal: CancelSignal | null = null;
	private progress = new Map<string, FileProgress>();
	private _state: ManagerState = { status: "idle" };
	private pipeline: ConversionPipeline;
	/** 最近一次提交的文件列表（保留原包字段，便于重试/查询） */
	activeFiles: TFile[] = [];
	/** 最近一次成功启动时使用的选项，重试时复用 */
	lastOptions: ConvertOptions | null = null;
	/** 最近一次汇总报告（可能包含多次重试的结果） */
	lastReport: ConvertReport | null = null;
	/** 本轮累计的报告，重试时累加 */
	private history: ConvertReport[] = [];
	/** 本轮涉及的全部文件（重试会补充进来），用于统计总数与挑出失败项 */
	private roundFiles = new Map<string, TFile>();

	get state(): ManagerState {
		return this._state;
	}

	get isRunning(): boolean {
		return this._state.status === "running";
	}

	/** 本轮中失败的 TFile（按文件名匹配本轮文件表） */
	get failedFiles(): TFile[] {
		if (!this.lastReport) return [];
		return this.lastReport.results
			.filter((r) => Boolean(r.error))
			.map((r) => this.roundFiles.get(r.fileName))
			.filter((f): f is TFile => Boolean(f));
	}

	/** 是否存在可重试的失败项 */
	get canRetry(): boolean {
		return !this.isRunning && this.failedFiles.length > 0;
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
		this.lastOptions = options;
		this.history = [];
		this.roundFiles = new Map(files.map((f) => [f.path, f]));
		return this.run(files, options, true);
	}

	/** 重跑本轮中失败的文件；无可重试项时返回 null */
	async retryFailed(): Promise<ConvertReport | null> {
		if (this.isRunning) return null;
		const targets = this.failedFiles;
		if (targets.length === 0 || !this.lastOptions) return null;
		this.activeFiles = targets.slice();
		for (const file of targets) this.roundFiles.set(file.path, file);
		return this.run(targets, this.lastOptions, false);
	}

	/** 内部执行；isNewRound 为 true 时重置进度与历史 */
	private async run(
		files: TFile[],
		options: ConvertOptions,
		isNewRound: boolean,
	): Promise<ConvertReport | null> {
		if (isNewRound) this.progress.clear();
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
			this.history.push(report);
			const merged = mergeReports(this.history, this.roundFiles.size);
			this.lastReport = merged;
			if (signal.cancelled) {
				this.emit({ status: "failed", error: "转换已取消", progress: this.progress });
				new Notice("MinerU 转换已取消");
				return merged;
			}
			this.emit({ status: "done", report: merged, progress: this.progress });
			new Notice(
				`MinerU 转换完成：成功 ${merged.succeeded}，失败 ${merged.failed}` +
					(merged.skipped > 0 ? `，跳过 ${merged.skipped}` : ""),
				5000,
			);
			return merged;
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

	/** 清空本轮记录（重试能力同时失效） */
	clear(): void {
		if (this.isRunning) return;
		this.activeFiles = [];
		this.lastOptions = null;
		this.lastReport = null;
		this.history = [];
		this.roundFiles.clear();
		this.progress.clear();
		this.emit({ status: "idle" });
	}

	private emit(state: ManagerState): void {
		this._state = state;
		for (const listener of this.listeners) listener(state);
	}
}