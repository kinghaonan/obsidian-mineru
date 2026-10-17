import { PDFDocument } from "pdf-lib";
import type { PageRange, PdfChunk, SplitOptions } from "../types";

/** 读取 PDF 页数；非 PDF 或损坏文件返回 0 */
export async function countPdfPages(data: ArrayBuffer): Promise<number> {
	try {
		const doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
		return doc.getPageCount();
	} catch {
		return 0;
	}
}

/**
 * 规划切分：按页数均分成若干区间（页码从 1 开始，含首尾）。
 * 页数不超过 maxPages 时返回单个区间。
 */
export function planPageRanges(pageCount: number, maxPages: number): PageRange[] {
	const limit = Math.max(1, Math.floor(maxPages));
	if (pageCount <= 0) return [];
	const total = Math.max(1, Math.ceil(pageCount / limit));
	const ranges: PageRange[] = [];
	const base = Math.ceil(pageCount / total);
	let start = 1;
	for (let i = 0; i < total; i++) {
		const end = Math.min(pageCount, start + base - 1);
		if (end < start) break;
		ranges.push({ index: i + 1, start, end });
		start = end + 1;
	}
	return ranges;
}

/** 是否需要切分（页数或体积超限才切） */
export function needsSplit(
	pageCount: number,
	byteLength: number,
	options: SplitOptions,
): boolean {
	if (!options.enabled) return false;
	if (pageCount > Math.max(1, options.maxPages)) return true;
	return byteLength > Math.max(1, options.maxSizeMB) * 1024 * 1024;
}

/** 切分单个 PDF，返回每个分片的字节与页区间 */
export async function splitPdf(
	data: ArrayBuffer,
	maxPages: number,
	maxSizeMB = Number.POSITIVE_INFINITY,
): Promise<PdfChunk[]> {
	const source = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
	const ranges = planPageRanges(source.getPageCount(), maxPages);
	if (ranges.length <= 1) return [];

	const chunks: PdfChunk[] = [];
	for (const range of ranges) {
		const doc = await PDFDocument.create();
		// copyPages 从 0 开始计数
		const copied = await doc.copyPages(source, indices(range.start, range.end));
		copied.forEach((page) => doc.addPage(page));
		const bytes = await doc.save({ useObjectStreams: true });
		const size = bytes.byteLength;
		if (size > maxSizeMB * 1024 * 1024 && range.end > range.start) {
			// 体积仍然超限：二分该区间后重新合并
			const mid = Math.floor((range.start + range.end) / 2);
			const halves = await splitRange(source, range.start, mid, maxSizeMB);
			const rest = await splitRange(source, mid + 1, range.end, maxSizeMB);
			chunks.push(...halves, ...rest);
			continue;
		}
		chunks.push({
			index: range.index,
			start: range.start,
			end: range.end,
			data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		});
	}
	return chunks;
}

/** 切出一个页区间（体积超限时递归二分） */
async function splitRange(
	source: PDFDocument,
	start: number,
	end: number,
	maxSizeMB: number,
): Promise<PdfChunk[]> {
	if (end < start) return [];
	const doc = await PDFDocument.create();
	const copied = await doc.copyPages(source, indices(start, end));
	copied.forEach((page) => doc.addPage(page));
	const bytes = await doc.save({ useObjectStreams: true });
	if (bytes.byteLength <= maxSizeMB * 1024 * 1024 || start === end) {
		return [
			{
				index: 0,
				start,
				end,
				data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			},
		];
	}
	const mid = Math.floor((start + end) / 2);
	return [...(await splitRange(source, start, mid, maxSizeMB)), ...(await splitRange(source, mid + 1, end, maxSizeMB))];
}

/** 1 起始、闭区间的页码数组 */
function indices(start: number, end: number): number[] {
	const list: number[] = [];
	for (let p = start; p <= end; p++) list.push(p - 1);
	return list;
}