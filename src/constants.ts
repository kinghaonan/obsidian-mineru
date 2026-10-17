import type { ExtraFormatOption, LlmPreset } from "./types";

/** MinerU Standard API 基地址 */
export const MINERU_API_BASE = "https://mineru.net/api/v4";

/** 单文件大小上限（200MB） */
export const MAX_FILE_SIZE = 200 * 1024 * 1024;

/** 轮询间隔 3 秒 */
export const POLL_INTERVAL_MS = 3_000;

/** 轮询超时 30 分钟 */
export const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/** 支持转换的文件扩展名 */
export const SUPPORTED_EXTENSIONS = new Set([
	"pdf",
	"doc",
	"docx",
	"ppt",
	"pptx",
	"xls",
	"xlsx",
	"png",
	"jpg",
	"jpeg",
	"jp2",
	"webp",
	"gif",
	"bmp",
]);

/** 附加导出格式（设置页用） */
export const EXTRA_FORMATS: ExtraFormatOption[] = [
	{ key: "docx", label: "DOCX" },
	{ key: "html", label: "HTML" },
	{ key: "latex", label: "LaTeX" },
];

/** 附加导出格式（向导用） */
export const WIZARD_EXTRA_FORMATS: ExtraFormatOption[] = [
	{ key: "docx", label: "同时导出 DOCX" },
	{ key: "html", label: "同时导出 HTML" },
	{ key: "latex", label: "同时导出 LaTeX" },
];

/** MinerU 错误码 → 中文提示 */
export const ERROR_MESSAGES: Record<string, string> = {
	A0202: "Token 无效，请在设置中检查或重新生成",
	A0211: "Token 已过期，请在设置中更新",
	"-500": "请求参数错误",
	"-10001": "服务错误，请稍后重试",
	"-10002": "请求参数错误",
	"-60001": "生成上传地址失败，请稍后重试",
	"-60002": "不支持的文件格式",
	"-60003": "文件读取失败，文件可能已损坏",
	"-60004": "文件为空，请上传有效文件",
	"-60005": "文件过大（Standard API 上限 200MB）",
	"-60006": "页数过多（Standard API 上限 200 页），请拆分文件",
	"-60007": "模型服务暂不可用，请稍后重试",
	"-60008": "文件读取超时，请确认链接可达",
	"-60009": "任务队列已满，请稍后重试",
	"-60010": "解析失败，请稍后重试",
	"-60011": "无法获取有效文件，请确认文件已上传",
	"-60012": "任务不存在，请检查任务 ID",
	"-60013": "无权限访问该任务",
	"-60015": "文件转换失败，请先转换为 PDF",
	"-60016": "格式转换失败，请尝试其他导出格式",
	"-60017": "已超过重试次数上限",
	"-60018": "今日解析额度已用完，请明天再试",
	"-60019": "HTML 解析额度不足，请明天再试",
	"-60022": "网页读取失败，可能被限流，请稍后重试",
	"-30001": "文件超过 10MB，Standard API 上限为 200MB",
	"-30002": "Agent API 不支持该文件类型",
	"-30003": "页数超过 20 页限制",
	"-30004": "请求参数错误",
};

/** MinerU 批次状态 → 中文标签 */
export function stateLabel(state: string): string {
	switch (state) {
		case "pending":
			return "排队中";
		case "running":
			return "解析中";
		case "converting":
			return "格式转换";
		case "uploading":
			return "上传中";
		case "waiting-file":
			return "等待上传";
		case "done":
			return "完成";
		case "failed":
			return "失败";
		default:
			return state;
	}
}

/** 目标语言表 */
export const TARGET_LANGUAGES: [string, string][] = [
	["en", "英文"],
	["zh", "简体中文"],
	["zh-TW", "繁体中文"],
	["ja", "日文"],
	["ko", "韩文"],
	["fr", "法文"],
	["de", "德文"],
	["es", "西班牙文"],
	["pt", "葡萄牙文"],
	["it", "意大利文"],
	["ru", "俄文"],
	["ar", "阿拉伯文"],
	["hi", "印地文"],
	["th", "泰文"],
	["vi", "越南文"],
	["id", "印尼文"],
];

/** LLM 常用服务预设 */
export const LLM_PRESETS: LlmPreset[] = [
	{ key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
	{ key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
	{ key: "qwen", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
	{ key: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
	{ key: "ollama", label: "Ollama（本地）", baseUrl: "http://localhost:11434/v1", model: "qwen2.5" },
];

/** OCR 识别语言说明 */
export const OCR_LANGUAGE_DESC =
	"OCR 识别语言：ch（中文）、en（英文）、ja（日文）、ko（韩文）、fr、de、es、ru 等，多个用 + 连接（如 ch+en）";
