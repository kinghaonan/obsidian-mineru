import { App, FuzzySuggestModal, TFile } from "obsidian";
import { isConvertiblePath } from "../utils";

/** 模糊搜索选择待转换文件（仅列出支持转换的扩展名） */
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
