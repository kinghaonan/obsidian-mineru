import { App, FuzzySuggestModal, SuggestModal, TFile } from "obsidian";
import { isConvertiblePath } from "../utils";

/** 单选可转换文件（转换向导用） */
export class FileSuggestModal extends FuzzySuggestModal<TFile> {
	private onPick: (file: TFile) => void;

	constructor(app: App, onPick: (file: TFile) => void) {
		super(app);
		this.onPick = onPick;
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((file) => isConvertiblePath(file.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/** 多选文件：点击列表项切换勾选，点底部「完成」提交 */
export class MultiSelectSuggestModal<T> extends SuggestModal<T> {
	private selected = new Set<string>();
	private submitted = false;

	constructor(
		app: App,
		private options: {
			placeholder: string;
			getItems: () => T[];
			getKey: (item: T) => string;
			getLabel: (item: T) => string;
			onSubmit: (items: T[]) => void;
		},
	) {
		super(app);
		this.setPlaceholder(options.placeholder);
	}

	/** 已勾选数量 */
	get selectionCount(): number {
		return this.selected.size;
	}

	/** 提交并关闭（幂等） */
	submit(): void {
		if (this.submitted) return;
		this.submitted = true;
		const picked = this.options
			.getItems()
			.filter((item) => this.selected.has(this.options.getKey(item)));
		if (picked.length > 0) this.options.onSubmit(picked);
	}

	onOpen(): void {
		super.onOpen();
		const footer = this.modalEl.createDiv({ cls: "mineru-suggest-footer" });
		const countEl = footer.createSpan({ text: "已选 0 个" });
		this.syncFooter = () => countEl.setText(`已选 ${this.selected.size} 个`);
		footer
			.createEl("button", { text: "完成", cls: "mod-cta" })
			.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.submit();
				this.close();
			});
	}

	private syncFooter: (() => void) | null = null;

	onClose(): void {
		// Esc 直接关闭时也提交已勾选项，避免用户白勾一次
		this.submit();
		this.syncFooter = null;
		super.onClose();
	}

	onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {
		// 多选：点击列表项只切换勾选，Enter 不关闭弹窗
	}

	getSuggestions(query: string): T[] {
		const lower = query.toLowerCase();
		return this.options
			.getItems()
			.filter((item) => this.options.getLabel(item).toLowerCase().includes(lower));
	}

	renderSuggestion(item: T, el: HTMLElement): void {
		const key = this.options.getKey(item);
		const row = el.createDiv({ cls: "mineru-suggest-row" });
		row.createSpan({ cls: "mineru-suggest-check", text: this.selected.has(key) ? "☑" : "☐" });
		row.createSpan({ text: this.options.getLabel(item) });
		// 在子节点上阻止冒泡，避免触发 SuggestModal 的关闭行为
		row.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.selected.has(key)) this.selected.delete(key);
			else this.selected.add(key);
			row.querySelector(".mineru-suggest-check")?.setText(this.selected.has(key) ? "☑" : "☐");
			this.syncFooter?.();
		});
	}
}