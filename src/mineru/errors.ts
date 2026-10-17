import { ERROR_MESSAGES } from "../constants";

/** MinerU API 错误（code 为错误码字符串或 HTTP 状态） */
export class MineruError extends Error {
	code: number | string;

	constructor(message: string, code?: number | string) {
		super(message);
		this.name = "MineruError";
		this.code = code ?? "";
	}
}

/** 错误码 → 中文提示（未知码回退为通用文案） */
export function errorMessageFor(code: number | string): string {
	const key = String(code);
	return ERROR_MESSAGES[key] ?? `API 错误（${key}）`;
}
