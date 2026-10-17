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
}

/** 单个文件的实时进度 */
export interface FileProgress {
	fileName: string;
	state: "uploading" | "parsing" | "done" | "failed";
	detail?: string;
}

/** 单个文件的最终结果 */
export interface FileResult {
	fileName: string;
	outputPath?: string;
	images?: number;
	extras?: number;
	error?: string;
}

/** 一轮转换的汇总报告 */
export interface ConvertReport {
	total: number;
	succeeded: number;
	failed: number;
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
