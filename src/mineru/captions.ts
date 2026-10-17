/**
 * 图注（figure caption）识别。
 *
 * 目标：从 MinerU 产出的 Markdown 中，为每张图片找到它的图注，
 * 并据此重命名图片文件、在 HTML 图注区展示图注文本。
 *
 * 识别范围（对应「B 档」）：
 * 1) 图注紧邻图片（下方或上方）—— 主流学术排版
 * 2) 子图组合：多张连续图片共用一个图注（中间夹子标签行，如 `c) ...`）
 *
 * 防误判（关键）：
 * 正文里出现「Figure 3.1 shows that ...」且恰好紧跟在图片后面时，
 * 不能把它当成图注。因此要求——**图注必须与至少一张图片同属一个段落
 * （中间无空行）**；跨空行的多图聚合，仅在图片之间存在子标签行时才成立。
 * 真实子图排版示例：
 *
 *     ![](a.jpg)          ← 子图 a
 *                          （空行）
 *     c) Maximum energy   ← 标签在**后一张图之前**
 *     ![](c.jpg)
 *     Fig. 4.9 Special cases of ...   ← 整组图注
 */

export interface FigureCaption {
	/** 图号原文，如 "1.2" / "P1.4" */
	number: string;
	/** 图注正文（不含图号前缀） */
	text: string;
	/** 图注相对图片的位置 */
	position: "below" | "above";
	/** 图注所在行下标，用于删除原文行 */
	line: number;
}

export interface SubFigure {
	/** 子标签文本，如 "c) Maximum energy case" */
	label: string;
	/** 所属图组的图号 */
	number: string;
}

export interface CaptionAnalysis {
	/** 图片 URL（Markdown 中的原始目标）→ 图注 */
	captions: Map<string, FigureCaption>;
	/** 子图：图片 URL → 标签与所属图号（同一图注下的非主图） */
	subLabels: Map<string, SubFigure>;
	/** 需要从原文删除的行下标（图注行 + 子标签行） */
	removableLines: Set<number>;
}

/** 图注行：Fig./Figure/图 + 图号，支持 1.2 / 1-2 / P1.4 / A1.2 */
const CAPTION_RE =
	/^\s*(?:\*\*|__)?\s*(fig(?:ure)?s?\.?|图表?|图片?|插图)\s*[\.:]?\s*([A-Za-z]?\d+(?:[.\-–]\d+)*)\s*(?:[\.\):：–—-])?\s*(.*)$/i;

/** 子图标签行：a) / (a) / a. / a、 等 */
const SUB_LABEL_RE = /^\s*(?:\(([a-z])\)|([a-z])[).、])\s*(\S.*)$/i;

/** Markdown 图片链接 / HTML <img> */
const IMAGE_LINE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)|<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/i;

/** 图注长度上限，超出视为正文误判 */
const MAX_CAPTION_LENGTH = 200;

/** 单个图组的最大回溯/前瞻行数与图片数，防止误判后失控 */
const MAX_SCAN_LINES = 60;
const MAX_GROUP_IMAGES = 12;

function matchImageUrl(line: string): string | null {
	const m = IMAGE_LINE_RE.exec(line);
	if (!m) return null;
	return (m[1] ?? m[2] ?? "").replace(/^<|>$/g, "");
}

function matchCaption(line: string, lineIndex: number): FigureCaption | null {
	const m = CAPTION_RE.exec(line);
	if (!m) return null;
	if (line.length > MAX_CAPTION_LENGTH) return null;
	const text = (m[3] ?? "").trim();
	// 只有图号没有文字的（如 "Fig. 1"）不视为图注
	if (!text) return null;
	return { number: m[2], text, position: "below", line: lineIndex };
}

function matchSubLabel(line: string): string | null {
	const m = SUB_LABEL_RE.exec(line);
	return m ? line.trim() : null;
}

/** 图注所在段落的起始行（上一个空行之后） */
function paragraphStart(lines: string[], from: number): number {
	let s = from;
	while (s > 0 && lines[s - 1].trim() !== "") s--;
	return s;
}

/**
 * 收集图注关联的图片：从 captionLine 出发向上/向下扫描，
 * 允许穿过空行与子标签行，遇到其他正文即停止。
 */
function collectImages(
	lines: string[],
	captionLine: number,
	direction: 1 | -1,
): { images: { line: number; url: string }[]; labels: { line: number; text: string }[] } {
	const images: { line: number; url: string }[] = [];
	const labels: { line: number; text: string }[] = [];
	const limit = direction === -1 ? Math.max(0, captionLine - MAX_SCAN_LINES) : captionLine;
	const end = direction === 1 ? Math.min(lines.length - 1, captionLine + MAX_SCAN_LINES) : captionLine;

	for (let k = captionLine + direction; direction === -1 ? k >= limit : k <= end; k += direction) {
		const url = matchImageUrl(lines[k]);
		if (url) {
			if (images.length >= MAX_GROUP_IMAGES) break;
			images.push({ line: k, url });
			continue;
		}
		const label = matchSubLabel(lines[k]);
		if (label) {
			labels.push({ line: k, text: label });
			continue;
		}
		if (lines[k].trim() === "") continue; // 空行可跨越
		break; // 其他正文 → 停止
	}
	if (direction === -1) {
		images.reverse();
		labels.reverse();
	}
	return { images, labels };
}

/**
 * 分析图注。返回每张图片的图注、子图标签，以及应当从原文移除的行。
 */
export function analyzeCaptions(markdown: string): CaptionAnalysis {
	const captions = new Map<string, FigureCaption>();
	const subLabels = new Map<string, SubFigure>();
	const removableLines = new Set<number>();
	const lines = markdown.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const raw = matchCaption(lines[i], i);
		if (!raw) continue;

		// 优先向上找（图注在图下方）；找不到再向下找（图注在图上方）
		const back = collectImages(lines, i, -1);
		const fwd = collectImages(lines, i, 1);
		const sameParagraph = (
			items: { line: number; url: string }[],
			anchor: number,
		): { line: number; url: string }[] => {
			const start = paragraphStart(lines, anchor);
			return items.filter((it) => it.line >= start);
		};

		const backSame = sameParagraph(back.images, i);
		const fwdSame = sameParagraph(fwd.images, i);

		let position: "below" | "above" = "below";
		let pool = back.images;
		let labels = back.labels;
		let group: { line: number; url: string }[] = [];

		if (backSame.length > 0) {
			// 图注在下方：从最近图片开始，逐张向外扩展（需有子标签相连）
			const start = paragraphStart(lines, i);
			group = [];
			let boundary = i; // 当前已纳入的最近位置
			for (let k = back.images.length - 1; k >= 0; k--) {
				const img = back.images[k];
				const connected = img.line >= start || labels.some((l) => l.line > img.line && l.line < boundary);
				if (!connected) break;
				group.unshift(img);
				boundary = img.line;
			}
		} else if (fwdSame.length > 0) {
			// 图注在上方：图注归属其后第一张图片
			position = "above";
			group = [fwdSame[0]];
			pool = fwd.images;
			labels = fwd.labels;
		}

		if (group.length === 0) continue; // 没有同段落图片 → 视为正文引用，丢弃

		const primary = group[0];
		captions.set(primary.url, { ...raw, position });
		removableLines.add(i);

		// 组内其余图片：取「上一张图」与「本张图」之间的子标签
		for (let g = 1; g < group.length; g++) {
			const prev = group[g - 1].line;
			const cur = group[g].line;
			const label = labels.find((l) => l.line > prev && l.line < cur);
			if (label) {
				subLabels.set(group[g].url, { label: label.text, number: raw.number });
				removableLines.add(label.line);
			}
		}
		void pool;
	}

	return { captions, subLabels, removableLines };
}

/**
 * 用图注生成文件名：`Fig.1.2-The-cylindrical-coordinate-system.jpg`
 * number 为空或 text 为空时返回空串（表示沿用原名）。
 */
export function captionFileName(number: string, text: string): string {
	const num = number.trim();
	if (!num) return "";
	const slug = text
		.trim()
		.replace(/[*_`"'“”‘’]/g, "")
		.replace(/\s+/g, "-")
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	const base = `Fig.${num}${slug ? `-${slug}` : ""}`;
	// 文件名总长控制（含扩展名）
	const trimmed = base.slice(0, 80);
	return `${trimmed}.jpg`;
}

/** 子图（无独立图注、仅有标签）的文件名：`Fig.4.9-c-Maximum-energy-case` 或 `Fig.4.9-2` */
export function subLabelFileName(number: string, label?: string, index = 0): string {
	const num = number.trim() || String(index + 1);
	if (!label) return `Fig.${num}-${index + 1}.jpg`;
	const slug = label
		.replace(/^\(?[a-z]\)?[).、]?\s*/i, "")
		.replace(/\s+/g, "-")
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 70); // 子标签可能是一整句说明，限制长度避免文件名过长
	return `Fig.${num}-${slug || index + 1}.jpg`;
}