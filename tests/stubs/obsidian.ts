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

/** 够用的 HTMLElement 替身：记录类名与属性，便于断言 ribbon 状态 */
export class StubElement {
	classes = new Set<string>();
	attrs: Record<string, string> = {};
	textContent = "";
	removed = false;

	constructor(public tag = "div") {}
	toggleClass(cls: string, on: boolean): this {
		if (on) this.classes.add(cls);
		else this.classes.delete(cls);
		return this;
	}
	addClass(...cls: string[]): this {
		for (const c of cls) this.classes.add(c);
		return this;
	}
	removeClass(...cls: string[]): this {
		for (const c of cls) this.classes.delete(c);
		return this;
	}
	setAttribute(key: string, value: string): void {
		this.attrs[key] = value;
	}
	removeAttribute(key: string): void {
		delete this.attrs[key];
	}
	setText(value: string): void {
		this.textContent = value;
	}
	remove(): void {
		this.removed = true;
	}
	querySelector(): StubElement | null {
		return null;
	}
}

export class Plugin extends Component {
	app: unknown;
	commands: { id: string; name: string; callback?: () => void; checkCallback?: (c: boolean) => boolean }[] =
		[];
	ribbons: StubElement[] = [];
	settingsTabs: unknown[] = [];
	views: Map<string, (leaf: unknown) => unknown> = new Map();
	events: unknown[] = [];

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
	addRibbonIcon(_icon: string, _title: string, _cb: () => void): StubElement {
		const el = new StubElement("a");
		this.ribbons.push(el);
		return el;
	}
	addCommand(cmd: { id: string; name: string }): void {
		this.commands.push(cmd);
	}
	addSettingTab(tab: unknown): void {
		this.settingsTabs.push(tab);
	}
	registerView(type: string, factory: (leaf: unknown) => unknown): void {
		this.views.set(type, factory);
	}
	registerEvent(_ref: unknown): void {
		this.events.push(_ref);
	}
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
	setPlaceholder(_text: string): void {}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	onChooseItem(_item: T): void {}
}

export class SuggestModal<T> extends Modal {
	placeholder = "";
	modalEl: any = new StubElement();
	constructor(app: unknown) {
		super(app);
	}
	setPlaceholder(text: string): void {
		this.placeholder = text;
	}
	getSuggestions(_query: string): T[] {
		return [];
	}
	renderSuggestion(_item: T, _el: HTMLElement): void {}
	onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class ItemView extends Component {
	containerEl: any = { children: [new StubElement(), new StubElement()] };
	contentEl: any = new StubElement();
	leaf: unknown;
	constructor(leaf?: unknown) {
		super();
		this.leaf = leaf;
	}
	getViewType(): string {
		return "";
	}
	getDisplayText(): string {
		return "";
	}
	getIcon(): string {
		return "";
	}
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
	async onUnload(): Promise<void> {}
}