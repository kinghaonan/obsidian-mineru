import { requestUrl } from "obsidian";
import {
	MINERU_API_BASE,
	POLL_INTERVAL_MS,
	POLL_TIMEOUT_MS,
	RETRY_BASE_DELAY_MS,
	RETRYABLE_STATUS,
} from "../constants";
import { sleep } from "../utils";
import type { BatchFileResult, CancelSignal, ParseParams, TestResult } from "../types";
import { errorMessageFor, MineruError } from "./errors";

interface RawResponse {
	status: number;
	text: string;
	arrayBuffer: ArrayBuffer;
}

interface RawRequestOptions {
	url: string;
	method?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
}

export interface UploadTarget {
	name: string;
	dataId: string;
}

interface Envelope {
	success?: boolean;
	msgCode?: string;
	code?: number | string;
	data?: Record<string, unknown>;
}

/**
 * MinerU Standard Batch API 客户端：
 * 申请上传地址 → PUT 上传 → 轮询批次结果 → 下载结果 zip
 *
 * 网络异常与 429/5xx 会按指数退避自动重试（maxRetries 次）。
 */
export class MineruClient {
	constructor(
		private getToken: () => string,
		private getMaxRetries: () => number = () => 0,
	) {}

	/** 真正发请求，带瞬时错误重试 */
	async rawRequest(options: RawRequestOptions): Promise<RawResponse> {
		const { url, method = "GET", body, headers } = options;
		const maxRetries = Math.max(0, Math.floor(this.getMaxRetries()));
		let lastResponse: RawResponse | null = null;
		let lastError: unknown = null;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const resp = await requestUrl({
					url,
					method,
					body,
					headers,
					throw: false,
				});
				lastResponse = { status: resp.status, text: resp.text, arrayBuffer: resp.arrayBuffer };
				// 非瞬时状态（含 4xx 与 2xx）直接返回，由 parseEnvelope 给出带响应的错误
				if (!RETRYABLE_STATUS.has(resp.status)) return lastResponse;
			} catch (e) {
				lastError = e;
			}
			if (attempt < maxRetries) await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
		}
		// 有响应则交回上层解析（保留状态码与响应体），否则视为网络不可达
		if (lastResponse) return lastResponse;
		const msg = lastError instanceof Error ? lastError.message : String(lastError);
		throw new MineruError(`网络请求失败：${msg}`);
	}

	private async jsonRequest(
		method: string,
		url: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<Record<string, unknown>> {
		const token = this.getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (extraHeaders) Object.assign(headers, extraHeaders);

		let raw: RawResponse;
		try {
			raw = await this.rawRequest({
				url,
				method,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				headers,
			});
		} catch (e) {
			if (e instanceof MineruError) throw e;
			const msg = e instanceof Error ? e.message : String(e);
			throw new MineruError(`网络请求失败：${msg}`);
		}
		return this.parseEnvelope(raw);
	}

	private parseEnvelope(raw: RawResponse): Record<string, unknown> {
		let json: Envelope | null = null;
		try {
			json = JSON.parse(raw.text) as Envelope;
		} catch {
			// 非 JSON 响应按 null 处理
		}
		if (raw.status === 401 && !json) {
			throw new MineruError("Token 无效或已过期（HTTP 401）", "A0202");
		}
		if (json && json.success === false) {
			const code = json.msgCode ?? "A0202";
			throw new MineruError(errorMessageFor(code), code);
		}
		if (json && json.code !== undefined && json.code !== 0) {
			throw new MineruError(errorMessageFor(json.code), json.code);
		}
		if (raw.status < 200 || raw.status >= 300) {
			throw new MineruError(`HTTP ${raw.status}：${raw.text.slice(0, 200)}`, raw.status);
		}
		if (!json) {
			throw new MineruError("API 返回了无法解析的响应");
		}
		return (json.data as Record<string, unknown>) ?? {};
	}

	/** 申请批量上传地址；带附加格式报 -500 时由调用方降级重试 */
	async getUploadUrls(
		files: UploadTarget[],
		params: ParseParams,
	): Promise<{ batchId: string; urls: string[] }> {
		const payload: Record<string, unknown> = {
			files: files.map((f) => ({ name: f.name, data_id: f.dataId })),
			model_version: params.modelVersion,
			is_ocr: params.isOcr,
			enable_formula: params.enableFormula,
			enable_table: params.enableTable,
			language: params.language,
		};
		if (params.extraFormats.length > 0) payload.extra_formats = params.extraFormats;

		const data = await this.jsonRequest("POST", `${MINERU_API_BASE}/file-urls/batch`, payload);
		const batchId = data?.batch_id as string | undefined;
		const urls = (data?.file_urls as string[] | undefined) ?? [];
		if (!batchId || urls.length === 0) {
			throw new MineruError("上传地址申请失败：响应缺少 batch_id 或 file_urls");
		}
		return { batchId, urls };
	}

	/** 上传原始文件到预签名地址（requestUrl 失败时回退 fetch） */
	async putFile(url: string, data: ArrayBuffer): Promise<void> {
		const resp = await this.rawRequest({ url, method: "PUT", body: data });
		if (resp.status >= 200 && resp.status < 300) return;
		try {
			const fallback = await fetch(url, { method: "PUT", body: data });
			if (fallback.ok) return;
			throw new Error(`HTTP ${fallback.status}`);
		} catch (e) {
			if (e instanceof MineruError) throw e;
			const msg = e instanceof Error ? e.message : String(e);
			throw new MineruError(`文件上传失败（HTTP ${resp.status}，fetch 兜底失败：${msg}）`);
		}
	}

	/** 轮询批次结果，全部到终态或超时/取消为止 */
	async pollBatch(
		batchId: string,
		onUpdate: (results: BatchFileResult[]) => void,
		signal: CancelSignal,
		timeoutMs: number = POLL_TIMEOUT_MS,
	): Promise<BatchFileResult[]> {
		const startedAt = Date.now();
		for (;;) {
			if (signal.cancelled) throw new MineruError("转换已取消", "CANCELLED");
			const data = await this.jsonRequest("GET", `${MINERU_API_BASE}/extract-results/batch/${batchId}`);
			const results = (((data?.extract_result as Record<string, unknown>[]) ?? [])).map((item) => ({
				fileName: (item.file_name as string | undefined) ?? "未知文件",
				state: (item.state as string | undefined) ?? "unknown",
				fullZipUrl: item.full_zip_url as string | undefined,
				errCode: item.err_code as number | string | undefined,
				errMsg: item.err_msg as string | undefined,
			}));
			onUpdate(results);
			if (results.filter((r) => r.state !== "done" && r.state !== "failed").length === 0) {
				return results;
			}
			if (Date.now() - startedAt > timeoutMs) {
				throw new MineruError("解析超时（超过 30 分钟），请稍后重试", "TIMEOUT");
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	/** 下载结果 zip（requestUrl 失败时回退 fetch） */
	async downloadZip(url: string): Promise<ArrayBuffer> {
		try {
			const resp = await this.rawRequest({ url, method: "GET" });
			if (resp.status >= 200 && resp.status < 300) return resp.arrayBuffer;
		} catch {
			// 回退 fetch
		}
		try {
			const fallback = await fetch(url);
			if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
			return await fallback.arrayBuffer();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new MineruError(`结果下载失败：${msg}`);
		}
	}

	/** 用一个必然 404/报错的批次号探测 Token 有效性 */
	async testConnection(): Promise<TestResult> {
		const token = this.getToken();
		if (!token) return { ok: false, message: "未配置 MinerU API Token，请先在设置中填写" };
		try {
			const resp = await this.rawRequest({
				url: `${MINERU_API_BASE}/extract-results/batch/__token_probe__`,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (resp.status === 401) {
				return { ok: false, message: "Token 无效或已过期（HTTP 401）" };
			}
			let json: Envelope | null = null;
			try {
				json = JSON.parse(resp.text) as Envelope;
			} catch {
				// 忽略解析失败
			}
			if (json && json.success === false) {
				return { ok: false, message: `Token 无效或已过期（${json.msgCode ?? "A0202"}）` };
			}
			return { ok: true, message: "连接正常，Token 有效 ✅" };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, message: `网络错误：${msg}` };
		}
	}
}
