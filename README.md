# Obsidian MinerU — 文档转换与翻译

在 Obsidian 中使用 [MinerU](https://mineru.net) 精准解析 API，将 PDF / Word / PPT / Excel / 图片批量转换为 Markdown（图片自动入库、可选 HTML 居中显示、可附加导出 DOCX / HTML / LaTeX），并支持调用自配的大模型（OpenAI 兼容接口或 Anthropic Claude）对库内 Markdown 进行分块翻译。

## 功能

### MinerU 转换
- 调用 MinerU Standard Batch API（`https://mineru.net/api/v4`）：申请上传地址 → 上传文件 → 轮询结果 → 下载并解压结果包
- 支持格式：`pdf doc docx ppt pptx xls xlsx png jpg jpeg jp2 webp gif bmp`（单文件上限 200MB）
- 解析模型可选 `vlm`（推荐）或 `pipeline`；可配置 OCR、公式识别、表格识别、识别语言
- 图片自动下载入库，Markdown 链接改写为相对路径；可选居中 HTML 显示 + 宽度控制 + 显示文件名
- 可附加导出 DOCX / HTML / LaTeX（服务端不支持时自动降级）
- 转换向导：模糊搜索选择多个文件、临时修改输出文件夹与冲突策略、实时进度列表
- 关掉面板后台继续跑，侧边栏图标显示运行状态，右侧「MinerU 进度」面板随时回看

### 大文件自动切分（新增）
- PDF 页数或体积超过 MinerU 上限时自动切成多个分片，**同一批次并发上传**
- 按页码顺序把各分片 Markdown 合并回一篇，图片自动加 `p{分片}_` 前缀避免互相覆盖
- 分片之间插入 `<!-- MinerU 分片 x-y 页 -->` 注释，可选自动去掉重复的一级标题
- 任一分片失败则整份文件失败，并明确报告失败分片的页码区间（不静默丢内容）

### 图注识别与图片命名（新增）
- 自动识别图注（`Fig. 1.2`、`Figure 3-1`、`图 2-1`、`Fig. P1.4` 等格式），覆盖约 **86%** 的图片
- 图片按图注命名：`Fig.1.2-The-cylindrical-coordinate-system.jpg`，比哈希名好认、好检索
- 图注渲染在图片下方（`<span class="mineru-figcaption">`）；未识别到图注时回退显示文件名
- 支持子图组合：多张图共用一个图注时只显示一次，子图按 `Fig.4.9-Maximum-energy-case.jpg` 命名
- 防误判：只有与图片同段落的图注才会被采用，正文里的 `Figure 3.1 shows…` 不会被误抓
- 三个开关可分别控制「命名 / 展示 / 删除原文图注行」

### 容错与批处理（新增）
- **失败重试**：网络层瞬时错误（429/5xx）指数退避自动重试；文件级失败可一键「重试失败项」
- **批量翻译队列**：多选 Markdown / 整文件夹入队，按并发（1-8）翻译，可取消、单项重试
- **进度面板**：侧边栏 `MinerU 进度` 视图，转换与翻译队列状态、取消、重试、打开译文一处搞定
- **覆盖策略**：目标文件已存在时可选「自动重命名 / 覆盖 / 跳过」

### LLM 翻译
- OpenAI 兼容接口（OpenAI / DeepSeek / 通义千问 / Kimi / Ollama 预设一键填入）或 Anthropic Claude
- 按空行分段分块翻译；代码块、行内代码、数学公式、图片链接用占位符保护，不被翻译
- 输出超限截断时自动二分重译；YAML frontmatter 可保留、可仅翻译 title
- 输出 `{文件名}.{语言代码}.md`，文件名冲突可自动重命名或覆盖

## 使用

1. 到 [mineru.net/apiManage/token](https://mineru.net/apiManage/token) 获取 API Token，在设置中填入
2. （可选翻译）在设置 → LLM 翻译设置中配置服务与 API Key
3. 命令面板 / 侧边栏 / 文件右键菜单触发：
   - **MinerU：打开转换向导**
   - **MinerU：将当前文件转换为 Markdown**
   - **MinerU：翻译当前笔记**
   - **MinerU：批量翻译（队列）**
   - **MinerU：批量翻译整个文件夹**
   - **MinerU：重试上次失败的转换**
   - **MinerU：打开进度面板**

## 项目结构

```
src/
├── main.ts                 # 入口：装配客户端/管线/翻译器/队列/管理器，注册命令、ribbon、右键菜单、进度视图
├── settings.ts             # PluginSettings、默认值、合并逻辑、设置页
├── constants.ts            # API base、扩展名集合、错误码表、语言表、LLM 预设、状态文案、切分/重试默认值
├── types.ts                # 共享类型
├── utils.ts                # 文件名净化、相对路径、JSZip 解压、逐级建目录
├── markdown.ts             # ⟦MDC:n⟧ 占位符、图片链接改写、居中 HTML
├── mineru/
│   ├── api.ts              # 申请上传地址 / PUT 上传 / 轮询 / 下载 zip / 测试连接 / 自动重试
│   ├── pipeline.ts         # 上传→轮询→解压→（分片合并）→写库
│   ├── split.ts            # PDF 页区间规划与真实切分（pdf-lib）
│   ├── merge.ts            # 分片 Markdown 与图片合并
│   └── errors.ts           # MineruError + 错误码中文映射
├── translate/
│   ├── llm.ts              # OpenAI 兼容 / Anthropic 双引擎
│   ├── translator.ts       # 整篇翻译、冲突策略、reveal
│   ├── queue.ts            # 批量翻译队列（并发/取消/重置）
│   ├── chunker.ts          # 分块与二分
│   └── placeholders.ts     # frontmatter 处理、系统提示词
└── ui/
    ├── manager.ts          # 状态机 + 失败重试 + 报告合并
    ├── wizard.ts           # 转换向导弹窗
    ├── translation-modal.ts # 批量翻译弹窗
    ├── progress-view.ts    # 侧边栏进度面板（ItemView）
    └── file-suggest.ts     # 单选/多选文件搜索
```

## 开发

```bash
npm install
npm run dev          # 开发模式（watch）
npm run build        # 类型检查 + 产物压缩输出 main.js
npm test             # 单元测试（esbuild 打包测试 → node --test）
npm run typecheck    # 仅类型检查（src + tests）
npm run check:parity # 与原打包产物 main.js.orig 做一致性比对
npm run verify       # typecheck + build + test + parity(--strict) 一条龙
```

手动安装：把 `manifest.json`、`main.js`、`styles.css` 三个文件放入
`<库目录>/.obsidian/plugins/obsidian-mineru/`，重启 Obsidian 后启用。

### 测试

测试不引入额外依赖：用 esbuild 把 `tests/*.test.ts` 打包到 `.test-build/`，
并把 `obsidian` 模块别名到 `tests/stubs/obsidian.ts`（内存 Vault、可控 `requestUrl` 与 `Notice`），
再交给 Node 内置 `node:test` 运行。

```bash
npm test
```

## 复刻说明

本项目由压缩后的打包产物反推重建，模块与原包符号的对照表、校验方式、原包遗留问题，
以及新增功能的实现细节，见 [`docs/REPLICATION.md`](docs/REPLICATION.md)。

> ⚠️ 仓库中的 `data.json` 含两枚明文密钥（MinerU Token 与 LLM 服务 Key），已被 `.gitignore` 排除；请尽快轮换。