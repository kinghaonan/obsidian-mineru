import { App, normalizePath, TFile } from "obsidian";
import { MAX_FILE_SIZE, stateLabel } from "../constants";
import {
	asciiSlug,
	assetFolderName,
	encodeLinkUrl,
	extractZip,
	ensureFolderLevels,
	relativePath,
	sanitizeFileName,
	toArrayBuffer,
} from "../utils";
import { imagesToCenteredHtml, rewriteImageLinks, dropLines } from "../markdown";
import { analyzeCaptions, captionFileName, subLabelFileName, type CaptionAnalysis } from "./captions";
import type {
	CancelSignal,
	ConvertOptions,
	ConvertReport,
	FileProgress,
	MergedPart,
	PdfChunk,
	ZipContents,
} from "../types";
import type { MineruClient } from "./api";
import { errorMessageFor, MineruError } from "./errors";
import { mergeParts } from "./merge";
import { countPdfPages, needsSplit, splitPdf } from "./split";

const EXTRA_EXT_MAP: Record<string, string> = { docx: "docx", html: "html", latex: "tex" };

/** 待上传的一个条目：未切分时 partIndex = 0 */
interface StagedItem {
	source: TFile;
	data: ArrayBuffer;
	uploadName: string;
	basename: string;
	dataId: string;
	partIndex: number;
	partsTotal: number;
	startPage: number;
	endPage: number;
}

/** 转换管线：上传 → 轮询 → 解压 → （分片合并）→ 写入库 */
export class ConversionPipeline {
	constructor(
		private app: App,
		private client: MineruClient,
		private getSettings: () => { mineruApiToken: string },
	) {}

	async convertFiles(
		files: TFile[],
		options: ConvertOptions,
		onProgress: (progress: FileProgress) => void,
		signal: CancelSignal,
	): Promise<ConvertReport> {
		if (!this.getSettings().mineruApiToken) {
			throw new MineruError("请先在设置中配置 MinerU API Token");
		}
		const report: ConvertReport = {
			total: files.length,
			succeeded: 0,
			failed: 0,
			skipped: 0,
			results: [],
		};
		if (files.length === 0) return report;

		// 读取文件；超大 PDF 尝试切分后再上传
		const staged: StagedItem[] = [];
		const groups = new Map<TFile, StagedItem[]>();
		for (let i = 0; i < files.length; i++) {
			if (signal.cancelled) throw new MineruError("转换已取消", "CANCELLED");
			const file = files[i];
			const data = await this.app.vault.readBinary(file);
			const items = await this.stage(file, data, i, options, report);
			groups.set(file, items);
			staged.push(...items);
		}
		if (staged.length === 0) return report;

		// 申请上传地址；附加格式不被支持（-500）时自动降级
		let batchId: string;
		let urls: string[];
		let extraFormatsOk = true;
		const targets = staged.map((f) => ({ name: f.uploadName, dataId: f.dataId }));
		try {
			const result = await this.client.getUploadUrls(targets, options.params);
			batchId = result.batchId;
			urls = result.urls;
		} catch (e) {
			if (
				options.params.extraFormats.length > 0 &&
				e instanceof MineruError &&
				e.code === -500
			) {
				const retry = await this.client.getUploadUrls(targets, {
					...options.params,
					extraFormats: [],
				});
				batchId = retry.batchId;
				urls = retry.urls;
				extraFormatsOk = false;
			} else {
				throw e;
			}
		}

		// 上传
		for (let i = 0; i < staged.length; i++) {
			if (signal.cancelled) throw new MineruError("转换已取消", "CANCELLED");
			const item = staged[i];
			onProgress({
				fileName: item.source.name,
				state: "uploading",
				part: item.partsTotal > 1 ? `${item.partIndex}/${item.partsTotal} 分片` : undefined,
			});
			await this.client.putFile(urls[i], item.data);
		}

		// 轮询结果
		const pollResults = await this.client.pollBatch(
			batchId,
			(results) => {
				const byName = new Map<string, (typeof results)[number]>();
				for (const r of results) byName.set(r.fileName, r);
				for (const item of staged) {
					const r = byName.get(item.uploadName);
					if (!r) continue;
					if (r.state === "done") {
						onProgress({ fileName: item.source.name, state: "done", part: partLabel(item) });
					} else if (r.state === "failed") {
						onProgress({
							fileName: item.source.name,
							state: "failed",
							detail: r.errMsg,
							part: partLabel(item),
						});
					} else {
						onProgress({
							fileName: item.source.name,
							state: "parsing",
							detail: stateLabel(r.state),
							part: partLabel(item),
						});
					}
				}
			},
			signal,
		);
		const byName = new Map<string, (typeof pollResults)[number]>();
		for (const r of pollResults) byName.set(r.fileName, r);

		// 按源文件归组：逐个下载解压（分片则合并）后写库
		for (const [, items] of groups) {
			if (signal.cancelled) throw new MineruError("转换已取消", "CANCELLED");
			const source = items[0].source;
			try {
				const contents = await this.collectContents(
					items,
					byName,
					extraFormatsOk ? options.params.extraFormats : [],
					options.split.dedupeTitle,
				);
				if (!contents) {
					report.failed++;
					report.results.push({
						fileName: source.name,
						error: this.describeFailure(items, byName),
					});
					continue;
				}
				const written = await this.writeResult(source, items[0].basename, contents, options);
				if (written.skipped) {
					report.skipped++;
					report.results.push({
						fileName: source.name,
						outputPath: written.outputPath,
						skipped: true,
						parts: items[0].partsTotal,
					});
					continue;
				}
				report.succeeded++;
				report.results.push({
					fileName: source.name,
					outputPath: written.outputPath,
					images: written.imageCount,
					extras: written.extraCount,
					parts: items[0].partsTotal,
				});
			} catch (e) {
				report.failed++;
				report.results.push({
					fileName: source.name,
					error: e instanceof MineruError ? e.message : String(e instanceof Error ? e.message : e),
					parts: items[0].partsTotal,
				});
			}
		}
		return report;
	}

	/** 读取单个文件并生成待上传条目（必要时切分 PDF） */
	private async stage(
		file: TFile,
		data: ArrayBuffer,
		order: number,
		options: ConvertOptions,
		report: ConvertReport,
	): Promise<StagedItem[]> {
		const basename = file.basename;
		const splitable = options.split.enabled && file.extension === "pdf";

		if (splitable) {
			const pageCount = await countPdfPages(data);
			const overPages = needsSplit(pageCount, data.byteLength, options.split);
			const overSize =
				options.split.enabled &&
				data.byteLength > Math.min(options.split.maxSizeMB, 200) * 1024 * 1024;
			if (overPages || (overSize && pageCount > 1)) {
				const sizeLimitMB = Math.min(Math.max(1, options.split.maxSizeMB), 200);
				const chunks = await this.safeSplit(data, options.split.maxPages, sizeLimitMB);
				if (chunks.length > 1) {
					return chunks.map((chunk) => this.chunkToItem(file, chunk, chunks.length, order));
				}
			}
		}

		if (data.byteLength > MAX_FILE_SIZE) {
			report.failed++;
			report.results.push({
				fileName: file.name,
				error:
					file.extension === "pdf"
						? "文件超过 200MB 上限且无法切分，请先在设置中开启“大文件自动切分”或手动拆分"
						: "文件超过 200MB 上限，请拆分后重试",
			});
			return [];
		}

		return [
			{
				source: file,
				data,
				uploadName: file.name,
				basename,
				dataId: `${asciiSlug(basename)}-${order}`,
				partIndex: 0,
				partsTotal: 1,
				startPage: 0,
				endPage: 0,
			},
		];
	}

	/** 切分失败（加密/损坏等）时返回空数组，交由调用方按整文件处理 */
	private async safeSplit(data: ArrayBuffer, maxPages: number, sizeLimitMB: number): Promise<PdfChunk[]> {
		try {
			return await splitPdf(data, maxPages, sizeLimitMB);
		} catch {
			return [];
		}
	}

	private chunkToItem(file: TFile, chunk: PdfChunk, total: number, order: number): StagedItem {
		const basename = file.basename;
		const suffix = `__p${chunk.index}-${chunk.start}-${chunk.end}`;
		return {
			source: file,
			data: chunk.data,
			uploadName: `${basename}${suffix}.pdf`,
			basename,
			dataId: `${asciiSlug(basename)}-${order}-${chunk.index}`,
			partIndex: chunk.index,
			partsTotal: total,
			startPage: chunk.start,
			endPage: chunk.end,
		};
	}

	/** 下载并解压一个源文件的全部条目；分片时合并 */
	private async collectContents(
		items: StagedItem[],
		byName: Map<string, { state: string; fullZipUrl?: string; errMsg?: string; errCode?: string | number }>,
		extraFormats: string[],
		dedupeTitle: boolean,
	): Promise<ZipContents | null> {
		const parts: MergedPart[] = [];
		const extras: ZipContents["extras"] = [];

		for (const item of items) {
			const result = byName.get(item.uploadName);
			if (!result || result.state !== "done" || !result.fullZipUrl) return null;
			const zip = await this.client.downloadZip(result.fullZipUrl);
			const contents = await extractZip(zip, extraFormats);
			if (items.length > 1) {
				parts.push({ markdown: contents.markdown, images: contents.images, start: item.startPage, end: item.endPage });
			} else {
				return contents;
			}
		}

		if (parts.length === 0) return null;
		const merged = mergeParts(parts, { dedupeTitle });
		return { markdown: merged.markdown, images: merged.images, extras };
	}

	/** 汇总分片失败原因 */
	private describeFailure(
		items: StagedItem[],
		byName: Map<string, { state: string; errMsg?: string; errCode?: string | number }>,
	): string {
		const failed = items
			.map((item) => ({ item, result: byName.get(item.uploadName) }))
			.filter(({ result }) => !result || result.state !== "done");
		if (failed.length === 0) return "解析失败，未获得结果";
		const first = failed[0];
		const detail =
			first.result?.errMsg ||
			(first.result?.errCode !== undefined ? errorMessageFor(first.result.errCode) : "");
		const where =
			first.item.partsTotal > 1 ? `（分片 ${first.item.partIndex}/${first.item.partsTotal}，第 ${first.item.startPage}-${first.item.endPage} 页）` : "";
		const suffix = failed.length > 1 ? `，另有 ${failed.length - 1} 个分片失败` : "";
		return `${detail || "解析失败，未获得结果"}${where}${suffix}`;
	}

	private async ensureFolder(folder: string): Promise<void> {
		const path = normalizePath(folder);
		if (path && !this.app.vault.getAbstractFileByPath(path)) {
			try {
				await this.app.vault.createFolder(path);
			} catch {
				// 已存在
			}
		}
	}

	/** 写入（或覆盖）二进制文件 */
	private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, data);
			return;
		}
		await this.app.vault.createBinary(path, data);
	}

	/** 写入（或覆盖）文本文件 */
	private async writeText(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}
		await this.app.vault.create(path, content);
	}

	async writeResult(
		sourceFile: TFile,
		basename: string,
		contents: ZipContents,
		options: ConvertOptions,
	): Promise<{ outputPath: string; imageCount: number; extraCount: number; skipped: boolean }> {
		const vault = this.app.vault;
		const outDir = normalizePath(options.outputFolder);
		await this.ensureFolder(outDir);

		let safeName = sanitizeFileName(basename);
		let outputPath = normalizePath(`${outDir}/${safeName}.md`);
		let existing = vault.getAbstractFileByPath(outputPath);
		if (existing) {
			if (options.collisionPolicy === "skip") {
				return { outputPath, imageCount: 0, extraCount: 0, skipped: true };
			}
			if (options.collisionPolicy === "rename") {
				let n = 1;
				do {
					safeName = `${sanitizeFileName(basename)} (${n++})`;
					outputPath = normalizePath(`${outDir}/${safeName}.md`);
					existing = vault.getAbstractFileByPath(outputPath);
				} while (existing);
			}
		}

		let markdown = contents.markdown;
		let imageCount = 0;

		// 先按图注给图片重新命名，再决定落盘路径
		const captions = analyzeCaptions(markdown);
		const renameMap =
			options.imageCaptionNaming === false ? new Map<string, string>() : buildRenameMap(captions);
		const urlMap = new Map<string, string>();

		if (options.downloadImages && contents.images.length > 0) {
			// 目录名要做链接安全化：文档名里的空格/括号会让 ![](路径) 在 Markdown 中截断
			const defaultFolder = assetFolderName(basename);
			const imageDir = normalizePath(
				options.imageFolder.trim() ? options.imageFolder : `${outDir}/${defaultFolder}`,
			);
			await ensureFolderLevels(vault, imageDir);
			for (const image of contents.images) {
				const relName = image.relPath.replace(/\\/g, "/");
				const renamed = renameMap.get(relName) ?? relName;
				const binPath = normalizePath(`${imageDir}/${renamed}`);
				await this.writeBinary(binPath, toArrayBuffer(image.data));
				// 链接目标做百分号编码，空格/括号等在 Markdown 里才不会被截断
				const relative = encodeLinkUrl(relativePath(outDir, binPath));
				urlMap.set(image.relPath, relative);
				urlMap.set(`images/${image.relPath}`, relative);
				urlMap.set(relName, relative);
				urlMap.set(renamed, relative);
				imageCount++;
			}
			markdown = rewriteImageLinks(markdown, urlMap);
		}

		// 原始图注行已被搬进 HTML 图注区，移除避免重复显示
		if (options.removeCaptionLines !== false && captions.removableLines.size > 0) {
			markdown = dropLines(markdown, captions.removableLines);
		}

		if (options.convertImageToHtml) {
			const display = options.showFigureCaption === false ? undefined : captionMap(captions, urlMap);
			markdown = imagesToCenteredHtml(markdown, options.imageWidth, options.showImageFilename, display);
		}

		await this.writeText(outputPath, markdown);

		let extraCount = 0;
		for (const extra of contents.extras) {
			const ext = EXTRA_EXT_MAP[extra.format] ?? extra.format;
			await this.writeBinary(normalizePath(`${outDir}/${safeName}.${ext}`), toArrayBuffer(extra.data));
			extraCount++;
		}

		return { outputPath, imageCount, extraCount, skipped: false };
	}
}

function partLabel(item: StagedItem): string | undefined {
	return item.partsTotal > 1 ? `${item.partIndex}/${item.partsTotal} 分片` : undefined;
}

/**
 * 依据图注生成「原始名 → 新文件名」映射。
 * 主图用 `Fig.1.2-标题`，子图用 `Fig.1.2-c-标签` / `Fig.1.2-2`。
 * 同名冲突时追加 `-2`、`-3`。
 */
function buildRenameMap(captions: CaptionAnalysis): Map<string, string> {
	const map = new Map<string, string>();
	const used = new Set<string>();
	/** 登记时同时写裸名与 images/ 前缀名，保证两种引用写法都能命中 */
	const put = (url: string, name: string) => {
		const unique = uniqueName(name, used);
		map.set(url, unique);
		map.set(url.replace(/^images\//, ""), unique);
	};

	// 子图先占位（短名），主图优先拿到完整名
	for (const [url, sub] of captions.subLabels) {
		put(url, subLabelFileName(sub.number, sub.label, 0).replace(/\.jpg$/, ""));
	}
	for (const [url, caption] of captions.captions) {
		const fileName = captionFileName(caption.number, caption.text);
		if (!fileName) continue;
		put(url, fileName.replace(/\.jpg$/, ""));
	}
	return map;
}

/** 名字去重：同名时追加 -2/-3… */
function uniqueName(stem: string, used: Set<string>): string {
	if (!used.has(stem)) {
		used.add(stem);
		return `${stem}.jpg`;
	}
	let n = 2;
	while (used.has(`${stem}-${n}`)) n++;
	const name = `${stem}-${n}`;
	used.add(name);
	return `${name}.jpg`;
}

/**
 * 图注 URL → 展示文本（供 HTML 图注区使用）。
 * 需要用 urlMap 把「原始 URL」翻译成「最终链接」，否则图片改写后匹配不上。
 */
function captionMap(captions: CaptionAnalysis, urlMap: Map<string, string>): Map<string, string> {
	const map = new Map<string, string>();
	const resolve = (url: string) => urlMap.get(url) ?? urlMap.get(`images/${url}`) ?? url;

	for (const [url, caption] of captions.captions) {
		map.set(resolve(url), `Fig. ${caption.number} ${caption.text}`);
	}
	for (const [url, sub] of captions.subLabels) {
		map.set(resolve(url), sub.label);
	}
	return map;
}