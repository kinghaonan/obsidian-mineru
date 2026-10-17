import {
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	SliderComponent,
	ToggleComponent,
	App,
} from "obsidian";
import {
	EXTRA_FORMATS,
	LLM_PRESETS,
	OCR_LANGUAGE_DESC,
	TARGET_LANGUAGES,
	COLLISION_POLICIES,
	DEFAULT_MAX_RETRIES,
	DEFAULT_SPLIT_PAGES,
	DEFAULT_SPLIT_SIZE_MB,
	DEFAULT_TRANSLATION_CONCURRENCY,
	MINERU_MAX_PAGES,
} from "./constants";
import type { CollisionPolicy, TestResult } from "./types";

export interface PluginSettings {
	mineruApiToken: string;
	parseModel: "vlm" | "pipeline";
	isOcr: boolean;
	enableFormula: boolean;
	enableTable: boolean;
	language: string;
	extraFormats: string[];
	outputFolder: string;
	downloadImages: boolean;
	imageFolder: string;
	convertImageToHtml: boolean;
	imageWidthPercent: number;
	showImageFilename: boolean;
	showQuickConvertButton: boolean;
	showQuickTranslateButton: boolean;
	llmProvider: "openai" | "anthropic";
	openaiBaseUrl: string;
	openaiApiKey: string;
	openaiModel: string;
	anthropicApiKey: string;
	anthropicModel: string;
	targetLanguage: string;
	translationOutputFolder: string;
	preserveFrontmatter: boolean;
	translateFrontmatterTitle: boolean;
	chunkSizeChars: number;
	maxOutputTokens: number;
	collisionPolicy: "rename" | "overwrite";
	temperature: number;

	/* ---- 扩展：转换 ---- */
	/** 目标 Markdown 已存在时的处理方式 */
	conversionCollisionPolicy: CollisionPolicy;
	/** 瞬时错误自动重试次数（0 关闭） */
	maxAutoRetries: number;
	/** 大文件自动切分 */
	autoSplitEnabled: boolean;
	autoSplitMaxPages: number;
	autoSplitMaxSizeMB: number;
	splitDedupeTitle: boolean;

	/* ---- 扩展：翻译队列 / 进度面板 ---- */
	/** 批量翻译并发数 */
	translationConcurrency: number;
	/** 任务开始时自动展开进度面板 */
	autoOpenProgressView: boolean;
	showProgressButton: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	mineruApiToken: "",
	parseModel: "vlm",
	isOcr: false,
	enableFormula: true,
	enableTable: true,
	language: "ch",
	extraFormats: [],
	outputFolder: "MinerU转换",
	downloadImages: true,
	imageFolder: "",
	convertImageToHtml: true,
	imageWidthPercent: 80,
	showImageFilename: true,
	showQuickConvertButton: true,
	showQuickTranslateButton: true,
	llmProvider: "openai",
	openaiBaseUrl: "https://api.openai.com/v1",
	openaiApiKey: "",
	openaiModel: "gpt-4o-mini",
	anthropicApiKey: "",
	anthropicModel: "claude-sonnet-4-5",
	targetLanguage: "en",
	translationOutputFolder: "",
	preserveFrontmatter: true,
	translateFrontmatterTitle: false,
	chunkSizeChars: 5000,
	maxOutputTokens: 8192,
	collisionPolicy: "rename",
	temperature: 0.3,

	conversionCollisionPolicy: "rename",
	maxAutoRetries: DEFAULT_MAX_RETRIES,
	autoSplitEnabled: true,
	autoSplitMaxPages: DEFAULT_SPLIT_PAGES,
	autoSplitMaxSizeMB: DEFAULT_SPLIT_SIZE_MB,
	splitDedupeTitle: true,
	translationConcurrency: DEFAULT_TRANSLATION_CONCURRENCY,
	autoOpenProgressView: true,
	showProgressButton: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 以默认设置为模板合并持久化数据（字段级兜底，忽略未知字段） */
export function mergeSettings(stored: unknown): PluginSettings {
	if (!isPlainObject(stored)) return { ...DEFAULT_SETTINGS };
	const merged = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		const value = stored[key];
		if (value == null) continue;
		const fallback = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
		if (isPlainObject(fallback) && isPlainObject(value)) {
			merged[key] = { ...fallback, ...value };
		} else {
			merged[key] = value;
		}
	}
	return merged as unknown as PluginSettings;
}

/** 设置页宿主需要暴露的能力 */
export interface SettingTabHost {
	app: App;
	settings: PluginSettings;
	client: { testConnection(): Promise<TestResult> };
	saveSettings(): Promise<void>;
	testTranslation?(): Promise<TestResult>;
	refreshRibbons?(): void;
}

export class MineruSettingTab extends PluginSettingTab {
	private host: SettingTabHost;

	constructor(app: App, host: SettingTabHost) {
		super(app, host as never);
		this.host = host;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.host.settings;

		containerEl.createEl("h2", { text: "MinerU API 设置" });

		new Setting(containerEl)
			.setName("API Token")
			.setDesc("在 mineru.net 获取你的个人精准解析 API Token")
			.addText((text) => {
				text.setPlaceholder("点击右侧链接获取 Token")
					.setValue(s.mineruApiToken)
					.onChange(async (value) => {
						s.mineruApiToken = value.trim();
						await this.host.saveSettings();
					});
				text.inputEl.type = "password";
			})
			.addExtraButton((btn) => {
				btn.setIcon("external-link")
					.setTooltip("打开 mineru.net 获取 Token")
					.onClick(() => window.open("https://mineru.net/apiManage/token"));
			});

		new Setting(containerEl)
			.setName("测试连接")
			.setDesc("验证 Token 是否有效")
			.addButton((btn) =>
				btn.setButtonText("测试 MinerU 连接").setCta().onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText("测试中…");
					const result = await this.host.client.testConnection();
					btn.setDisabled(false);
					btn.setButtonText("测试 MinerU 连接");
					new Notice(result.message, 6000);
				}),
			);

		new Setting(containerEl)
			.setName("解析模型")
			.setDesc("vlm 为推荐的高精度模型，pipeline 速度更快")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("vlm", "vlm（推荐）")
					.addOption("pipeline", "pipeline")
					.setValue(s.parseModel)
					.onChange(async (value) => {
						s.parseModel = value as PluginSettings["parseModel"];
						await this.host.saveSettings();
					});
			});

		new Setting(containerEl).setName("启用 OCR").addToggle((toggle) => {
			toggle.setValue(s.isOcr).onChange(async (value) => {
				s.isOcr = value;
				await this.host.saveSettings();
			});
		});

		new Setting(containerEl).setName("识别公式").addToggle((toggle) => {
			toggle.setValue(s.enableFormula).onChange(async (value) => {
				s.enableFormula = value;
				await this.host.saveSettings();
			});
		});

		new Setting(containerEl).setName("识别表格").addToggle((toggle) => {
			toggle.setValue(s.enableTable).onChange(async (value) => {
				s.enableTable = value;
				await this.host.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("识别语言")
			.setDesc(OCR_LANGUAGE_DESC)
			.addText((text) => {
				text.setValue(s.language).onChange(async (value) => {
					s.language = value.trim() || "ch";
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl).setName("同时导出格式").setDesc("除 Markdown 外，额外导出的格式");
		for (const format of EXTRA_FORMATS) {
			new Setting(containerEl).setName(format.label).addToggle((toggle) => {
				toggle.setValue(s.extraFormats.includes(format.key)).onChange(async (value) => {
					if (value && !s.extraFormats.includes(format.key)) s.extraFormats.push(format.key);
					if (!value) s.extraFormats = s.extraFormats.filter((f) => f !== format.key);
					await this.host.saveSettings();
				});
			});
		}

		containerEl.createEl("h2", { text: "转换输出设置" });

		new Setting(containerEl)
			.setName("输出文件夹")
			.setDesc("转换结果（Markdown 等）默认写入的库内文件夹")
			.addText((text) => {
				text.setPlaceholder("MinerU转换")
					.setValue(s.outputFolder)
					.onChange(async (value) => {
						s.outputFolder = value.trim();
						await this.host.saveSettings();
					});
			});

		new Setting(containerEl).setName("下载图片到库中").addToggle((toggle) => {
			toggle.setValue(s.downloadImages).onChange(async (value) => {
				s.downloadImages = value;
				await this.host.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("图片保存文件夹")
			.setDesc(
				"留空则自动保存为：{输出文件夹}/{文件名}.assets（推荐，避免多文档图片互相覆盖）。文件名中的空格会替换为 -、括号会被去掉，以保证图片链接可用",
			)
			.addText((text) => {
				text.setPlaceholder("留空自动生成")
					.setValue(s.imageFolder)
					.onChange(async (value) => {
						s.imageFolder = value.trim();
						await this.host.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("图片居中并缩放显示")
			.setDesc("将图片链接转换为居中的 HTML，并以指定宽度显示（用于 PDF 扫描件等大图）")
			.addToggle((toggle) => {
				toggle.setValue(s.convertImageToHtml).onChange(async (value) => {
					s.convertImageToHtml = value;
					await this.host.saveSettings();
				});
			});

		const widthDesc = containerEl.createDiv({ cls: "setting-item-description", text: "" });
		new Setting(containerEl).setName("图片显示宽度").addSlider((slider: SliderComponent) => {
			slider
				.setLimits(10, 100, 5)
				.setValue(s.imageWidthPercent)
				.setDynamicTooltip()
				.onChange(async (value) => {
					s.imageWidthPercent = value;
					widthDesc.setText(`当前宽度：${value}%`);
					await this.host.saveSettings();
				});
		});

		new Setting(containerEl)
			.setName("图片下方显示文件名（加粗）")
			.setDesc("转换后每张图片下方以粗体显示文件名，方便分辨")
			.addToggle((toggle) => {
				toggle.setValue(s.showImageFilename).onChange(async (value) => {
					s.showImageFilename = value;
					await this.host.saveSettings();
				});
			});

		containerEl.createEl("h2", { text: "LLM 翻译设置" });

		const llmContainer = containerEl.createDiv();

		new Setting(llmContainer).setName("翻译服务").addDropdown((dropdown) => {
			dropdown
				.addOption("openai", "OpenAI 兼容接口")
				.addOption("anthropic", "Anthropic Claude")
				.setValue(s.llmProvider)
				.onChange(async (value) => {
					s.llmProvider = value as PluginSettings["llmProvider"];
					await this.host.saveSettings();
					this.display();
				});
		});

		if (s.llmProvider === "openai") {
			new Setting(llmContainer)
				.setName("常用服务预设")
				.setDesc("选择后自动填入 Base URL 与模型（不会覆盖已填的 API Key）")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "手动配置…");
					for (const preset of LLM_PRESETS) dropdown.addOption(preset.key, preset.label);
					dropdown.onChange(async (value) => {
						const preset = LLM_PRESETS.find((p) => p.key === value);
						if (preset) {
							s.openaiBaseUrl = preset.baseUrl;
							s.openaiModel = preset.model;
							await this.host.saveSettings();
							this.display();
						}
					});
				});

			new Setting(llmContainer)
				.setName("Base URL")
				.setDesc("支持 OpenAI / DeepSeek / 通义千问 / Kimi / Ollama 等兼容接口，可先用上方预设一键填入")
				.addText((text) => {
					text.setPlaceholder("https://api.openai.com/v1")
						.setValue(s.openaiBaseUrl)
						.onChange(async (value) => {
							s.openaiBaseUrl = value.trim();
							await this.host.saveSettings();
						});
				});

			new Setting(llmContainer).setName("API Key").addText((text) => {
				text.setPlaceholder("sk-…")
					.setValue(s.openaiApiKey)
					.onChange(async (value) => {
						s.openaiApiKey = value.trim();
						await this.host.saveSettings();
					});
				text.inputEl.type = "password";
			});

			new Setting(llmContainer).setName("模型").addText((text) => {
				text.setPlaceholder("gpt-4o-mini / deepseek-chat / qwen-plus…")
					.setValue(s.openaiModel)
					.onChange(async (value) => {
						s.openaiModel = value.trim();
						await this.host.saveSettings();
					});
			});
		}

		if (s.llmProvider === "anthropic") {
			new Setting(llmContainer)
				.setName("API Key")
				.setDesc("Anthropic Console 获取，如 sk-ant-…")
				.addText((text) => {
					text.setPlaceholder("sk-ant-…")
						.setValue(s.anthropicApiKey)
						.onChange(async (value) => {
							s.anthropicApiKey = value.trim();
							await this.host.saveSettings();
						});
					text.inputEl.type = "password";
				});

			new Setting(llmContainer).setName("模型").addText((text) => {
				text.setPlaceholder("claude-sonnet-4-5")
					.setValue(s.anthropicModel)
					.onChange(async (value) => {
						s.anthropicModel = value.trim();
						await this.host.saveSettings();
					});
			});
		}

		new Setting(llmContainer)
			.setName("测试翻译")
			.setDesc("发送一小段内容验证翻译配置是否可用，失败会显示具体原因")
			.addButton((btn) =>
				btn.setButtonText("测试翻译连接").setCta().onClick(async () => {
					if (!this.host.testTranslation) {
						new Notice("当前插件版本不支持该功能，请重启 Obsidian");
						return;
					}
					btn.setDisabled(true);
					btn.setButtonText("测试中…");
					const result = await this.host.testTranslation();
					btn.setDisabled(false);
					btn.setButtonText("测试翻译连接");
					new Notice(result.message, 8000);
				}),
			);

		const knownLanguage = TARGET_LANGUAGES.some(([code]) => code === s.targetLanguage);
		const languageSetting = new Setting(llmContainer)
			.setName("目标语言")
			.setDesc("翻译输出文件命名为 {文件名}.{语言代码}.md，如 英文(en) → 测试.en.md");
		new DropdownComponent(languageSetting.controlEl)
			.addOption("__custom__", "自定义…")
			.addOptions(Object.fromEntries(TARGET_LANGUAGES.map(([code, label]) => [code, label])))
			.setValue(knownLanguage ? s.targetLanguage : "__custom__")
			.onChange(async (value) => {
				if (value === "__custom__") {
					this.display();
				} else {
					s.targetLanguage = value;
					await this.host.saveSettings();
				}
			});
		if (!knownLanguage) {
			new Setting(llmContainer)
				.setName("自定义目标语言代码")
				.setDesc("可用任意语言名称或代码，如：en、英文、繁体中文、zh-Hant 等")
				.addText((text) => {
					text.setPlaceholder("例如：en")
						.setValue(s.targetLanguage)
						.onChange(async (value) => {
							s.targetLanguage = value.trim();
							await this.host.saveSettings();
						});
				});
		}

		new Setting(llmContainer)
			.setName("翻译输出文件夹")
			.setDesc("留空则保存在原文同目录；填写库内文件夹（如：翻译）则所有译文统一保存到该目录")
			.addText((text) => {
				text.setPlaceholder("留空 = 原文同目录")
					.setValue(s.translationOutputFolder)
					.onChange(async (value) => {
						s.translationOutputFolder = value.trim();
						await this.host.saveSettings();
					});
			});

		new Setting(llmContainer).setName("保留 YAML 前言").addToggle((toggle) => {
			toggle.setValue(s.preserveFrontmatter).onChange(async (value) => {
				s.preserveFrontmatter = value;
				await this.host.saveSettings();
			});
		});

		new Setting(llmContainer)
			.setName("翻译前言中的 title 字段")
			.setDesc("保留前言原文，仅翻译 title（可选）")
			.addToggle((toggle) => {
				toggle.setValue(s.translateFrontmatterTitle).onChange(async (value) => {
					s.translateFrontmatterTitle = value;
					await this.host.saveSettings();
				});
			});

		const chunkDesc = containerEl.createDiv({ cls: "setting-item-description", text: "" });
		new Setting(llmContainer).setName("分块大小（字符）").addSlider((slider: SliderComponent) => {
			slider
				.setLimits(1000, 20000, 500)
				.setValue(s.chunkSizeChars)
				.setDynamicTooltip()
				.onChange(async (value) => {
					s.chunkSizeChars = value;
					chunkDesc.setText(`当前分块大小：${value} 字符`);
					await this.host.saveSettings();
				});
		});

		new Setting(llmContainer).setName("单次最大输出 Tokens").addText((text) => {
			text.setValue(String(s.maxOutputTokens)).onChange(async (value) => {
				const num = Number(value);
				if (Number.isFinite(num) && num > 0) {
					s.maxOutputTokens = Math.floor(num);
					await this.host.saveSettings();
				}
			});
		});

		new Setting(llmContainer).setName("文件名冲突处理").addDropdown((dropdown) => {
			dropdown
				.addOption("rename", "自动重命名")
				.addOption("overwrite", "覆盖原翻译文件")
				.setValue(s.collisionPolicy)
				.onChange(async (value) => {
					s.collisionPolicy = value as PluginSettings["collisionPolicy"];
					await this.host.saveSettings();
				});
		});

		const tempDesc = containerEl.createDiv({ cls: "setting-item-description", text: "" });
		new Setting(llmContainer).setName("温度（随机性）").addSlider((slider: SliderComponent) => {
			slider
				.setLimits(0, 1, 0.1)
				.setValue(s.temperature)
				.setDynamicTooltip()
				.onChange(async (value) => {
					s.temperature = value;
					tempDesc.setText(`当前温度：${value.toFixed(1)}`);
					await this.host.saveSettings();
				});
		});

		containerEl.createEl("h2", { text: "大文件与容错" });

		new Setting(containerEl)
			.setName("同名文件处理")
			.setDesc("转换结果 Markdown 已存在时的默认行为（向导可临时调整）")
			.addDropdown((dropdown) => {
				for (const policy of COLLISION_POLICIES) dropdown.addOption(policy.key, policy.label);
				dropdown.setValue(s.conversionCollisionPolicy).onChange(async (value) => {
					s.conversionCollisionPolicy = value as CollisionPolicy;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("网络失败自动重试")
			.setDesc(`请求失败或返回 429/5xx 时自动重试的次数（0 关闭），当前：${s.maxAutoRetries}`)
			.addSlider((slider: SliderComponent) => {
				slider
					.setLimits(0, 5, 1)
					.setValue(s.maxAutoRetries)
					.setDynamicTooltip()
					.onChange(async (value) => {
						s.maxAutoRetries = value;
						await this.host.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("大文件自动切分")
			.setDesc(
				`PDF 超过分片上限时自动切成多个分片批量上传，再按页码顺序合并回一篇 Markdown（MinerU 单次上限 ${MINERU_MAX_PAGES} 页 / 200MB）`,
			)
			.addToggle((toggle) => {
				toggle.setValue(s.autoSplitEnabled).onChange(async (value) => {
					s.autoSplitEnabled = value;
					await this.host.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("每个分片页数上限")
			.setDesc(`页数超过该值时切分，建议留出余量（当前 ${s.autoSplitMaxPages} 页）`)
			.addText((text) => {
				text.setPlaceholder(String(DEFAULT_SPLIT_PAGES)).setValue(String(s.autoSplitMaxPages)).onChange(async (value) => {
					const num = Number(value);
					if (Number.isFinite(num) && num > 0) {
						s.autoSplitMaxPages = Math.floor(num);
						await this.host.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("每个分片体积上限（MB）")
			.setDesc(`单个分片超过该体积时继续二分，当前 ${s.autoSplitMaxSizeMB} MB（上限 200MB）`)
			.addText((text) => {
				text.setPlaceholder(String(DEFAULT_SPLIT_SIZE_MB)).setValue(String(s.autoSplitMaxSizeMB)).onChange(async (value) => {
					const num = Number(value);
					if (Number.isFinite(num) && num > 0) {
						s.autoSplitMaxSizeMB = Math.min(Math.floor(num), 200);
						await this.host.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("合并时去掉重复标题")
			.setDesc("各分片常以相同的一级标题开头，合并时自动只保留第一个")
			.addToggle((toggle) => {
				toggle.setValue(s.splitDedupeTitle).onChange(async (value) => {
					s.splitDedupeTitle = value;
					await this.host.saveSettings();
				});
			});

		containerEl.createEl("h2", { text: "翻译队列与进度面板" });

		new Setting(containerEl)
			.setName("批量翻译并发数")
			.setDesc(`同时翻译的笔记数量（1-8），当前 ${s.translationConcurrency}`)
			.addSlider((slider: SliderComponent) => {
				slider
					.setLimits(1, 8, 1)
					.setValue(s.translationConcurrency)
					.setDynamicTooltip()
					.onChange(async (value) => {
						s.translationConcurrency = value;
						await this.host.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("任务开始时自动展开进度面板")
			.setDesc("转换或翻译开始时，在右侧边栏展开「MinerU 进度」面板")
			.addToggle((toggle) => {
				toggle.setValue(s.autoOpenProgressView).onChange(async (value) => {
					s.autoOpenProgressView = value;
					await this.host.saveSettings();
				});
			});

		containerEl.createEl("h2", { text: "界面按钮" });

		new Setting(containerEl)
			.setName("显示「快速转换」按钮")
			.setDesc("在侧边栏显示一键转换当前文件的按钮（转换中图标会旋转高亮）")
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(s.showQuickConvertButton).onChange(async (value) => {
					s.showQuickConvertButton = value;
					await this.host.saveSettings();
					this.host.refreshRibbons?.();
				});
			});

		new Setting(containerEl)
			.setName("显示「快速翻译」按钮")
			.setDesc("在侧边栏显示一键翻译当前笔记的按钮")
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(s.showQuickTranslateButton).onChange(async (value) => {
					s.showQuickTranslateButton = value;
					await this.host.saveSettings();
					this.host.refreshRibbons?.();
				});
			});

		new Setting(containerEl)
			.setName("显示「进度面板」按钮")
			.setDesc("在侧边栏显示打开「MinerU 进度」面板的按钮")
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(s.showProgressButton).onChange(async (value) => {
					s.showProgressButton = value;
					await this.host.saveSettings();
					this.host.refreshRibbons?.();
				});
			});

		containerEl.createEl("p", {
			text: "关闭转换面板后转换仍会在后台继续，侧边栏图标显示运行状态。",
			cls: "setting-item-description",
		});

		containerEl.createEl("h2", { text: "关于" });
		containerEl.createEl("p", {
			text: "本插件使用 MinerU 精准解析 API 将 PDF / Word / PPT / Excel / 图片精确解析为 Markdown，并支持调用自配的大模型进行翻译。",
			cls: "setting-item-description",
		});
	}
}
