import { requestUrl } from "obsidian";
import type { LlmConfig, TranslationResult } from "../types";

/** LLM 翻译错误（status 为 HTTP 状态码） */
export class LlmError extends Error {
	status: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "LlmError";
		this.status = status ?? 0;
	}
}

/** OpenAI 兼容 / Anthropic 双引擎的翻译调用 */
export class LlmEngine {
	constructor(private config: LlmConfig) {}

	async translate(system: string, content: string): Promise<TranslationResult> {
		return this.config.provider === "anthropic"
			? this.translateAnthropic(system, content)
			: this.translateOpenAI(system, content);
	}

	private async translateOpenAI(system: string, content: string): Promise<TranslationResult> {
		const { openaiBaseUrl, openaiApiKey, openaiModel, temperature, maxOutputTokens } = this.config;
		if (!openaiApiKey.trim()) {
			throw new LlmError("未配置 OpenAI 兼容接口的 API Key，请先在设置中填写");
		}
		const url = `${openaiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
		const resp = await requestUrl({
			url,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${openaiApiKey}`,
			},
			body: JSON.stringify({
				model: openaiModel,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content },
				],
				temperature,
				max_tokens: maxOutputTokens,
			}),
			throw: false,
		});
		this.checkStatus(resp, "OpenAI 兼容接口");
		const json = this.safeJson(resp, "OpenAI 兼容接口") as {
			choices?: { message?: { content?: unknown }; finish_reason?: string }[];
			error?: { message?: string };
		};
		const content0 = json?.choices?.[0]?.message?.content;
		if (typeof content0 !== "string") {
			throw new LlmError(
				`OpenAI 兼容接口错误：${json?.error?.message ?? "未返回有效的翻译结果"}`,
				resp.status,
			);
		}
		const finishReason = json?.choices?.[0]?.finish_reason;
		return { content: content0, truncated: finishReason === "length" };
	}

	private async translateAnthropic(system: string, content: string): Promise<TranslationResult> {
		const { anthropicApiKey, anthropicModel, temperature, maxOutputTokens } = this.config;
		if (!anthropicApiKey.trim()) {
			throw new LlmError("未配置 Anthropic API Key，请先在设置中填写");
		}
		const resp = await requestUrl({
			url: "https://api.anthropic.com/v1/messages",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": anthropicApiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: anthropicModel,
				system,
				messages: [{ role: "user", content }],
				max_tokens: maxOutputTokens,
				temperature,
			}),
			throw: false,
		});
		this.checkStatus(resp, "Anthropic");
		const json = this.safeJson(resp, "Anthropic") as {
			content?: { type?: string; text?: string }[];
			error?: { message?: string };
			stop_reason?: string;
		};
		const textBlock = (json?.content ?? []).find((block) => block?.type === "text");
		if (!textBlock || typeof textBlock.text !== "string") {
			throw new LlmError(`Anthropic 错误：${json?.error?.message ?? "未返回有效的翻译结果"}`, resp.status);
		}
		return { content: textBlock.text, truncated: json?.stop_reason === "max_tokens" };
	}

	private safeJson(resp: { json?: unknown; status: number }, label: string): Record<string, unknown> {
		let json: unknown = null;
		try {
			json = resp.json;
		} catch {
			json = null;
		}
		if (json === null || typeof json !== "object") {
			throw new LlmError(`${label}返回了无法解析的响应`, resp.status);
		}
		return json as Record<string, unknown>;
	}

	private serverErrorDetail(resp: { json?: unknown }): string {
		try {
			const error = (resp.json as { error?: unknown } | undefined)?.error;
			if (typeof error === "string" && error) return error;
			if (error && typeof (error as { message?: unknown }).message === "string") {
				const message = (error as { message: string }).message;
				if (message) return message;
			}
		} catch {
			// 无服务端错误详情
		}
		return "";
	}

	private checkStatus(resp: { status: number; json?: unknown }, label: string): void {
		const status = resp.status;
		if (status >= 200 && status < 300) return;
		const detail = this.serverErrorDetail(resp);
		let reason = "";
		if (status === 401) reason = "API Key 无效，请在设置中检查";
		else if (status === 403) reason = "无权限访问该接口";
		else if (status === 404) reason = "接口地址或模型名称不正确（HTTP 404）";
		else if (status === 429) reason = "请求过于频繁（限流），请稍后重试";
		else if ([500, 502, 503, 504, 529].includes(status)) reason = "服务端错误，请稍后重试";
		const suffix = detail ? `（服务端：${detail}）` : "";
		throw new LlmError(
			`${label}请求失败（HTTP ${status}）${reason ? "：" + reason : ""}${suffix}`,
			status,
		);
	}
}
