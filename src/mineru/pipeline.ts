import { App, normalizePath, TFile } from "obsidian";
import { MAX_FILE_SIZE, stateLabel } from "../constants";
import {
	asciiSlug,
	extractZip,
	ensureFolderLevels,
	relativePath,
	sanitizeFileName,
	toArrayBuffer,
} from "../utils";
import { imagesToCenteredHtml, rewriteImageLinks } from "../markdown";
import type { CancelSignal, ConvertOptions, ConvertReport, FileProgress, ZipContents } from "../types";
import type { MineruClient } from "./api";
import { errorMessageFor, MineruError } from "./errors";

const EXTRA_EXT_MAP: Record<string, string> = { docx: "docx", html: "html", latex: "tex" };

/** 完整转换管线：上传 → 轮询 → 解压 → 写入库 */
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
		const report: ConvertReport = { total: files.length, succeeded: 0, failed: 0, results: [] };
		if (files.length === 0) return report;

		// 读取文件并预检大小
		const staged: { file: TFile; data: ArrayBuffer; name: string; basename: string; dataId: string }[] = [];
		for (let i = 0; i < files.length; i++) {
			if (signal.cancelled) throw new MineruError("转换已取消", "CANCELLED");
			const file = files[i];
			const data = await this.app.vault.readBinary(file);
			if (data.byteLength > MAX_FILE_SIZE) {
				report.failed++;
				report.results.push({ fileName: file.name, error: "文件超过 200MB 上限，请拆分后重试" });
				continue;
			}
			staged.push({
				file,
				data,
				name: file.name,
				basename: file.basename,
				dataId: `${asciiSlug(file.basename)}-${i}`,
			});
		}
		if (staged.length === 0) return report;

		// 申请上传地址；附加格式不被支持（-500）时自动降级
		let batchId: string;
		let urls: string[];
		let extraFormatsOk = true;
		try {
			const result = await this.client.getUploadUrls(
				staged.map((f) => ({ name: f.name, dataId: f.dataId })),
				options.params,
			);
			batchId = result.batchId;
			urls = result.urls;
		} catch (e) {
			if (
				options.params.extraFormats.length > 0 &&
				e instanceof MineruError &&
				e.code === -500
			) {
				const retry = await this.client.getUploadUrls(
					staged.map((f) => ({ name: f.name, dataId: f.dataId })),
					{ ...options.params, extraFormats: [] },
				);
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
			onProgress({ fileName: item.name, state: "uploading" });
			await this.client.putFile(urls[i], item.data);
		}

		// 轮询结果
		const pollResults = await this.client.pollBatch(
			batchId,
			(results) => {
				for (const r of results) {
					if (r.state === "done") {
						onProgress({ fileName: r.fileName, state: "done" });
					} else if (r.state === "failed") {
						onProgress({ fileName: r.fileName, state: "failed", detail: r.errMsg });
					} else {
						onProgress({ fileName: r.fileName, state: "parsing", detail: stateLabel(r.state) });
					}
				}
			},
			signal,
		);
		const byName = new Map<string, (typeof pollResults)[number]>();
		for (const r of pollResults) byName.set(r.fileName, r);

		// 逐个下载解压并写库
		for (const item of staged) {
			if (signal.cancelled) throw new MineruError("转换已取消", "CANCELLED");
			const result = byName.get(item.name);
			if (!result || result.state !== "done" || !result.fullZipUrl) {
				const detail =
					result?.errMsg ||
					(result?.errCode !== undefined ? errorMessageFor(result.errCode) : "");
				report.failed++;
				report.results.push({ fileName: item.name, error: detail || "解析失败，未获得结果" });
				continue;
			}
			try {
				const zip = await this.client.downloadZip(result.fullZipUrl);
				const contents = await extractZip(zip, extraFormatsOk ? options.params.extraFormats : []);
				const written = await this.writeResult(item.file, item.basename, contents, options);
				report.succeeded++;
				report.results.push({
					fileName: item.name,
					outputPath: written.outputPath,
					images: written.imageCount,
					extras: written.extraCount,
				});
			} catch (e) {
				report.failed++;
				report.results.push({
					fileName: item.name,
					error: e instanceof MineruError ? e.message : String(e instanceof Error ? e.message : e),
				});
			}
		}
		return report;
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

	async writeResult(
		sourceFile: TFile,
		basename: string,
		contents: ZipContents,
		options: ConvertOptions,
	): Promise<{ outputPath: string; imageCount: number; extraCount: number }> {
		const vault = this.app.vault;
		const outDir = normalizePath(options.outputFolder);
		await this.ensureFolder(outDir);

		let safeName = sanitizeFileName(basename);
		let outputPath = normalizePath(`${outDir}/${safeName}.md`);
		if (vault.getAbstractFileByPath(outputPath)) {
			let n = 1;
			do {
				safeName = `${sanitizeFileName(basename)} (${n++})`;
				outputPath = normalizePath(`${outDir}/${safeName}.md`);
			} while (vault.getAbstractFileByPath(outputPath));
		}

		let markdown = contents.markdown;
		let imageCount = 0;

		if (options.downloadImages && contents.images.length > 0) {
			const imageDir = normalizePath(
				options.imageFolder.trim() ? options.imageFolder : `${outDir}/${safeName}.assets`,
			);
			await ensureFolderLevels(vault, imageDir);
			const urlMap = new Map<string, string>();
			for (const image of contents.images) {
				const binPath = normalizePath(`${imageDir}/${image.relPath}`);
				await vault.createBinary(binPath, toArrayBuffer(image.data));
				const relative = relativePath(outDir, binPath);
				urlMap.set(image.relPath, relative);
				urlMap.set(`images/${image.relPath}`, relative);
				imageCount++;
			}
			markdown = rewriteImageLinks(markdown, urlMap);
		}

		if (options.convertImageToHtml) {
			markdown = imagesToCenteredHtml(markdown, options.imageWidth, options.showImageFilename);
		}

		await vault.create(outputPath, markdown);

		let extraCount = 0;
		for (const extra of contents.extras) {
			const ext = EXTRA_EXT_MAP[extra.format] ?? extra.format;
			await vault.createBinary(
				normalizePath(`${outDir}/${safeName}.${ext}`),
				toArrayBuffer(extra.data),
			);
			extraCount++;
		}

		return { outputPath, imageCount, extraCount };
	}
}
