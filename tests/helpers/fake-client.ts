import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import type { ConvertOptions } from "../../src/types";
import type { MineruClient } from "../../src/mineru/api";

export interface FakeClientOptions {
	/** 第 n 次申请上传地址时额外抛出的错误（用于测试降级重试） */
	failUploadAttempt?: { attempt: number; error: unknown };
	/** 固定返回的 zip（不区分文件） */
	zip?: Uint8Array;
	/** 自定义 pollBatch 结果 */
	pollOverride?: (targets: string[]) => { fileName: string; state: string; fullZipUrl?: string; errMsg?: string }[];
}

export interface FakeClient {
	client: MineruClient;
	calls: {
		uploadRequests: ConvertOptions["params"][];
		targets: string[];
		put: string[];
		poll: number;
	};
}

/**
 * 假 MinerU 客户端：记住申请上传时的文件名，轮询时逐一回 done，
 * 下载时按文件名生成对应的结果 zip（分片名 xxx__p1-1-4.pdf 会生成对应分片内容）。
 */
export function fakeClient(opts: FakeClientOptions = {}): FakeClient {
	const calls = {
		uploadRequests: [] as ConvertOptions["params"][],
		targets: [] as string[],
		put: [] as string[],
		poll: 0,
	};
	const client = {
		async getUploadUrls(files: { name: string }[], params: ConvertOptions["params"]) {
			calls.uploadRequests.push(params);
			calls.targets = files.map((f) => f.name);
			if (opts.failUploadAttempt && opts.failUploadAttempt.attempt === calls.uploadRequests.length) {
				throw opts.failUploadAttempt.error;
			}
			return { batchId: "batch-1", urls: calls.targets.map((_, i) => `https://up/${i}`) };
		},
		async putFile(url: string) {
			calls.put.push(url);
		},
		async pollBatch(_id: string, onUpdate: (r: unknown[]) => void) {
			calls.poll++;
			// 先播报解析中，再播报终态（贴近真实轮询）
			onUpdate(calls.targets.map((name) => ({ fileName: name, state: "running" })));
			const results = (
				opts.pollOverride?.(calls.targets) ??
				calls.targets.map((name) => ({
					fileName: name,
					state: "done",
					fullZipUrl: `https://zip/${encodeURIComponent(name)}`,
				}))
			);
			onUpdate(results);
			return results;
		},
		async downloadZip(url: string) {
			const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
			const zip = opts.zip ?? (await buildZip(name));
			return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
		},
	};
	return { client: client as unknown as MineruClient, calls };
}

/** 生成一个结果 zip；分片名 xxx__p1-1-4.pdf 返回该分片的独立内容 */
export async function buildZip(name = "报告.pdf"): Promise<Uint8Array> {
	const zip = new JSZip();
	const part = /__p(\d+)-(\d+)-(\d+)\.pdf$/.exec(name);
	if (part) {
		zip.file("out/full.md", `分片${part[1]} 第${part[2]}-${part[3]}页 ![图](images/1.jpg)`);
		zip.file("out/images/1.jpg", new Uint8Array([Number(part[1])]));
		return zip.generateAsync({ type: "uint8array" });
	}
	zip.file("报告/full.md", "# 标题\n\n![图](images/1.jpg)");
	zip.file("报告/images/1.jpg", new Uint8Array([9, 8, 7]));
	zip.file("报告/文稿.docx", "docx-bytes");
	zip.file("报告/文稿.tex", "tex-bytes");
	return zip.generateAsync({ type: "uint8array" });
}

/** 生成指定页数的空白 PDF */
export async function makePdf(pages: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
	return doc.save();
}