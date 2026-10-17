import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setRequestHandler, type StubRequest } from "./helpers/obsidian-mock";
import { MineruClient } from "../src/mineru/api";
import { MineruError } from "../src/mineru/errors";
import type { ParseParams } from "../src/types";

const PARAMS: ParseParams = {
	modelVersion: "vlm",
	isOcr: true,
	enableFormula: true,
	enableTable: false,
	language: "ch",
	extraFormats: [],
};

function client(token = "token-ok") {
	return new MineruClient(() => token);
}

/** 依次按队列返回响应（超出后重复最后一个） */
function queue(responses: Array<(req: StubRequest) => unknown>) {
	let i = 0;
	return (req: StubRequest) => {
		const fn = responses[Math.min(i, responses.length - 1)];
		i++;
		const payload = fn(req);
		return { status: 200, json: payload, text: JSON.stringify(payload) };
	};
}

/** 访问私有 jsonRequest 以单测信封解析 */
function jsonRequest(c: MineruClient, method: string, url: string): Promise<Record<string, unknown>> {
	return (c as unknown as { jsonRequest(m: string, u: string): Promise<Record<string, unknown>> }).jsonRequest(
		method,
		url,
	);
}

/** 让微任务链推进到下一次 sleep，再触发计时器 */
async function advance(t: TestContext, ms: number): Promise<void> {
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	for (let i = 0; i < 5; i++) await flush();
	t.mock.timers.tick(ms);
	for (let i = 0; i < 5; i++) await flush();
}

function stubFetch(t: TestContext, impl: (url: string) => unknown): void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: unknown) => impl(String(input))) as unknown as typeof fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
}

test("testConnection 未配置 Token 直接失败", async () => {
	const result = await new MineruClient(() => "").testConnection();
	assert.equal(result.ok, false);
	assert.match(result.message, /未配置/);
});

test("testConnection 识别 401 与错误信封", async (t) => {
	t.after(() => setRequestHandler(null));

	setRequestHandler(() => ({ status: 401, text: "unauthorized" }));
	assert.deepEqual(await client().testConnection(), {
		ok: false,
		message: "Token 无效或已过期（HTTP 401）",
	});

	setRequestHandler(() => ({ status: 200, json: { success: false, msgCode: "A0211" } }));
	const expired = await client().testConnection();
	assert.equal(expired.ok, false);
	assert.match(expired.message, /A0211/);

	setRequestHandler(() => ({ status: 200, json: { code: 0, data: {} } }));
	assert.deepEqual(await client().testConnection(), { ok: true, message: "连接正常，Token 有效 ✅" });
});

test("testConnection 捕获网络异常", async (t) => {
	t.after(() => setRequestHandler(null));
	setRequestHandler(() => {
		throw new Error("offline");
	});
	const result = await client().testConnection();
	assert.equal(result.ok, false);
	assert.match(result.message, /网络错误/);
});

test("jsonRequest 把错误码翻译成中文提示并带上 Authorization", async (t) => {
	t.after(() => setRequestHandler(null));
	const seen: StubRequest[] = [];

	setRequestHandler((req) => {
		seen.push(req);
		return { status: 200, json: { success: false, msgCode: "A0202" } };
	});
	await assert.rejects(
		() => jsonRequest(client(), "GET", "u"),
		(e: unknown) => e instanceof MineruError && e.code === "A0202" && /Token 无效/.test(e.message),
	);
	assert.equal(seen[0].headers?.Authorization, "Bearer token-ok");
});

test("jsonRequest 处理非 JSON 的 401 与非 2xx", async (t) => {
	t.after(() => setRequestHandler(null));

	setRequestHandler(() => ({ status: 401, text: "<html>nope</html>" }));
	await assert.rejects(
		() => jsonRequest(client(), "GET", "u"),
		(e: unknown) => e instanceof MineruError && e.code === "A0202",
	);

	setRequestHandler(() => ({ status: 500, json: { code: 0, data: {} } }));
	await assert.rejects(
		() => jsonRequest(client(), "GET", "u"),
		(e: unknown) => e instanceof MineruError && e.code === 500 && /HTTP 500/.test(e.message),
	);
});

test("jsonRequest 捕获请求层异常", async (t) => {
	t.after(() => setRequestHandler(null));
	setRequestHandler(() => {
		throw new Error("ECONNREFUSED");
	});
	await assert.rejects(() => jsonRequest(client(), "GET", "u"), /网络请求失败：ECONNREFUSED/);
});

test("getUploadUrls 组装请求体并返回 batch 信息", async (t) => {
	t.after(() => setRequestHandler(null));
	const seen: StubRequest[] = [];
	setRequestHandler((req) => {
		seen.push(req);
		return {
			status: 200,
			json: { code: 0, data: { batch_id: "b1", file_urls: ["https://u1", "https://u2"] } },
		};
	});

	const result = await client().getUploadUrls(
		[
			{ name: "a.pdf", dataId: "a-0" },
			{ name: "b.pdf", dataId: "b-1" },
		],
		{ ...PARAMS, extraFormats: ["docx"] },
	);

	assert.deepEqual(result, { batchId: "b1", urls: ["https://u1", "https://u2"] });
	assert.equal(seen[0].method, "POST");
	assert.ok(seen[0].url.endsWith("/file-urls/batch"));
	assert.deepEqual(JSON.parse(String(seen[0].body)), {
		files: [
			{ name: "a.pdf", data_id: "a-0" },
			{ name: "b.pdf", data_id: "b-1" },
		],
		model_version: "vlm",
		is_ocr: true,
		enable_formula: true,
		enable_table: false,
		language: "ch",
		extra_formats: ["docx"],
	});
});

test("getUploadUrls 空 extra_formats 时不下发该字段", async (t) => {
	t.after(() => setRequestHandler(null));
	const seen: StubRequest[] = [];
	setRequestHandler((req) => {
		seen.push(req);
		return { status: 200, json: { code: 0, data: { batch_id: "b", file_urls: ["u"] } } };
	});
	await client().getUploadUrls([{ name: "a.pdf", dataId: "a" }], PARAMS);
	assert.ok(!("extra_formats" in JSON.parse(String(seen[0].body))));
});

test("getUploadUrls 缺少关键字段时报错", async (t) => {
	t.after(() => setRequestHandler(null));
	setRequestHandler(() => ({ status: 200, json: { code: 0, data: { batch_id: "b" } } }));
	await assert.rejects(() => client().getUploadUrls([{ name: "a", dataId: "a" }], PARAMS), /上传地址申请失败/);
});

test("putFile 优先用 requestUrl，失败回退 fetch", async (t) => {
	t.after(() => setRequestHandler(null));
	let putCalls = 0;
	setRequestHandler(() => {
		putCalls++;
		return { status: 200, text: "" };
	});
	await client().putFile("https://u", new ArrayBuffer(4));
	assert.equal(putCalls, 1);

	setRequestHandler(() => ({ status: 403, text: "" }));
	const fetched: string[] = [];
	stubFetch(t, (url) => {
		fetched.push(url);
		return { ok: true, status: 200 };
	});
	await client().putFile("https://u2", new ArrayBuffer(4));
	assert.deepEqual(fetched, ["https://u2"]);
});

test("pollBatch 全部终态后立即返回", async (t) => {
	t.after(() => setRequestHandler(null));
	const updates: string[][] = [];
	setRequestHandler((req) => {
		assert.ok(req.url.endsWith("/extract-results/batch/b1"));
		return {
			status: 200,
			json: {
				code: 0,
				data: {
					extract_result: [
						{ file_name: "a.pdf", state: "done", full_zip_url: "https://z1" },
						{ file_name: "b.pdf", state: "failed", err_code: "-60002", err_msg: "格式不支持" },
					],
				},
			},
		};
	});

	const results = await client().pollBatch(
		"b1",
		(r) => updates.push(r.map((x) => `${x.fileName}:${x.state}`)),
		{ cancelled: false },
	);
	assert.deepEqual(updates, [["a.pdf:done", "b.pdf:failed"]]);
	assert.equal(results[0].fullZipUrl, "https://z1");
	assert.equal(results[1].errCode, "-60002");
});

test("pollBatch 等待轮询直到终态", { timeout: 10_000 }, async (t) => {
	t.after(() => setRequestHandler(null));
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => t.mock.timers.reset());
	setRequestHandler(
		queue([
			() => ({ code: 0, data: { extract_result: [{ file_name: "a.pdf", state: "running" }] } }),
			() => ({ code: 0, data: { extract_result: [{ file_name: "a.pdf", state: "done" }] } }),
		]),
	);

	const promise = client().pollBatch("b1", () => {}, { cancelled: false });
	await advance(t, 3000);
	const results = await promise;
	assert.equal(results[0].state, "done");
	t.mock.timers.reset();
});

test("pollBatch 取消与超时都抛 MineruError", async (t) => {
	t.after(() => setRequestHandler(null));
	await assert.rejects(
		() => client().pollBatch("b1", () => {}, { cancelled: true }),
		(e: unknown) => e instanceof MineruError && e.code === "CANCELLED",
	);

	setRequestHandler(() => ({
		status: 200,
		json: { code: 0, data: { extract_result: [{ file_name: "a.pdf", state: "running" }] } },
	}));
	await assert.rejects(
		() => client().pollBatch("b1", () => {}, { cancelled: false }, -1),
		(e: unknown) => e instanceof MineruError && e.code === "TIMEOUT",
	);
});

test("downloadZip 优先 requestUrl，失败回退 fetch", async (t) => {
	t.after(() => setRequestHandler(null));
	setRequestHandler(() => ({ status: 200, arrayBuffer: new ArrayBuffer(8) }));
	assert.equal((await client().downloadZip("https://z")).byteLength, 8);

	setRequestHandler(() => {
		throw new Error("blocked");
	});
	stubFetch(t, () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
	assert.equal((await client().downloadZip("https://z2")).byteLength, 4);
});

test("downloadZip fetch 也失败时给出明确错误", async (t) => {
	t.after(() => setRequestHandler(null));
	setRequestHandler(() => ({ status: 500, text: "boom" }));
	stubFetch(t, () => ({ ok: false, status: 500 }));
	await assert.rejects(() => client().downloadZip("https://z3"), /结果下载失败：/);
});