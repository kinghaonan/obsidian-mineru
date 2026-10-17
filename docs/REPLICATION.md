# 复刻说明（obsidian-mineru）

本文记录本仓库如何从**丢失源码的打包产物** `main.js.orig` 反推出模块化 TypeScript 源码，
以及复刻过程中的验证手段、后续新增功能与已知取舍。

## 1. 背景

原始项目只留下一个 esbuild 打包后的 `main.js`（151,669 字节，压缩混淆、无 sourcemap）。
`manifest.json` / `styles.css` / `data.json` 完整保留，可直接沿用。

反推思路：

1. 备份原产物为 `main.js.orig`（不入库），保证任何时候都能回查；
2. 用脚本切出插件代码段（jszip 之后的 `require("obsidian")` 起）；
3. 提取字符串字面量、函数体、类结构，重建模块边界；
4. 按 Obsidian 插件惯例重组为 `src/**/*.ts`，保持行为等价；
5. 用 `scripts/check-parity.mjs` 自动比对产物，防止复刻过程中漏功能；
6. 在等价基础上按需求新增功能（见第 6 节），新增文案登记进 parity 基线。

## 2. 模块与原包符号对照

| 原包（压缩后） | 源码位置 | 说明 |
| --- | --- | --- |
| `zt` / `rawRequest / jsonRequest / parseEnvelope / getUploadUrls / putFile / pollBatch / downloadZip / testConnection` | `src/mineru/api.ts` | MinerU Standard Batch API 客户端（含瞬时错误重试） |
| `lt`（`class extends Error`，`name="MineruError"`） | `src/mineru/errors.ts` | 带 `code` 的 API 错误 |
| `Ft` | `src/mineru/errors.ts#errorMessageFor` | 错误码 → 中文 |
| `te` / `Se` / `Zt` / `Ht` / `ne` / `Ot` / `Qt` | `src/constants.ts` | 状态文案、错误码表、语言表、LLM 预设、API base、扩展名集合 |
| `Bt`（`convertFiles / ensureFolder / writeResult`）+ `Me` | `src/mineru/pipeline.ts` | 上传→轮询→解压→（分片合并）→写库管线 |
| `Xt` / `bt` / `Yt` / `jt` / `Jt` / `he` / `de` | `src/utils.ts` | sleep、文件名净化、data_id slug、相对路径、JSZip 解压、逐级建目录 |
| `It` / `pe` / `se` / `ae` | `src/markdown.ts` | `⟦MDC:n⟧` 占位符保护、图片链接改写、居中 HTML |
| `we` / `_e` | `src/translate/chunker.ts` | 分块、二分 |
| `ve` / `ye` / `be` | `src/translate/placeholders.ts` | frontmatter 拆分、系统提示词、title 翻译 |
| `xt` / `vt` | `src/translate/llm.ts` | OpenAI 兼容 / Anthropic 双引擎 |
| `Dt`（`translateFile / translateWithSplit / writeWithPolicy / uniquePath / maybeTranslateTitle / reveal`） | `src/translate/translator.ts` | 整篇翻译与落盘 |
| `Lt`（`ConversionManager`） | `src/ui/manager.ts` | 状态机 + 失败重试 + 报告合并 |
| `Mt`（`FileSuggestModal`） | `src/ui/file-suggest.ts` | 模糊选择可转换文件 / 多选 |
| `yt`（`ConversionWizard`）+ `oe` | `src/ui/wizard.ts`、`WIZARD_EXTRA_FORMATS` | 转换向导 |
| `Ut`（`MineruSettingTab`）+ `Mt`（`DEFAULT_SETTINGS`）+ `xe`（`mergeSettings`） | `src/settings.ts` | 设置页 |
| `jt`（`MineruPlugin`） | `src/main.ts` | 入口：命令、ribbon、文件右键菜单、图标状态 |
| `Fe` / `le` / `ce` | `EXTRA_FORMATS` / `TARGET_LANGUAGES` / `LLM_PRESETS` | 设置页选项表 |

## 3. 行为一致性校验

```bash
npm run build              # 产物 main.js
npm run check:parity       # 与 main.js.orig 比对
npm run check:parity -- --strict   # 基线之外的新增文案也算失败
npm run check:parity -- --update   # 登记新基线
```

校验内容：

- 原产物中**全部中文字面量**（UI 文案 / 提示 / 错误码说明 / 系统提示词）是否逐字出现在新产物中；
- **76 项关键标识符**（API 端点、URL、请求字段、CSS 类名、命令 id、设置字段、占位符协议等）；
- 新增文案与 `scripts/parity-baseline.json` 比对，防止"改文案"时误伤或漏登记。

当前结果：原包 168 项中文文案全覆盖，新增 48 项已登记基线。

## 4. 已确认的等价点

- 设置字段名与 `data.json` 完全一致（原包 30 个字段，新增字段见第 6 节）；
- 轮询节奏：3 秒一次、最长 30 分钟、超时抛 `TIMEOUT`、取消抛 `CANCELLED`；
- `extra_formats` 报 `-500` 时自动去掉该字段重试，且不再导出附加格式；
- 图片落库路径 `{输出文件夹}/{文件名}.assets/`，Markdown 链接改写为相对路径；
- 翻译占位符 `⟦MDC:n⟧` 保护代码块 / `$$公式$$` / `` `行内码` `` / `$行内公式$` / 图片链接；
- 输出命名 `{文件名}.{语言}.md`，冲突时 `(1)` 重命名或覆盖。

## 5. 原包遗留问题（保留现状并用测试锁定）

| 项 | 说明 |
| --- | --- |
| `splitInTwo` 的按行兜底分支不可达 | 首段总会先被赋给 `acc`，导致无空行文本整体作为前半段 |
| 「占位符未被正确还原」告警不可达 | `restore()` 会吃掉所有 `⟦MDC\d+⟧`（查不到就替换为空串），`leftover` 恒为 0 |
| 图片目录只建一级 | 复刻改为逐级创建 `ensureFolderLevels`，行为等价但更稳健 |

前两项属于**原包既有行为**，如要修复会改变行为，需在此处显式声明后再改（对应测试：
`tests/chunker.test.ts`、`tests/translator.test.ts`）。

## 6. 新增功能（原包没有）

### 6.1 失败重试

- `ConversionManager.retryFailed()`：只重跑本轮失败的文件，复用同一份 `ConvertOptions`；
- 报告按文件名合并，重试成功的文件会清除上一轮的 `error`（见 `mergeReports`）；
- 入口：向导「重试失败项」按钮、进度面板「重试失败项」、命令
  `MinerU：重试上次失败的转换`；
- 另有**网络层自动重试**：`rawRequest` 对 429/5xx 与网络异常按指数退避重试
  （`1.5s → 3s → 6s`），次数由设置 `maxAutoRetries` 控制（0 关闭）；
  重试耗尽后仍返回最后一次响应，保证原有「HTTP xxx：响应体」错误信息不丢失。

### 6.2 批量翻译队列

- `src/translate/queue.ts`：`TranslationQueue`，并发数由 `translationConcurrency`（1-8）控制；
- 支持取消（未开始的项标记为「已跳过」）、单项移除、清空、重置失败项、临时覆盖目标语言；
- `src/ui/translation-modal.ts`：批量翻译弹窗（多选 Markdown / 当前笔记 / 逐项进度 / 打开译文）；
- `MultiSelectSuggestModal`（`src/ui/file-suggest.ts`）：点击列表项切换勾选、底部「完成」提交；
- 文件右键菜单新增「用 MinerU 翻译所在文件夹」，命令
  `MinerU：批量翻译（队列）` / `MinerU：批量翻译整个文件夹`。

### 6.3 进度面板（弹窗化进度）

- `src/ui/progress-view.ts`：`ItemView`（`mineru-progress-view`），汇总转换与翻译队列状态；
- 任务开始时自动展开（设置 `autoOpenProgressView`），关闭向导/弹窗后任务继续后台跑；
- 面板内可直接「取消 / 重试失败项 / 重置失败项 / 清空 / 打开译文」；
- 侧边栏新增「进度面板」按钮（`showProgressButton`），命令 `MinerU：打开进度面板`。

### 6.4 覆盖策略

- 转换侧新增 `conversionCollisionPolicy`：`rename`（默认，追加 `(1)`）/ `overwrite` / `skip`；
- `overwrite` 会覆盖 Markdown、图片与附加产物（`modify` / `modifyBinary`）；
- `skip` 时计入 `report.skipped`，进度面板与向导都会显示跳过数量；
- 向导可每次临时调整，不必改全局设置。

### 6.5 大文件自动切分 → 转换 → 合并

- `src/mineru/split.ts`（pdf-lib）：`planPageRanges` 均分页区间、`needsSplit` 判超限、
  `splitPdf` 真正切 PDF（体积仍超限时递归二分）、`countPdfPages` 容错读取页数；
- `src/mineru/merge.ts`：`mergeParts` 按页码顺序合并 Markdown，图片统一改名为
  `p{分片号}_{原名}` 并重写链接，分片间插入 `<!-- MinerU 分片 x-y 页 -->`，
  可选去掉后续分片重复的一级标题；
- `src/mineru/pipeline.ts`：超限时把一个 PDF 拆成多个分片**放进同一批次**并发上传，
  轮询后按源文件归组合并，再写成一个 Markdown + 一个 `.assets` 目录；
- 进度事件带 `1/3 分片` 标记；**任一分片失败则整份文件失败**并报告失败分片的页码区间
  （避免静默丢内容）；
- 设置项：`autoSplitEnabled` / `autoSplitMaxPages`（默认 80）/ `autoSplitMaxSizeMB`（默认 100，上限 200）/
  `splitDedupeTitle`；向导可临时开关与改页数。

### 6.6 新增设置字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `conversionCollisionPolicy` | `"rename"` | 同名文件处理 |
| `maxAutoRetries` | `2` | 网络失败自动重试次数 |
| `autoSplitEnabled` | `true` | 大文件自动切分 |
| `autoSplitMaxPages` | `80` | 每片页数上限 |
| `autoSplitMaxSizeMB` | `100` | 每片体积上限 |
| `splitDedupeTitle` | `true` | 合并时去掉重复标题 |
| `translationConcurrency` | `2` | 批量翻译并发 |
| `autoOpenProgressView` | `true` | 任务开始自动展开进度面板 |
| `showProgressButton` | `true` | 侧边栏显示进度面板按钮 |

## 7. 测试

```bash
npm test        # 128 个用例
```

`tests/` 目录一览：

| 文件 | 覆盖内容 |
| --- | --- |
| `markdown.test.ts` | 占位符保护/还原、图片链接改写、居中 HTML |
| `chunker.test.ts` | 分块、二分（含原包不可达分支） |
| `utils.test.ts` | 文件名净化、slug、相对路径、JSZip 解包、逐级建目录 |
| `settings.test.ts` | 设置合并、错误码映射、状态文案 |
| `api.test.ts` | 信封解析、请求体组装、轮询/取消/超时、上传与下载兜底 |
| `pipeline.test.ts` | 写库、图片相对链接、附加格式、`-500` 降级、超限跳过 |
| `pipeline-extra.test.ts` | 覆盖/跳过策略、分片切分与合并、分片失败处理 |
| `split-merge.test.ts` | 页区间规划、真实 PDF 切分回读、合并去重与图片改名 |
| `queue.test.ts` | 队列并发、取消、重置、清空、选项覆盖 |
| `translator.test.ts` | frontmatter、分块进度、命名、冲突策略、截断二分 |
| `manager.test.ts` | 状态机流转、取消、失败重试与报告合并 |
| `plugin-smoke.test.ts` | 插件装配：命令注册、视图注册、ribbon 开关、提示文案 |

## 8. 安全提醒

`data.json` 含两枚明文密钥（MinerU Token 与某 LLM 服务 Key），已被 `.gitignore` 排除。
**建议尽快轮换这两枚密钥**，并在分享仓库前确认 `data.json` 未被提交。