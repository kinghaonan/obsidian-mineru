# Obsidian MinerU — 文档转换与翻译

在 Obsidian 中使用 [MinerU](https://mineru.net) 精准解析 API，将 PDF / Word / PPT / Excel / 图片批量转换为 Markdown（图片自动入库、可选 HTML 居中显示、可附加导出 DOCX / HTML / LaTeX），并支持调用自配的大模型（OpenAI 兼容接口或 Anthropic Claude）对库内 Markdown 进行分块翻译。

## 功能

### MinerU 转换
- 调用 MinerU Standard Batch API（`https://mineru.net/api/v4`）：申请上传地址 → 上传文件 → 轮询结果 → 下载并解压结果包
- 支持格式：`pdf doc docx ppt pptx xls xlsx png jpg jpeg jp2 webp gif bmp`（单文件上限 200MB）
- 解析模型可选 `vlm`（推荐）或 `pipeline`；可配置 OCR、公式识别、表格识别、识别语言
- 图片自动下载入库，Markdown 链接改写为相对路径；可选居中 HTML 显示 + 宽度控制 + 显示文件名
- 可附加导出 DOCX / HTML / LaTeX（服务端不支持时自动降级）
- 转换向导：模糊搜索选择多个文件、临时修改输出文件夹、实时进度列表；关掉面板后台继续跑，侧边栏图标显示运行状态

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

## 项目结构

```
src/
├── main.ts                 # 入口：装配客户端/管线/翻译器/管理器，注册命令、ribbon、右键菜单
├── settings.ts             # PluginSettings、默认值、合并逻辑、设置页
├── constants.ts            # API base、扩展名集合、错误码表、语言表、LLM 预设、状态文案
├── types.ts                # 共享类型
├── utils.ts                # 文件名净化、相对路径、JSZip 解压、逐级建目录
├── markdown.ts             # ⟦MDC:n⟧ 占位符、图片链接改写、居中 HTML
├── mineru/
│   ├── api.ts              # 申请上传地址 / PUT 上传 / 轮询 / 下载 zip / 测试连接
│   ├── pipeline.ts         # 上传→轮询→解压→写库完整管线
│   └── errors.ts           # MineruError + 错误码中文映射
├── translate/
│   ├── llm.ts              # OpenAI 兼容 / Anthropic 双引擎
│   ├── translator.ts       # 整篇翻译、冲突策略、reveal
│   ├── chunker.ts          # 分块与二分
│   └── placeholders.ts     # frontmatter 处理、系统提示词
└── ui/
    ├── manager.ts          # idle/running/done/failed 状态机（面板关闭后台继续跑）
    ├── wizard.ts           # 转换向导弹窗
    └── file-suggest.ts     # 模糊搜索可转换文件
```

## 开发

```bash
npm install
npm run dev          # 开发模式（watch）
npm run build        # 类型检查 + 产物压缩输出 main.js
npm test             # 单元测试（esbuild 打包测试 → node --test）
npm run typecheck    # 仅类型检查（src + tests）
npm run check:parity # 与原打包产物 main.js.orig 做一致性比对
npm run verify       # typecheck + build + test + parity 一条龙
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

本项目由压缩后的打包产物反推重建，模块与原包符号的对照表、校验方式、以及已知的原包遗留问题，
见 [`docs/REPLICATION.md`](docs/REPLICATION.md)。

> ⚠️ 仓库中的 `data.json` 含两枚明文密钥（MinerU Token 与 LLM 服务 Key），已被 `.gitignore` 排除；请尽快轮换。