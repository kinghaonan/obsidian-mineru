/**
 * 按空行分段，聚合为不超过 maxChars 的块；
 * 超长段落按行二次拆分。
 */
export function chunkText(text: string, maxChars: number): string[] {
	const paragraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = "";

	const push = (paragraph: string) => {
		const combined = current ? `${current}\n\n${paragraph}` : paragraph;
		if (combined.length > maxChars && current) {
			chunks.push(current);
			current = paragraph;
		} else {
			current = combined;
		}
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length <= maxChars) {
			push(paragraph);
		} else {
			const lines = paragraph.split(/\n/);
			let buffer = "";
			for (const line of lines) {
				const combined = buffer ? `${buffer}\n${line}` : line;
				if (combined.length > maxChars && buffer) {
					push(buffer);
					buffer = line;
				} else {
					buffer = combined;
				}
			}
			if (buffer) push(buffer);
		}
	}

	if (current.trim()) chunks.push(current);
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * 把一段文本拆成大致对半的两份（优先按空行边界），
 * 用于输出截断时的递归二分重译。
 */
export function splitInTwo(text: string): [string, string] {
	const half = Math.floor(text.length / 2);
	const paragraphs = text.split(/\n{2,}/);
	let acc = "";
	let splitIndex = 0;
	for (; splitIndex < paragraphs.length; splitIndex++) {
		const combined = acc ? `${acc}\n\n${paragraphs[splitIndex]}` : paragraphs[splitIndex];
		if (combined.length > half && acc) break;
		acc = combined;
	}
	if (!acc) {
		const lines = text.split(/\n/);
		const cut = Math.max(1, Math.floor(lines.length / 2));
		return [lines.slice(0, cut).join("\n"), lines.slice(cut).join("\n")];
	}
	return [acc, paragraphs.slice(splitIndex).join("\n\n")];
}
