import assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import MineruPlugin from "../src/main";
import type { PluginSettings } from "../src/settings";
import type { ConversionManager } from "../src/ui/manager";
import type { TranslationQueue } from "../src/translate/queue";
import type { StubElement } from "./stubs/obsidian";
import { takeNotices } from "./helpers/obsidian-mock";
import { createApp, createVault, makeTFile } from "./helpers/vault";

/** 测试用视图：暴露插件的私有能力与 stub 记录的注册项 */
interface PluginHarness {
	settings: PluginSettings;
	commands: { id: string; name: string; callback?: () => void; checkCallback?: (c: boolean) => boolean }[];
	views: Map<string, unknown>;
	settingsTabs: unknown[];
	ribbons: StubElement[];
	manager: ConversionManager;
	queue: TranslationQueue;
	onload(): Promise<void>;
	refreshRibbons(): void;
	activateProgressView(): Promise<void>;
	quickConvert(): Promise<void>;
	translateFile(file: TFile): Promise<void>;
	retryFailedConversion(): Promise<void>;
	queueFolder(file: TFile): void;
}

const PluginCtor = MineruPlugin as unknown as new (app: unknown) => PluginHarness;

interface HarnessWorkspace {
	activeFile: TFile | null;
	revealed: unknown[];
	getActiveFile(): TFile | null;
	getLeavesOfType(type: string): unknown[];
	getRightLeaf(): { setViewState(s: { type: string }): Promise<void>; viewType: string };
	revealLeaf(leaf: unknown): void;
	on(name: string, cb: unknown): unknown;
}

/** 组一个够用的 App + 右侧 leaf */
function bootApp(vault = createVault()) {
	const leaf = {
		viewType: "",
		async setViewState(state: { type: string }) {
			leaf.viewType = state.type;
		},
	};
	const app = createApp(vault) as unknown as ReturnType<typeof createApp> & {
		workspace: ReturnType<typeof createApp>["workspace"] & HarnessWorkspace;
	};
	app.workspace.revealed = [];
	app.workspace.activeFile = null;
	app.workspace.getActiveFile = () => app.workspace.activeFile;
	app.workspace.on = () => ({});
	app.workspace.getLeavesOfType = () => (leaf.viewType ? [leaf] : []);
	app.workspace.getRightLeaf = () => leaf as never;
	app.workspace.revealLeaf = (target) => app.workspace.revealed.push(target);
	return { app, leaf };
}

async function boot(settingsOverrides: Partial<PluginSettings> = {}, vault = createVault()) {
	(globalThis as unknown as { window?: unknown }).window = globalThis;
	const { app, leaf } = bootApp(vault);
	const plugin = new PluginCtor(app);
	await plugin.onload();
	// onload 会用 loadData() 覆盖 settings，覆盖值必须在之后写入
	plugin.settings = { ...plugin.settings, mineruApiToken: "token-test", ...settingsOverrides };
	plugin.refreshRibbons();
	return { plugin, app, leaf };
}

/** 当前在用的 ribbon（refreshRibbons 会移除旧的） */
function activeRibbons(plugin: PluginHarness): StubElement[] {
	return plugin.ribbons.filter((el) => !el.removed);
}

test("onload 注册全部命令与进度视图", async (t) => {
	t.after(() => takeNotices());
	const vault = createVault();
	vault.seed("文献/paper.pdf", "x");
	const { plugin } = await boot({}, vault);

	assert.deepEqual(
		plugin.commands.map((c) => c.id),
		[
			"open-conversion-wizard",
			"convert-active-file",
			"translate-current-note",
			"batch-translate",
			"translate-all-notes",
			"retry-failed-conversion",
			"open-progress-panel",
		],
	);
	assert.ok(plugin.commands.every((c) => c.name.startsWith("MinerU：")), "命令名应带 MinerU 前缀");
	assert.ok(plugin.views.has("mineru-progress-view"));
	assert.equal(plugin.settingsTabs.length, 1);
	assert.equal(activeRibbons(plugin).length, 4, "默认显示向导/快速转换/快速翻译/进度四个按钮");
});

test("界面按钮开关生效", async (t) => {
	t.after(() => takeNotices());
	const { plugin } = await boot({ showQuickConvertButton: false, showProgressButton: false });
	assert.equal(activeRibbons(plugin).length, 2, "关闭后只保留向导与翻译");
	plugin.refreshRibbons();
	assert.equal(activeRibbons(plugin).length, 2);
});

test("打开进度面板会创建并复用 leaf", async (t) => {
	t.after(() => takeNotices());
	const { plugin, app, leaf } = await boot();
	await plugin.activateProgressView();
	assert.equal(leaf.viewType, "mineru-progress-view");
	assert.equal(app.workspace.revealed.length, 1);

	await plugin.activateProgressView();
	assert.equal(app.workspace.revealed.length, 2, "已存在时应复用同一个 leaf");
});

test("快速转换对不支持的文件给出提示", async (t) => {
	t.after(() => takeNotices());
	const { plugin, app } = await boot();
	app.workspace.activeFile = makeTFile("笔记.md");
	await plugin.quickConvert();
	assert.match(takeNotices().join("|"), /请先打开一个支持转换的文件/);
});

test("翻译缺少配置时给出明确提示", async (t) => {
	t.after(() => takeNotices());
	const { plugin, app } = await boot({ openaiApiKey: "" });
	const note = makeTFile("文献/note.md");
	app.workspace.activeFile = note;
	await plugin.translateFile(note);
	assert.match(takeNotices().join("|"), /缺少 API Key/);
});

test("无失败项时重试给出提示", async (t) => {
	t.after(() => takeNotices());
	const { plugin } = await boot();
	assert.equal(plugin.manager.canRetry, false);
	await plugin.retryFailedConversion();
	assert.match(takeNotices().join("|"), /没有需要重试的失败项/);
});

test("文件夹批量入队只收 Markdown 且排除 README", async (t) => {
	t.after(() => takeNotices());
	const vault = createVault();
	vault.seed("读书/n1.md", "a");
	vault.seed("读书/n2.md", "b");
	vault.seed("读书/README.md", "r");
	vault.seed("读书/图.png", "p");
	const { plugin } = await boot({}, vault);

	plugin.queueFolder(makeTFile("读书/n1.md"));
	assert.deepEqual(
		plugin.queue.state.items.map((i) => i.path).sort(),
		["读书/n1.md", "读书/n2.md"],
	);
});

test("命令回调可执行且不抛异常", async (t) => {
	t.after(() => takeNotices());
	const vault = createVault();
	vault.seed("读书/n1.md", "a");
	const { plugin, app } = await boot({}, vault);
	app.workspace.activeFile = makeTFile("读书/n1.md");

	const wizard = plugin.commands.find((c) => c.id === "open-conversion-wizard")!;
	wizard.callback?.();
	const batch = plugin.commands.find((c) => c.id === "batch-translate")!;
	batch.callback?.();
	const folder = plugin.commands.find((c) => c.id === "translate-all-notes")!;
	assert.equal(folder.checkCallback?.(true), true);
	assert.equal(plugin.queue.state.total >= 0, true);

	const convert = plugin.commands.find((c) => c.id === "convert-active-file")!;
	assert.equal(convert.checkCallback?.(true), false, "md 不是可转换类型");
});

test("转换状态联动 ribbon 图标", async (t) => {
	t.after(() => takeNotices());
	const vault = createVault();
	vault.seed("a.pdf", "x");
	const { plugin } = await boot({ maxAutoRetries: 0 }, vault);
	const ribbon = activeRibbons(plugin)[0];

	await plugin.manager.start([], { outputFolder: "out" } as never);
	assert.ok(ribbon.classes.has("mineru-done"), "空列表也会走到 done（成功 0）");
	assert.equal(plugin.manager.lastReport?.succeeded, 0);

	ribbon.classes.delete("mineru-done");
	await plugin.manager.start([vault.getFiles()[0]], {
		outputFolder: "out",
		params: { modelVersion: "vlm", isOcr: false, enableFormula: true, enableTable: true, language: "ch", extraFormats: [] },
		downloadImages: false,
		imageFolder: "",
		convertImageToHtml: false,
		imageWidth: 80,
		showImageFilename: false,
		collisionPolicy: "rename",
		split: { enabled: false, maxPages: 80, maxSizeMB: 100, dedupeTitle: true },
	});
	// 未配置网络层（无 requestUrl handler）→ 该任务应失败并点亮失败色
	assert.ok(ribbon.classes.has("mineru-failed"));
	assert.equal(plugin.manager.state.status, "failed");
});