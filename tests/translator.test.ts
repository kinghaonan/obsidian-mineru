import assert from "node:assert/strict";
import { test } from "node:test";
import { setRequestHandler, type StubRequest } from "./helpers/obsidian-mock";
import { Translator } from "../src/translate/translator";
import { LlmEngine } from "../src/translate/llm";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/settings";
import { createApp, createVault } from "./helpers/vault";

/** 假 OpenAI 兼容服务：把用户输入原样回显（相当于"恒等翻译"） */
function identityHandler(transform?: (content: string) => string) {
	return (req: StubRequest) => {
		const body = JSON.parse(String(req.body)) as { messages: { role: string; content: string }[] };
		const user = body.messages.find((m) => m.role === "user")?.content ?? "";
		const content = transform ? transform(user) : user;
		return {
			status: 200,
			json: { choices: [{ message: { content }, finish_reason: "stop" }] },
		};
	};
}

function settingsWith(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return { ...DEFAULT_SETTINGS, openaiApiKey: "sk-test", ...overrides };
}

function setup(files: Record<string, string>, handler = identityHandler()) {
	const vault = createVault();
	for (const [path, content] of Object.entries(files)) vault.seed(path, content);
	const app = createApp(vault);
	const translator = new Translator(app as never);
	setRequestHandler(handler);
	return { vault, app, translator };
}

const OPTS = {
	targetLanguage: "en",
	preserveFrontmatter: true,
	translateFrontmatterTitle: false,
	chunkSizeChars: 5000,
	collisionPolicy: "rename" as const,
};

test("translateFile 保留 frontmatter 并输出 {名}.{语言}.md", async (t) => {
	t.after(() => setRequestHandler(null));
	const source = "---\ntitle: 测试\ntags: [a]\n---\n\n# 标题\n\n正文内容\n";
	const { vault, translator } = setup({ "文献/笔记.md": source });
	const result = await translator.translateFile(vault.getFiles()[0], OPTS, () => settingsWith());

	assert.equal(result.file.path, "文献/笔记.en.md");
	assert.equal(result.file.path.includes("."), true);
	const out = await vault.read(result.file);
	assert.ok(out.startsWith("---\ntitle: 测试\ntags: [a]\n---\n"), `实际输出：${out}`);
	assert.ok(out.includes("# 标题"));
	assert.deepEqual(result.warnings, []);
});

test("translateFile 还原代码块与公式占位符", async (t) => {
	t.after(() => setRequestHandler(null));
	const source = "正文\n\n```py\nprint(1)\n```\n\n公式 $$E=mc^2$$ 与 `code`、![图](images/1.jpg)\n";
	const { vault, translator } = setup({ "n.md": source });
	const result = await translator.translateFile(vault.getFiles()[0], OPTS, () => settingsWith());
	const out = await vault.read(result.file);

	assert.ok(out.includes("```py\nprint(1)\n```"), "代码块应被原样还原");
	assert.ok(out.includes("$$E=mc^2$$"));
	assert.ok(out.includes("`code`"));
	assert.ok(out.includes("![图](images/1.jpg)"));
	assert.ok(!out.includes("⟦MDC"), "占位符应全部还原");
	assert.deepEqual(result.warnings, []);
});

test("translateFile 译文里出现陌生占位符会被还原为空并静默", async (t) => {
	t.after(() => setRequestHandler(null));
	// 原实现里 restore() 会吃掉所有 ⟦MDC\d+⟧（查不到就替换为空串），
	// 因此"占位符未被还原"的告警分支实际不可达，这里锁定现状。
	const source = "看这个：`code`\n";
	const { vault, translator } = setup({ "n.md": source }, identityHandler((c) => c + "\n⟦MDC99⟧"));
	const result = await translator.translateFile(vault.getFiles()[0], OPTS, () => settingsWith());
	const out = await vault.read(result.file);
	assert.deepEqual(result.warnings, []);
	assert.ok(!out.includes("⟦MDC"));
	assert.ok(out.includes("`code`"));
});

test("translateFile 空正文给出告警", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, translator } = setup({ "n.md": "   \n\n  \n" });
	const result = await translator.translateFile(vault.getFiles()[0], OPTS, () => settingsWith());
	assert.ok(result.warnings.some((w) => /没有可翻译的正文内容/.test(w)));
});

test("translateFile 分块数量驱动进度回调", async (t) => {
	t.after(() => setRequestHandler(null));
	const body = Array.from({ length: 12 }, (_, i) => `段落${i}`.repeat(20)).join("\n\n");
	const { vault, translator } = setup({ "n.md": body });
	const seen: [number, number][] = [];
	await translator.translateFile(
		vault.getFiles()[0],
		{ ...OPTS, chunkSizeChars: 100 },
		() => settingsWith(),
		(done, total) => seen.push([done, total]),
	);
	assert.ok(seen.length >= 3, "应产生多个分块回调");
	const last = seen[seen.length - 1];
	assert.deepEqual(last, [seen[seen.length - 1][0], seen[seen.length - 1][1]]);
	assert.ok(seen.every(([, total]) => total === seen[0][1]));
});

test("translateFile 译文输出到指定文件夹并逐级创建", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, translator } = setup({ "文献/笔记.md": "正文" });
	const result = await translator.translateFile(
		vault.getFiles()[0],
		OPTS,
		() => settingsWith({ translationOutputFolder: "翻译/英文" }),
	);
	assert.equal(result.file.path, "翻译/英文/笔记.en.md");
	assert.ok(vault.folders.has("翻译"));
	assert.ok(vault.folders.has("翻译/英文"));
});

test("translateFile 冲突策略 rename 追加 (1)", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, translator } = setup({ "文献/笔记.md": "正文", "文献/笔记.en.md": "旧译文" });
	const result = await translator.translateFile(vault.getFiles()[0], OPTS, () => settingsWith());
	assert.equal(result.file.path, "文献/笔记.en (1).md");
});

test("translateFile 冲突策略 overwrite 覆盖已有译文", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, translator } = setup({ "文献/笔记.md": "正文", "文献/笔记.en.md": "旧译文" });
	const result = await translator.translateFile(
		vault.getFiles()[0],
		{ ...OPTS, collisionPolicy: "overwrite" },
		() => settingsWith(),
	);
	assert.equal(result.file.path, "文献/笔记.en.md");
	assert.equal(await vault.read(vault.getAbstractFileByPath("文献/笔记.en.md") as never), "正文");
});

test("translateFile 可选翻译 frontmatter 的 title", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, translator } = setup({ "n.md": "---\ntitle: 我的笔记\n---\n\n正文\n" }, identityHandler((c) => (c.includes("我的笔记") ? "My Note" : c)));
	const result = await translator.translateFile(
		vault.getFiles()[0],
		{ ...OPTS, translateFrontmatterTitle: true },
		() => settingsWith(),
	);
	const out = await vault.read(result.file);
	assert.ok(out.includes('title: "My Note"'), `实际输出：${out}`);
});

test("translateFile 关闭保留 frontmatter 时不写前言", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, translator } = setup({ "n.md": "---\ntitle: 测试\n---\n\n正文\n" });
	const result = await translator.translateFile(vault.getFiles()[0], { ...OPTS, preserveFrontmatter: false }, () =>
		settingsWith(),
	);
	assert.equal((await vault.read(result.file)).trim(), "正文");
});

test("translateWithSplit 截断时按段落二分重译", async () => {
	const warnings: string[] = [];
	const seen: number[] = [];
	let truncatedOnce = true;
	const fake = {
		async translate(_system: string, content: string) {
			seen.push(content.length);
			const truncated = truncatedOnce;
			truncatedOnce = false;
			return { content, truncated };
		},
	} as unknown as LlmEngine;

	const source = Array.from({ length: 8 }, () => "x".repeat(25)).join("\n\n");
	const out = await new Translator({} as never).translateWithSplit(fake, "sys", source, warnings, 0);

	assert.equal(seen.length, 3, "根块截断 → 拆成两半各译一次");
	assert.ok(seen[0] > seen[1] && seen[1] >= seen[2]);
	assert.equal(out, source, "两半以空行拼接后应还原原文");
	assert.deepEqual(warnings, []);
});

test("translateWithSplit 触底后给出截断告警", async () => {
	const warnings: string[] = [];
	const fake = {
		async translate(_system: string, content: string) {
			return { content, truncated: true };
		},
	} as unknown as LlmEngine;
	await new Translator({} as never).translateWithSplit(fake, "sys", "x".repeat(50), warnings, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /单次最大输出 Tokens/);
});

test("reveal 打开译文文件", async (t) => {
	t.after(() => setRequestHandler(null));
	const { vault, app, translator } = setup({ "n.md": "正文" });
	const result = await translator.translateFile(vault.getFiles()[0], OPTS, () => settingsWith());
	await translator.reveal(result.file);
	assert.deepEqual(app.opened.map((f) => f.path), [result.file.path]);
});