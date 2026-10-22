# dsh-weknora-archive

**中文** · [English](#english)

把 DSH（DeepSeek Harness）会话**增量归档**进 [WeKnora](https://github.com/Tencent/WeKnora) 知识库的 host 端插件；v0.3 起新增两大能力：**无感知工作画像**（对话中自动记录习惯与风格，本地存储 + 人工闸门）与**项目真实情况简报**（会话 + git + 知识库聚合，一键掌握/同步）。是官方只读插件 `@wxg-prc-cpg/dsh-weknora`（4 个检索工具）的**写入侧互补**。

## 功能（10 个工具）

### 归档（RAG + wiki）

| 工具 | 说明 |
|---|---|
| `weknora_archive_session` | 归档项目会话：解压 `session.v3/v4.jsonl.zstd` → 启发式总结 → 按标题去重上传；库不存在自动新建；首跑附 `00_项目总览.md`；支持 `dry_run`。库开启 wiki 模式时，WeKnora 服务端自动生成 LLM 归纳页 |
| `weknora_archive_status` | 只读：本机会话项目目录、会话数、目标库归档文档与解析状态 |
| `weknora_archive_list_knowledge_bases` | 只读：列出可见知识库 |
| `weknora_archive_create_knowledge_base` | 新建知识库（注意新建库需在 WeKnora 端配置 embedding 模型） |

### 无感知工作画像（v0.3 新增，本地存储不进知识库）

| 工具 | 说明 |
|---|---|
| `weknora_archive_profile_capture` | 对话中用户随口透露的偏好/习惯/风格/环境事实/项目约定，agent 直接调用记录（**无需用户确认**）。显式指令（含「以后/一律/别再/我喜欢」）自动生效，其余进待审核 |
| `weknora_archive_profile_scan` | 扫描项目最近会话，启发式正则（无 LLM）挖候选；显式指令自动生效 |
| `weknora_archive_profile_brief` | 输出当前画像简报，供会话开始时快速对齐「这个用户怎么共事」 |
| `weknora_archive_profile_review` | 人工闸门：list 待审核 / activate / retire / edit |

画像工程标准：生命周期（candidate→active/retired）、**纠正即替换**（含「而不是/其实是/改成」等纠正句式时，同类型旧规则自动退位，绝不留两条矛盾的生效条目）、原子写（tmp+rename）、append-only journal 审计。存储位置 `~/.dsh/plugin-data/dsh-weknora-archive/`（`dataDir` 可配）。

### 项目真实情况（v0.3 新增）

| 工具 | 说明 |
|---|---|
| `weknora_archive_project_brief` | 聚合项目地面真相：本地最近会话主题 + git 分支/最近提交/未提交改动 + WeKnora 知识库沉淀与 wiki 状态 → 一份简报。**任何时间接手/恢复项目先调它** |
| `weknora_archive_project_state_sync` | 把状态快照幂等写入同名知识库的「项目状态」文档；WeKnora 服务端自动重新摘要并生成 wiki 页，RAG 永远携带最新状态 |

## 接线建议（让"无感知"真正发生）

在用户全局 `AGENTS.md` 里加两条指令即可闭环：

```markdown
- 用户随口透露的偏好/习惯/环境事实：调 weknora_archive_profile_capture 直接记，不要问，一行回执。
- 接手/恢复项目时：先调 weknora_archive_project_brief 再回答；长任务收尾调 weknora_archive_project_state_sync。
```

## 安装

```bash
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add /path/to/dsh-weknora-archive
```

## 配置

| 字段 | 环境变量 | 说明 |
|---|---|---|
| `baseUrl` | `WEKNORA_ARCHIVE_BASE_URL` | WeKnora 部署地址（裸域名或 `/api/v1` 结尾均可） |
| `apiKey` | `WEKNORA_ARCHIVE_API_KEY` | 具备写入/摄取能力的 scoped API key |
| `knowledgeBaseId` | `WEKNORA_ARCHIVE_KB_ID` | 可选：固定目标库；缺省按项目名自动匹配/新建 |
| `sessionsDir` | `WEKNORA_ARCHIVE_SESSIONS_DIR` | 可选：会话存储根目录；缺省自动探测 `<harness>/sessions` |
| `maxSummaryChars` | `WEKNORA_ARCHIVE_MAX_SUMMARY_CHARS` | 单篇总结上限（默认 8000） |
| `dataDir` | `WEKNORA_ARCHIVE_DATA_DIR` | 可选：画像存储目录；缺省 `~/.dsh/plugin-data/dsh-weknora-archive` |

## 隐私说明

- 会话数据**只发往你自己配置的 WeKnora 实例**；工作画像**只存本地文件**，两者都不经过任何第三方服务。
- API key 只用于请求头 `X-API-Key`，**绝不写入日志、异常信息、工具结果或本文档**；日志输出前统一走 `redactConfig()` 脱敏。
- 总结与画像挖掘均为**启发式规则（无 LLM 参与）**，凭据类内容不收录完整值。

## API 兼容性

认证头 `X-API-Key`（非 Bearer），kebab-case 路由：`GET/POST /knowledge-bases`、`GET /knowledge-bases/{id}/knowledge`、`POST /knowledge-bases/{id}/knowledge/file`、`POST /knowledge-bases/{id}/knowledge/manual`、`PUT /knowledge/manual/{id}`、`POST /knowledge/{id}/reparse`、`GET /knowledgebase/{id}/wiki/stats`（**顶层字段，非 data 包装**）。**以你的 WeKnora 实际 API 为准**；若有出入只需调整 `lib/client.js`。

## 本地单测

```bash
npm test   # node test/mock.test.mjs：mock 数据 + mock 客户端，无网络无凭据（23 项）
```

## 已知边界

- 总结与画像挖掘是启发式抽取，不是 LLM 精炼；WeKnora 侧的摘要/wiki 页是 LLM 生成（服务端自动）。
- 正在运行的会话文件可能解压失败，会被跳过（下次归档自动补上）。
- 项目路径从会话目录名反解（dsh 编码把 `/` 和 `-` 都折叠成 `-`），含 `-` 的路径段会解析失败 → git 聚合静默跳过，不影响其余简报内容。
- 新建库的 embedding 配置需在 WeKnora 端完成（PUT 接口会静默丢弃 embedding 字段）。
- WeKnora PUT /models/{id} 会静默丢弃漏传的字段（含 source）——改模型配置时必须带全量字段，或用 `/models/{id}/credentials` 子端点改 key。

---

<a id="english"></a>
# dsh-weknora-archive (English)

A DeepSeek Harness host plugin that **incrementally archives DSH sessions** into a [WeKnora](https://github.com/Tencent/WeKnora) knowledge base — and since v0.3, also **passively captures work habits/style** into a local profile store and **aggregates per-project ground-truth briefs** (sessions + git + WeKnora). Write-side complement to the read-only official `@wxg-prc-cpg/dsh-weknora` plugin (4 retrieval tools).

## Tools (10)

| Tool | Purpose |
|---|---|
| `weknora_archive_session` | Archive a project's sessions: decompress `session.v3/v4.jsonl.zstd` → heuristic summarize → dedupe by title → upload; auto-creates the KB; overview doc on first run; `dry_run` supported. When the KB has wiki mode on, WeKnora generates LLM wiki pages server-side. |
| `weknora_archive_status` / `_list_knowledge_bases` / `_create_knowledge_base` | Read-only status/listing; KB creation (embedding model must be configured WeKnora-side for fresh KBs). |
| `weknora_archive_profile_capture` | Passively record a user preference/habit/style fact mid-conversation (no confirmation). Explicit directives ("always/never/from now on") auto-activate; the rest go to the review inbox. |
| `weknora_archive_profile_scan` | Mine recent sessions for habit/style candidates with regex heuristics (LLM-free). |
| `weknora_archive_profile_brief` | Render the active profile briefing for session-start alignment. |
| `weknora_archive_profile_review` | Human gate: list / activate / retire / edit entries. |
| `weknora_archive_project_brief` | Aggregate ground truth — recent session topics, git branch/commits/dirty state, WeKnora knowledge + wiki status — into one readable brief. Call when (re-)orienting on a project at any time. |
| `weknora_archive_project_state_sync` | Idempotently push the state snapshot into the matching KB as a "项目状态" document; WeKnora re-summarizes and wiki-fies it server-side. |

Profile engineering standard: lifecycle (candidate→active/retired), corrections supersede contradictory rules (never two conflicting active rows), atomic writes (tmp+rename), append-only journal. Storage: `~/.dsh/plugin-data/dsh-weknora-archive/` (configurable via `dataDir`).

Wiring suggestion — add two lines to the user-global `AGENTS.md` and the passive loop is closed: capture facts via `profile_capture` whenever the user reveals a preference; call `project_brief` when (re-)orienting on a project and `project_state_sync` after long tasks.

## Install

```bash
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add /path/to/dsh-weknora-archive
```

## Configuration

Uses DSH's official plugin-config mechanism; every value falls back to an environment variable (**no key hardcoded anywhere**):

| Field | Env var | Meaning |
|---|---|---|
| `baseUrl` | `WEKNORA_ARCHIVE_BASE_URL` | Your WeKnora deployment root or `/api/v1` root |
| `apiKey` | `WEKNORA_ARCHIVE_API_KEY` | Scoped WeKnora API key with ingest capability |
| `knowledgeBaseId` | `WEKNORA_ARCHIVE_KB_ID` | Optional fixed target KB; otherwise matched/created per project |
| `sessionsDir` | `WEKNORA_ARCHIVE_SESSIONS_DIR` | Optional sessions root; auto-detected when empty |
| `maxSummaryChars` | `WEKNORA_ARCHIVE_MAX_SUMMARY_CHARS` | Per-summary cap (default 8000) |
| `dataDir` | `WEKNORA_ARCHIVE_DATA_DIR` | Optional profile store dir; default `~/.dsh/plugin-data/dsh-weknora-archive` |

## Privacy

- Session data goes **only to the WeKnora instance you configure**; the work profile lives **only in local files** — no third party involved anywhere.
- The API key is used solely in the `X-API-Key` header and is **never logged, never embedded in errors, tool results, or this README**; all log paths go through `redactConfig()`.
- Summaries and profile mining are **heuristic rules without any LLM**; credential-looking values are never recorded in full.

## API compatibility

Auth is the `X-API-Key` header (not Bearer); kebab-case routes: `GET/POST /knowledge-bases`, `GET /knowledge-bases/{id}/knowledge`, `POST /knowledge-bases/{id}/knowledge/file`, `POST /knowledge-bases/{id}/knowledge/manual`, `PUT /knowledge/manual/{id}`, `POST /knowledge/{id}/reparse`, `GET /knowledgebase/{id}/wiki/stats` (**top-level fields, not data-wrapped**). **Defer to your actual WeKnora API**; if it differs, only `lib/client.js` needs changes.

## Tests

```bash
npm test   # mock data + mock client, no network or credentials required (23 assertions)
```

## Known limits

- Summaries and profile mining are heuristic extractions, not LLM-polished prose; WeKnora-side summaries/wiki pages ARE LLM-generated (server-side, automatic).
- A live session file may fail to decompress and is skipped (picked up on the next run).
- Project paths are recovered from encoded session dir names; dsh folds both `/` and `-` into `-`, so segments containing `-` fail to decode → git aggregation is skipped silently, the rest of the brief is unaffected.
- Embedding configuration for newly created KBs must be done on the WeKnora side.
- WeKnora `PUT /models/{id}` silently drops omitted fields (including `source`) — always send the full field set, or use the `/models/{id}/credentials` sub-endpoint for key changes.

## License

MIT
