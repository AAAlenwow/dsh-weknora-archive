# dsh-weknora-archive

**中文** · [English](#english)

把 DSH（DeepSeek Harness）会话**增量归档**进 [WeKnora](https://github.com/Tencent/WeKnora) 知识库的 host 端插件。是官方只读插件 `@wxg-prc-cpg/dsh-weknora`（4 个检索工具）的**写入侧互补**。

## v0.4.0 新增

- **真实入库状态闭环**：上传成功 ≠ 入库成功。每篇文档上传后按返回的文档 id 轮询 WeKnora 解析状态（`parseObservationMs` 窗口），以 `completed / parsing / failed` 落入归档清单；窗口内未完成记 `parsing`，绝不高报。
- **`archive-manifest.json` 归档清单**：每次运行原子写入 `~/.dsh/plugin-data/dsh-weknora-archive/reports/`（可配 `reportDir`），只含元数据（标题/状态/项目/KB id），不含会话正文、API 地址或密钥。
- **`weknora_archive_visualize` 可视化工具**：把清单渲染成**自包含的本地 three.js「知识入库星图」HTML**（内嵌 three.js，无 CDN、无网络请求，`file://` 直接打开）。WebGL 不可用或系统 `prefers-reduced-motion` 时自动降级为静态报告；报告生成失败只告警，绝不影响归档结果。关闭方式：`WEKNORA_ARCHIVE_VISUALIZATION=false`。

## 功能

| 工具 | 说明 |
|---|---|
| `weknora_archive_auto` | **全量自动归档**：扫描本机所有 DSH 项目，把每个项目的会话增量归档进各自的知识库（按项目名自动匹配/新建），已归档自动跳过，可重复执行；单个项目失败不影响其余项目。设计为被定时任务调用，实现无人值守归档；`project_keyword` 可选过滤，`dry_run` 预览 |
| `weknora_archive_visualize` | 只读：把最近一次（或指定）归档清单渲染成自包含的本地 three.js「知识入库星图」HTML 报告，含真实解析状态。不上传、不改归档状态 |
| `weknora_archive_session` | 归档某个项目的 DSH 会话：定位会话目录 → 解压会话存储 → 提取对话 → 总结 → 按标题去重后上传；知识库不存在时按项目名自动新建；首次归档附 `00_项目总览.md`；支持 `dry_run` 预览 |
| `weknora_archive_status` | 只读：列出本机会话项目目录与会话数，查看目标知识库内已归档文档与解析状态 |
| `weknora_archive_list_knowledge_bases` | 只读：列出该凭据可见的知识库 |
| `weknora_archive_create_knowledge_base` | 新建知识库（注意：新建库可能需在 WeKnora 端配置 embedding 模型，否则文档解析失败） |

工具名前缀可通过 `toolPrefix` 配置（默认 `weknora_archive`）。工具描述中英双语。

## 安装

```bash
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add /path/to/dsh-weknora-archive
```

## 配置

走 DSH 官方插件配置机制：插件 bundle 自带 `cordis.patch.yml`，默认从环境变量读取（**key 不落地、不入库**）：

| 字段 | 环境变量 | 说明 |
|---|---|---|
| `baseUrl` | `WEKNORA_ARCHIVE_BASE_URL` | WeKnora 部署地址（裸域名或 `/api/v1` 结尾均可），如 `http://weknora.example.com` |
| `apiKey` | `WEKNORA_ARCHIVE_API_KEY` | 具备写入/摄取能力的 scoped API key |
| `knowledgeBaseId` | `WEKNORA_ARCHIVE_KB_ID` | 可选：固定目标库；缺省按项目名自动匹配/新建 |
| `sessionsDir` | `WEKNORA_ARCHIVE_SESSIONS_DIR` | 可选：会话存储根目录；缺省自动探测 `<harness>/sessions` |
| `maxSummaryChars` | `WEKNORA_ARCHIVE_MAX_SUMMARY_CHARS` | 单篇总结上限（默认 8000） |
| `llmBaseUrl` | `WEKNORA_ARCHIVE_LLM_BASE_URL` | 可选：OpenAI 兼容端点（如 `https://api.minimax.chat/v1`），用于总结精炼 |
| `llmApiKey` | `WEKNORA_ARCHIVE_LLM_API_KEY` | 可选：该端点的 API key |
| `llmModel` | `WEKNORA_ARCHIVE_LLM_MODEL` | 可选：模型名，如 `MiniMax-M2` |
| `llmTimeoutMs` | `WEKNORA_ARCHIVE_LLM_TIMEOUT_MS` | 可选：精炼调用超时（默认 60000） |
| `embeddingModelId` | `WEKNORA_ARCHIVE_EMBEDDING_MODEL_ID` | **强烈建议**：自动新建知识库时携带的 embedding 模型 id——不设则新库所有文档解析失败（parse_status=failed） |
| `reportDir` | `WEKNORA_ARCHIVE_REPORT_DIR` | 可选：归档清单与报告目录（默认 `~/.dsh/plugin-data/dsh-weknora-archive/reports`） |
| `visualization` | `WEKNORA_ARCHIVE_VISUALIZATION` | 设 `false` 完全跳过清单/报告生成（归档本身不受影响） |
| `motion` | `WEKNORA_ARCHIVE_MOTION` | 设 `false` 生成静态星图（系统 reduced-motion 也会自动转静态） |
| `parseObservationMs` | `WEKNORA_ARCHIVE_PARSE_OBSERVATION_MS` | 上传后观察解析状态的时间窗（默认 60000；未完成记 `parsing`，绝不高报） |
| `parsePollMs` | `WEKNORA_ARCHIVE_PARSE_POLL_MS` | 解析状态轮询间隔（默认 1000） |

> **LLM 精炼默认关闭**：三个 `llm*` 字段必须同时提供才开启。开启后，归档时把**启发式总结文本**（非会话原文）发给该端点做一次精炼；任何失败都自动回退启发式总结，绝不影响归档本身。注意这意味着总结文本会发往你配置的模型服务商。

### 定时全自动归档（推荐配方）

在 DSH 里建一个每日提醒（如每晚 22:00），prompt 一句话即可：

```text
调用 weknora_archive_auto 工具（不要带 dry_run），把返回的汇总原样转告我；有失败项目的列出失败原因。
```

去重按知识库内文档标题判定，重复执行是幂等的——漏跑、多跑都不会产生重复文档。改过 `toolPrefix` 的，提醒里的工具名用对应前缀（如 `my_prefix_auto`）。

> 精炼有最小长度门槛：启发式总结不足约 200 字符时直接采用原文、不发模型请求（派工型会话等低信息场景不值得花这次调用）。

也可把 `cordis.patch.yml` 的 insert 行拷进 profile 自己的 `cordis.patch.yml` 直接填值（注意文件权限）。

## 隐私说明

- 会话数据**只发往你自己配置的 WeKnora 实例**，插件不经过任何第三方服务。
- API key 只用于请求头 `X-API-Key`，**绝不写入日志、异常信息、工具结果或本文档**；日志输出前统一走 `redactConfig()` 脱敏（LLM key 同样脱敏）。
- 总结默认**启发式规则生成（无 LLM 参与）**，凭据类内容不收录完整值；仅当你显式配置 `llm*` 三字段时，才会把总结文本发给你指定的模型服务商做精炼，且任何失败自动回退启发式结果。
- 归档清单与入库报告**只写本机**（默认 `~/.dsh/plugin-data/`），仅含标题/状态/项目名/KB id 等元数据，无会话正文、无 API 地址、无密钥；报告页 CSP 禁止一切网络请求。

## API 兼容性

认证头为 `X-API-Key`（非 Bearer），路由中横线风格：`GET/POST /knowledge-bases`、`GET /knowledge-bases/{id}/knowledge`、`POST /knowledge`（multipart 上传 Markdown）、`POST /knowledge/{id}/reparse`。**以你的 WeKnora 实际 API 为准**；若有出入只需调整 `lib/client.js`。

## 本地单测

```bash
npm test   # node test/mock.test.mjs，mock 数据 + mock 客户端，无需网络与凭证
```

## 已知边界

- 总结默认是启发式抽取；配置 `llm*` 三字段后可自动精炼，仍不是全文重写。
- 正在运行的会话文件可能解压失败，会被跳过（下次归档自动补上）。
- 新建库的 embedding 配置需在 WeKnora 端完成（PUT 接口会静默丢弃 embedding 字段）。
- 解析状态观察窗（默认 60s）内未完成的文档记为 `parsing` 而非成功；可用 `weknora_archive_status` 或 `weknora_archive_visualize` 随后复核。
- 入库报告为自包含 HTML（内嵌 three.js，约 350KB/份），只存本地，不含会话正文。

---

## License

MIT — see [LICENSE](./LICENSE). The bundled `visualizer/vendor/three.module.min.js` is part of [three.js](https://threejs.org) (MIT); its license text ships in `visualizer/vendor/THREE-LICENSE`.

---

<a id="english"></a>
# dsh-weknora-archive (English)

A DeepSeek Harness host plugin that **incrementally archives DSH sessions** into a [WeKnora](https://github.com/Tencent/WeKnora) knowledge base — the write-side complement to the official read-only `@wxg-prc-cpg/dsh-weknora` plugin (4 retrieval tools).

## What's new in v0.4.0

- **Verified ingestion loop**: an HTTP upload success is NOT ingestion. Each uploaded document is polled by its real document id for WeKnora's parse status (`parseObservationMs` window) and recorded as `completed / parsing / failed` in the archive manifest — never over-reported.
- **`archive-manifest.json`**: written atomically per run under `~/.dsh/plugin-data/dsh-weknora-archive/reports/` (configurable). Metadata only — no transcripts, no URLs, no keys.
- **`weknora_archive_visualize`**: renders the manifest as a **self-contained local three.js "ingestion star map" HTML** (three.js embedded, no CDN, no network, opens straight from `file://`). Falls back to a static report without WebGL or under `prefers-reduced-motion`; report failures never affect archiving. Disable with `WEKNORA_ARCHIVE_VISUALIZATION=false`.

## Tools

| Tool | Purpose |
|---|---|
| `weknora_archive_auto` | **Auto-archive sweep**: scan ALL local DSH projects and incrementally archive each project's sessions into its per-project knowledge base (matched/created by project name), skipping what is already archived; one failing project never aborts the sweep. Designed for a nightly scheduled task so archiving runs unattended; optional `project_keyword` filter and `dry_run` preview. |
| `weknora_archive_visualize` | Read-only: render the latest (or an explicit) archive manifest as a self-contained local three.js "ingestion star map" HTML report with real parse statuses. Never uploads, never mutates archive state. |
| `weknora_archive_session` | Archive a project's sessions: locate session dirs → decompress session storage → extract conversation → summarize → dedupe by document title → upload. Auto-creates the knowledge base by project name when absent; adds a `00_项目总览.md` overview on first run; `dry_run` supported. |
| `weknora_archive_status` | Read-only: list local session project dirs with counts, and documents already in a target KB with parse status. |
| `weknora_archive_list_knowledge_bases` | Read-only: list visible knowledge bases. |
| `weknora_archive_create_knowledge_base` | Create a KB (a fresh KB may need an embedding model configured on the WeKnora side). |

Prefix is configurable via `toolPrefix` (default `weknora_archive`). Tool descriptions are bilingual (EN/中文).

## Install

```bash
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add /path/to/dsh-weknora-archive
```

## Configuration

Uses DSH's official plugin-config mechanism: the bundle ships a `cordis.patch.yml` that reads environment variables by default (**no key hardcoded anywhere**):

| Field | Env var | Meaning |
|---|---|---|
| `baseUrl` | `WEKNORA_ARCHIVE_BASE_URL` | Your WeKnora deployment root or `/api/v1` root (placeholder in this repo — set your own) |
| `apiKey` | `WEKNORA_ARCHIVE_API_KEY` | Scoped WeKnora API key with ingest capability |
| `knowledgeBaseId` | `WEKNORA_ARCHIVE_KB_ID` | Optional fixed target KB; otherwise matched/created per project |
| `sessionsDir` | `WEKNORA_ARCHIVE_SESSIONS_DIR` | Optional sessions root; auto-detected when empty |
| `maxSummaryChars` | `WEKNORA_ARCHIVE_MAX_SUMMARY_CHARS` | Per-summary cap (default 8000) |
| `llmBaseUrl` | `WEKNORA_ARCHIVE_LLM_BASE_URL` | Optional OpenAI-compatible endpoint for summary refinement (e.g. `https://api.minimax.chat/v1`) |
| `llmApiKey` | `WEKNORA_ARCHIVE_LLM_API_KEY` | Optional API key for that endpoint |
| `llmModel` | `WEKNORA_ARCHIVE_LLM_MODEL` | Optional model name |
| `llmTimeoutMs` | `WEKNORA_ARCHIVE_LLM_TIMEOUT_MS` | Optional refine-call timeout (default 60000) |
| `embeddingModelId` | `WEKNORA_ARCHIVE_EMBEDDING_MODEL_ID` | **Strongly recommended**: embedding model id applied to auto-created KBs — without it every document in a fresh KB fails to parse (`parse_status=failed`) |
| `reportDir` | `WEKNORA_ARCHIVE_REPORT_DIR` | Optional directory for manifests and reports (default `~/.dsh/plugin-data/dsh-weknora-archive/reports`) |
| `visualization` | `WEKNORA_ARCHIVE_VISUALIZATION` | Set `false` to skip manifest/report generation entirely (archiving is unaffected either way) |
| `motion` | `WEKNORA_ARCHIVE_MOTION` | Set `false` for a static star map (system reduced-motion also forces static) |
| `parseObservationMs` | `WEKNORA_ARCHIVE_PARSE_OBSERVATION_MS` | Parse-status observation window after upload (default 60000; unfinished stays `parsing`, never over-reported) |
| `parsePollMs` | `WEKNORA_ARCHIVE_PARSE_POLL_MS` | Parse-status poll interval (default 1000) |

> **LLM refinement is OFF by default**: all three `llm*` fields must be provided together. When enabled, the *heuristic summary text* (not the raw transcript) is sent to that endpoint once per archived session for polishing; any failure silently falls back to the heuristic summary. Note this means summary text is sent to the model provider you configure.

### Unattended auto-archive (recommended recipe)

Create a daily DSH reminder (e.g. 22:00) whose prompt is one line:

```text
Call the weknora_archive_auto tool (no dry_run) and relay the returned summary verbatim; list any failed projects with their errors.
```

Deduplication keys on the document titles already in each KB, so the sweep is idempotent — missed or repeated runs never produce duplicates. If you changed `toolPrefix`, use the matching tool name in the reminder (e.g. `my_prefix_auto`).

> Refinement has a minimum-length threshold: heuristic summaries under ~200 characters are uploaded as-is without a model call (low-information sessions like dispatch-only ones are not worth the call).

Alternatively copy the insert row into your profile's own `cordis.patch.yml` with literal values (mind file permissions).

## Privacy

- Session data goes **only to the WeKnora instance you configure** — no third-party service involved.
- The API key is used solely in the `X-API-Key` header and is **never logged, never embedded in errors, tool results, or this README**; all log paths go through `redactConfig()` (the optional LLM key is redacted the same way).
- Summaries are produced by **heuristic rules without any LLM by default**, and credential-looking values are never recorded in full. Only when you explicitly configure the `llm*` fields is the summary text sent to the model provider you chose — and any refine failure falls back to the heuristic result.

## API compatibility

Auth is the `X-API-Key` header (not Bearer); kebab-case routes: `GET/POST /knowledge-bases`, `GET /knowledge-bases/{id}/knowledge`, `POST /knowledge` (multipart Markdown upload), `POST /knowledge/{id}/reparse`. **Defer to your actual WeKnora API**; if it differs, only `lib/client.js` needs changes.

## Tests

```bash
npm test   # mock data + mock client, no network or credentials required
```

## Known limits

- Summaries are heuristic extractions by default; configure the `llm*` fields for automatic refinement — still not a full rewrite of the transcript.
- A live session file may fail to decompress and is skipped (picked up on the next run).
- Embedding configuration for newly created KBs must be done on the WeKnora side.
- Documents not finished parsing within the observation window (default 60s) stay `parsing`, not success; re-check later via `weknora_archive_status` or `weknora_archive_visualize`.
- The visual report is a self-contained HTML (~350KB with three.js embedded), stored locally only, containing no transcript text.

## License

MIT
