// 共享类型定义

/** MinerU 解析参数（对应 /file-urls/batch 请求体） */
export interface ParseParams {
	modelVersion: "vlm" | "pipeline";
	isOcr: boolean;
	enableFormula: boolean;
	enableTable: boolean;
	language: string;
	extraFormats: string[];
}

/** 一次转换任务的选项（向导 / 快速转换都会构造它） */
export interface ConvertOptions {
	outputFolder: string;
	params: ParseParams;
	downloadImages: boolean;
	imageFolder: string;
	convertImageToHtml: boolean;
	imageWidth: number;
	showImageFilename: boolean;
	/** 目标文件已存在时的处理方式 */
	collisionPolicy: CollisionPolicy;
	/** 大文件切分策略 */
	split: SplitOptions;
	/** 是否用图注给图片文件命名（默认 true） */
	imageCaptionNaming?: boolean;
	/** 是否在图下渲染图注文本（默认 true） */
	showFigureCaption?: boolean;
	/** 是否删除原文中已被渲染的图注行（默认 true） */
	removeCaptionLines?: boolean;
}

/** 目标文件冲突策略 */
export type CollisionPolicy = "rename" | "overwrite" | "skip";

/** 大文件自动切分策略 */
export interface SplitOptions {
	enabled: boolean;
	/** 单个分片的最大页数 */
	maxPages: number;
	/** 单个分片的最大体积（MB） */
	maxSizeMB: number;
	/** 合并时去掉各分片重复出现的一级标题 */
	dedupeTitle: boolean;
}

/** 切分规划：把 N 页切成若干页区间 */
export interface PageRange {
	index: number;
	start: number;
	end: number;
}

/** 切分后的单个 PDF 分片 */
export interface PdfChunk {
	index: number;
	start: number;
	end: number;
	data: ArrayBuffer;
}

/** 合并前的单个分片解析产物 */
export interface MergedPart {
	markdown: string;
	images: { relPath: string; data: Uint8Array }[];
	start: number;
	end: number;
}

/** 单个文件的实时进度 */
export interface FileProgress {
	fileName: string;
	state: "uploading" | "parsing" | "done" | "failed";
	detail?: string;
	/** 大文件切分转换时的分片进度，如 "3/12 分片" */
	part?: string;
}

/** 单个文件的最终结果 */
export interface FileResult {
	fileName: string;
	outputPath?: string;
	images?: number;
	extras?: number;
	error?: string;
	/** 冲突策略为「跳过」时为 true */
	skipped?: boolean;
	/** 实际切分并转换的分片数（>1 表示走了切分合并流程） */
	parts?: number;
	/** 该文件累计尝试次数（含重试） */
	attempts?: number;
}

/** 一轮转换的汇总报告 */
export interface ConvertReport {
	total: number;
	succeeded: number;
	failed: number;
	/** 因目标文件已存在而被跳过的数量 */
	skipped: number;
	results: FileResult[];
}

/** 轮询接口返回的单文件状态 */
export interface BatchFileResult {
	fileName: string;
	state: string;
	fullZipUrl?: string;
	errCode?: number | string;
	errMsg?: string;
}

/** 转换管理器状态机 */
export type ManagerState =
	| { status: "idle" }
	| { status: "running"; progress: Map<string, FileProgress> }
	| { status: "done"; report: ConvertReport; progress: Map<string, FileProgress> }
	| { status: "failed"; error: string; progress: Map<string, FileProgress> };

/** 取消信号 */
export interface CancelSignal {
	cancelled: boolean;
}

/** 结果 zip 解压产物 */
export interface ZipContents {
	markdown: string;
	images: { relPath: string; data: Uint8Array }[];
	extras: { format: string; fileName: string; data: Uint8Array }[];
}

/** LLM 引擎配置 */
export interface LlmConfig {
	provider: "openai" | "anthropic";
	openaiBaseUrl: string;
	openaiApiKey: string;
	openaiModel: string;
	anthropicApiKey: string;
	anthropicModel: string;
	temperature: number;
	maxOutputTokens: number;
}

/** 单次 LLM 调用结果 */
export interface TranslationResult {
	content: string;
	truncated: boolean;
}

/** 翻译文件的选项 */
export interface TranslateOptions {
	targetLanguage: string;
	preserveFrontmatter: boolean;
	translateFrontmatterTitle: boolean;
	chunkSizeChars: number;
	collisionPolicy: "rename" | "overwrite";
}

/** 连接 / 翻译测试结果 */
export interface TestResult {
	ok: boolean;
	message: string;
}

/** LLM 服务预设 */
export interface LlmPreset {
	key: string;
	label: string;
	baseUrl: string;
	model: string;
}

/** 附加导出格式选项 */
export interface ExtraFormatOption {
	key: "docx" | "html" | "latex";
	label: string;
}

/** 冲突策略选项（设置页 / 向导共用） */
export interface CollisionPolicyOption {
	key: CollisionPolicy;
	label: string;
}

/** ------------------------------------------------------------ 翻译队列 */

export type QueueItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** 队列中的单个文件 */
export interface QueueItem {
	id: string;
	path: string;
	basename: string;
	status: QueueItemStatus;
	/** 已完成的分块 / 总分块 */
	done?: number;
	total?: number;
	outputPath?: string;
	error?: string;
	/** 翻译过程中的告警（如占位符提示、截断提示） */
	warnings?: string[];
}

/** 队列状态快照 */
export interface QueueState {
	status: "idle" | "running" | "paused";
	items: QueueItem[];
	done: number;
	failed: number;
	skipped: number;
	total: number;
}

/** 队列事件监听器 */
export type QueueListener = (state: QueueState) => void;
