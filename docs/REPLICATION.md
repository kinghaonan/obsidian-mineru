# 复刻说明（obsidian-mineru）

本文记录本仓库如何从**丢失源码的打包产物** `main.js.orig` 反推出模块化 TypeScript 源码，
以及复刻过程中的验证手段与已知取舍。

## 1. 背景

原始项目只留下一个 esbuild 打包后的 `main.js`（151,669 字节，压缩混淆、无 sourcemap）。
`manifest.json` / `styles.css` / `data.json` 完整保留，可直接沿用。

反推思路：

1. 备份原产物为 `main.js.orig`（不入库），保证任何时候都能回查；
2. 用脚本切出插件代码段（jszip 之后的 `require("obsidian")` 起）；
3. 提取字符串字面量、函数体、类结构，重建模块边界；
4. 按 Obsidian 插件惯例重组为 `src/**/*.ts`，保持行为等价；
5. 用 `scripts/check-parity.mjs` 自动比对产物，防止复刻过程中漏功能。

## 2. 模块与原包符号对照

| 原包（压缩后） | 源码位置 | 说明 |
| --- | --- | --- |
| `zt` / `zt.rawRequest / jsonRequest / parseEnvelope / getUploadUrls / putFile / pollBatch / downloadZip / testConnection` | `src/mineru/api.ts` | MinerU Standard Batch API 客户端 |
| `lt`（`class extends Error`，`name="MineruError"`） | `src/mineru/errors.ts` | 带 `code` 的 API 错误 |
| `Ft` | `src/mineru/errors.ts#errorMessageFor` | 错误码 → 中文 |
| `te` / `Se` / `Zt` / `Ht` / `ne` / `Ot` / `Qt` | `src/constants.ts` | 状态文案、错误码表、语言表、LLM 预设、API base、扩展名集合 |
| `Bt`（`convertFiles / ensureFolder / writeResult`）+ `Me` | `src/mineru/pipeline.ts` | 上传→轮询→解压→写库管线 |
| `Xt` / `bt` / `Yt` / `jt` / `Jt` / `he` / `de` | `src/utils.ts` | sleep、文件名净化、data_id slug、相对路径、JSZip 解压、逐级建目录 |
| `It` / `pe` / `se` / `ae` | `src/markdown.ts` | `⟦MDC:n⟧` 占位符保护、图片链接改写、居中 HTML |
| `we` / `_e` | `src/translate/chunker.ts` | 分块、二分 |
| `ve` / `ye` / `be` | `src/translate/placeholders.ts` | frontmatter 拆分、系统提示词、title 翻译 |
| `xt` / `vt` | `src/translate/llm.ts` | OpenAI 兼容 / Anthropic 双引擎 |
| `Dt`（`translateFile / translateWithSplit / writeWithPolicy / uniquePath / maybeTranslateTitle / reveal`） | `src/translate/translator.ts` | 整篇翻译与落盘 |
| `Lt`（`ConversionManager`） | `src/ui/manager.ts` | idle/running/done/failed 状态机 |
| `Mt`（`FileSuggestModal`） | `src/ui/file-suggest.ts` | 模糊选择可转换文件 |
| `yt`（`ConversionWizard`）+ `oe` | `src/ui/wizard.ts`、`WIZARD_EXTRA_FORMATS` | 转换向导 |
| `Ut`（`MineruSettingTab`）+ `Mt`（`DEFAULT_SETTINGS`）+ `xe`（`mergeSettings`） | `src/settings.ts` | 三组设置页 |
| `jt`（`MineruPlugin`） | `src/main.ts` | 入口：命令、ribbon、文件右键菜单、图标状态 |
| `Fe` / `le` / `ce` | `EXTRA_FORMATS` / `TARGET_LANGUAGES` / `LLM_PRESETS` | 设置页选项表 |

## 3. 行为一致性校验

```bash
npm run build        # 产物 main.js
npm run check:parity # 与 main.js.orig 比对
npm run check:parity -- --strict   # 新增文案也算失败
```

校验内容：

- 原产物中**全部中文字面量**（UI 文案 / 提示 / 错误码说明 / 系统提示词）是否逐字出现在新产物中；
- **76 项关键标识符**（API 端点、URL、请求字段、CSS 类名、命令 id、设置字段、占位符协议等）。

当前结果：一致（168 项中文文案全覆盖）。

## 4. 已确认的等价点

- 设置字段名与 `data.json` 完全一致（含 `mineruApiToken` / `imageWidthPercent` / `collisionPolicy` 等 30 个字段）；
- 轮询节奏：3 秒一次、最长 30 分钟、超时抛 `TIMEOUT`、取消抛 `CANCELLED`；
- `extra_formats` 报 `-500` 时自动去掉该字段重试，且不再导出附加格式；
- 图片落库路径 `{输出文件夹}/{文件名}.assets/`，Markdown 链接改写为相对路径；
- 翻译占位符 `⟦MDC:n⟧` 保护代码块 / `$$公式$$` / `` `行内码` `` / `$行内公式$` / 图片链接；
- 输出命名 `{文件名}.{语言}.md`，冲突时 `(1)` 重命名或覆盖。

## 5. 已知取舍与原包遗留问题

复刻以**行为等价为第一目标**，以下差异是有意为之或原包既有行为，均已被单元测试锁定：

| 项 | 说明 |
| --- | --- |
| `ensureFolderLevels` | 原包创建图片目录只调用一次 `createFolder`；复刻改为逐级创建（Obsidian 的 `createFolder` 本身也支持多级），属于**行为等价但更稳健**的加固 |
| `ConversionManager.activeFiles` | 原包有该字段但只写不读；复刻保留并补充注释 |
| `splitInTwo` 的按行兜底分支不可达 | 首段总会先被赋给 `acc`，导致无空行文本整体作为前半段（`splitInTwo` 测试已锁定该行为） |
| 「占位符未被正确还原」告警不可达 | `restore()` 会吃掉所有 `⟦MDC\d+⟧`（查不到就替换为空串），故 `leftover` 恒为 0（translator 测试已锁定） |
| 测试桩对 `TFile` 使用派生 getter | 仅 `tests/stubs/obsidian.ts`，不参与插件打包 |

以上三条若要修复，会改变原包行为，需在 README 的「与原包差异」中显式声明后再改。

## 6. 安全提醒

`data.json` 含两枚明文密钥（MinerU Token 与某 LLM 服务 Key），已被 `.gitignore` 排除。
**建议尽快轮换这两枚密钥**，并在分享仓库前确认 `data.json` 未被提交。