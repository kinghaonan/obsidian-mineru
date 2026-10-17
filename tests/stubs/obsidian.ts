/**
 * obsidian 模块的最小实现（仅供单元测试使用）。
 * esbuild 在打包测试时把 "obsidian" 指向本文件，因此这里只需提供
 * 被 src/ 引用到的 API。
 */

/* ------------------------------------------------------------------ 路径 */

export function normalizePath(path: string): string {
	return path
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "")
		.replace(/ | /g, " ");
}

/* ------------------------------------------------------------------ 文件 */

export class TAbstractFile {
	path = "";
	parent: TFolder | null = null;
	vault: unknown = null;
	/** 派生属性：由 path 计算，测试里只赋值 path */
	get name(): string {
		const slash = this.path.lastIndexOf("/");
		return slash >= 0 ? this.path.slice(slash + 1) : this.path;
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/" || this.path === "";
	}
}

export class TFile extends TAbstractFile {
	stat = { ctime: 0, mtime: 0, size: 0 };

	get basename(): string {
		const dot = this.name.lastIndexOf(".");
		return dot > 0 ? this.name.slice(0, dot) : this.name;
	}

	get extension(): string {
		const dot = this.name.lastIndexOf(".");
		return dot > 0 ? this.name.slice(dot + 1).toLowerCase() : "";
	}
}

/* ---------------------------------------------------------------- Notice */

export interface RecordedNotice {
	message: string;
	duration?: number;
}

const notices: RecordedNotice[] = [];

export class Notice {
	constructor(
		public message: string | DocumentFragment,
		public duration?: number,
	) {
		notices.push({ message: String(message), duration });
	}
}

/** 取出并清空已记录的 Notice */
export function __takeNotices(): RecordedNotice[] {
	const copy = notices.slice();
	notices.length = 0;
	return copy;
}

/** 查看已记录的 Notice（不清空） */
export function __peekNotices(): RecordedNotice[] {
	return notices.slice();
}

/* ------------------------------------------------------------ requestUrl */

export interface StubRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface StubResponse {
	status: number;
	text?: string;
	json?: unknown;
	arrayBuffer?: ArrayBuffer;
}

export type RequestHandler = (req: StubRequest) => StubResponse;

let requestHandler: RequestHandler | null = null;

export function __setRequestHandler(handler: RequestHandler | null): void {
	requestHandler = handler;
}

export async function requestUrl(req: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}): Promise<Required<Pick<StubResponse, "status" | "text" | "arrayBuffer">> & { json: unknown }> {
	if (!requestHandler) {
		throw new Error("obsidian stub: 未配置 requestUrl handler");
	}
	const res = requestHandler({
		url: req.url,
		method: req.method ?? "GET",
		headers: req.headers,
		body: req.body,
	});
	const text = res.text ?? (res.json === undefined ? "" : JSON.stringify(res.json));
	return {
		status: res.status,
		text,
		json: res.json ?? (text ? safeParse(text) : null),
		arrayBuffer: res.arrayBuffer ?? new ArrayBuffer(0),
	};
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/* ------------------------------------------------- 设置页 / 弹窗（占位） */

export class Component {
	onload(): void {}
	onunload(): void {}
}

export class Plugin extends Component {
	app: unknown;
	constructor(app?: unknown) {
		super();
		this.app = app;
	}
	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}
	saveData(): Promise<void> {
		return Promise.resolve();
	}
	addRibbonIcon(): HTMLElement {
		return {} as HTMLElement;
	}
	addCommand(): unknown {
		return {};
	}
	addSettingTab(): void {}
	registerEvent(): void {}
}

export class PluginSettingTab {
	containerEl: unknown;
	constructor(public app: unknown, public plugin: unknown) {}
	display(): void {}
}

export class Setting {
	constructor(public containerEl?: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addSlider(): this {
		return this;
	}
	addDropdown(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
	addExtraButton(): this {
		return this;
	}
}

export class TextComponent {
	constructor(public containerEl?: unknown) {}
	setValue(): this {
		return this;
	}
	getValue(): string {
		return "";
	}
	setPlaceholder(): this {
		return this;
	}
	onChange(): this {
		return this;
	}
	inputEl: unknown = {};
}

export class ToggleComponent {
	constructor(public containerEl?: unknown) {}
	setValue(): this {
		return this;
	}
	getValue(): boolean {
		return false;
	}
	onChange(): this {
		return this;
	}
}

export class SliderComponent {
	constructor(public containerEl?: unknown) {}
	setLimits(): this {
		return this;
	}
	setValue(): this {
		return this;
	}
	getValue(): number {
		return 0;
	}
	setDynamicTooltip(): this {
		return this;
	}
	onChange(): this {
		return this;
	}
}

export class DropdownComponent {
	constructor(public containerEl?: unknown) {}
	addOption(): this {
		return this;
	}
	addOptions(): this {
		return this;
	}
	setValue(): this {
		return this;
	}
	getValue(): string {
		return "";
	}
	onChange(): this {
		return this;
	}
}

export class ButtonComponent {
	constructor(public containerEl?: unknown) {}
	setButtonText(): this {
		return this;
	}
	getButtonText(): string {
		return "";
	}
	setCta(): this {
		return this;
	}
	setDisabled(): this {
		return this;
	}
	onClick(): this {
		return this;
	}
}

export class ExtraButtonComponent {
	constructor(public containerEl?: unknown) {}
	setIcon(): this {
		return this;
	}
	setTooltip(): this {
		return this;
	}
	onClick(): this {
		return this;
	}
}

export class Modal extends Component {
	titleEl: unknown = {};
	contentEl: unknown = {};
	constructor(public app: unknown) {
		super();
	}
	open(): void {}
	close(): void {}
}

export class FuzzySuggestModal<T> extends Modal {
	constructor(app: unknown) {
		super(app);
	}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	onChooseItem(_item: T): void {}
}