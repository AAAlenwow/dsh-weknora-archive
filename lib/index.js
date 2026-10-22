/**
 * dsh-weknora-archive: DeepSeek Harness host plugin that incrementally
 * archives DSH sessions into a WeKnora knowledge base (the write-side
 * complement to the read-only official dsh-weknora plugin).
 * @module dsh-weknora-archive
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { WeknoraClient } from './client.js';
import { resolveConfig, redactConfig } from './config.js';
import { listProjectDirs, listSessions, readSessionText, matchProjectDirs } from './session-reader.js';
import { archiveProject } from './archive.js';
import {
  captureProfileEntry, listProfileEntries, reviewProfileEntry, renderProfileBrief, createProfileIo,
} from './work-profile.js';
import { mineSessionsIntoProfile } from './session-miner.js';
import { collectProjectState, renderProjectBrief, renderStateDocument } from './project-state.js';

export const name = 'dsh-weknora-archive';
/** Cordis waits for the tool registry before applying this plugin. */
export const inject = ['tools'];

export { resolveConfig, redactConfig } from './config.js';
export { WeknoraClient } from './client.js';
export { archiveProject } from './archive.js';
export {
  captureProfileEntry, listProfileEntries, reviewProfileEntry, renderProfileBrief, createProfileIo,
} from './work-profile.js';
export { mineProfileCandidates, mineSessionsIntoProfile } from './session-miner.js';
export { collectProjectState, renderProjectBrief, renderStateDocument, decodeProjectDirPath } from './project-state.js';

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

/**
 * Resolve the directory that backs the local work-profile store.
 * Config `dataDir` wins; otherwise `~/.dsh/plugin-data/dsh-weknora-archive`.
 */
function resolveDataDir(config) {
  const dir = config.dataDir || join(homedir(), '.dsh', 'plugin-data', 'dsh-weknora-archive');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Filesystem-backed profile IO: atomic store writes + append-only journal.
 */
function createFsProfileIo(dataDir) {
  const storePath = join(dataDir, 'work-profile.json');
  const journalPath = join(dataDir, 'work-profile.journal.jsonl');
  return createProfileIo({
    readStore: () => {
      try {
        return JSON.parse(readFileSync(storePath, 'utf8'));
      } catch {
        return null; // first run: no store file yet
      }
    },
    writeStore: (store) => {
      const tmp = `${storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
      renameSync(tmp, storePath);
    },
    appendJournal: (record) => {
      appendFileSync(journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    },
  });
}

/**
 * Register the agent-facing tools. Each registration is an effect, so
 * unloading or reconfiguring the plugin withdraws them without a restart.
 * @param ctx - the Cordis context with `ctx.tools` injected.
 * @param config - the plugin's `config` row; validated at load time.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const client = new WeknoraClient(resolved);
  const log = (message) => {
    // Config values are never interpolated into logs; only redacted form.
    ctx.logger?.info?.(`${message} (config: ${JSON.stringify(redactConfig(resolved))})`) ?? console.log(message);
  };
  const fail = (error) => {
    // Defensive: strip any credential material before the error reaches the model.
    const message = String(error?.message ?? error).split('X-API-Key')[0];
    throw new Error(`dsh-weknora-archive: ${message}`);
  };
  const definitions = [];

  // 1. Archive a project's sessions (extract → summarize → upload, incremental).
  definitions.push({
    name: `${resolved.toolPrefix}_session`,
    description: '把当前机器上某个 DSH 项目的会话增量归档进 WeKnora 知识库：解压会话存储 → 启发式总结 → 按标题去重后上传（知识库不存在时自动按项目名新建）。Archive a DSH project\'s sessions into a WeKnora knowledge base incrementally: decompress session storage, summarize, dedupe by document title, upload (auto-creates the knowledge base when absent). Use when the user says 归档/archive sessions/更新知识库.',
    parameters: {
      type: 'object',
      properties: {
        project_keyword: { type: 'string', description: '项目目录名关键词，如 "my-app"；模糊匹配 sessions 目录。Project directory keyword to match.' },
        knowledge_base_id: { type: 'string', description: '可选：目标知识库 id；缺省按配置或按项目名自动匹配/新建。' },
        dry_run: { type: 'boolean', description: '可选：只统计将要归档的会话，不上传。Preview without uploading.' },
      },
      required: ['project_keyword'],
      additionalProperties: false,
    },
    timeoutMs: resolved.uploadTimeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          knowledge_base_id: { type: 'string' },
          created: { type: 'boolean' },
          uploaded_count: { type: 'integer' },
          skipped_count: { type: 'integer' },
          detail: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail ?? JSON.stringify(value) }],
    },
    async execute(args) {
      try {
        const result = await archiveProject({ client, config: resolved }, {
          projectKeyword: args.project_keyword,
          knowledgeBaseId: args.knowledge_base_id,
          dryRun: args.dry_run === true,
        });
        if (!result.ok) return { ok: false, detail: result.error };
        return {
          ok: true,
          knowledge_base_id: result.knowledgeBaseId,
          created: result.created,
          uploaded_count: result.uploaded.length,
          skipped_count: result.skippedCount,
          detail: [
            `项目 ${result.project} (${result.projectDir})`,
            `知识库 ${result.knowledgeBaseId}${result.created ? '（新建）' : ''}`,
            `${result.dryRun ? '预览：将上传' : '已上传'} ${result.uploaded.length} 篇，跳过已归档 ${result.skippedCount} 篇（共 ${result.totalSessions} 个会话）`,
            result.overview ? `总览文档：${result.overview}` : null,
            ...result.uploaded.map((entry) => `- ${entry.title} (${entry.chars} chars)`),
          ].filter(Boolean).join('\n'),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 2. Archive status: projects, sessions, and per-project archive state.
  definitions.push({
    name: `${resolved.toolPrefix}_status`,
    description: '查看归档状态：列出本机 DSH 会话项目目录与各自会话数，以及目标知识库内的归档文档标题。Show archive status: local DSH session project directories with session counts, and the document titles already in the target knowledge base. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        project_keyword: { type: 'string', description: '可选：只看匹配的项目。Optional filter.' },
        knowledge_base_id: { type: 'string', description: '可选：查看该库内的文档。Optional KB to inspect.' },
      },
      additionalProperties: false,
    },
    timeoutMs: resolved.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const dirs = listProjectDirs(resolved.sessionsDir)
          .filter((dir) => !args.project_keyword || dir.toLowerCase().includes(String(args.project_keyword).toLowerCase()));
        const lines = dirs.map((dir) => {
          let count = '?';
          try {
            count = String(listSessions(resolved.sessionsDir, dir).length);
          } catch { /* unreadable dir */ }
          return `- ${dir} (${count} sessions)`;
        });
        if (args.knowledge_base_id) {
          const docs = await client.listKnowledge(args.knowledge_base_id);
          lines.push(`知识库 ${args.knowledge_base_id} 文档 ${docs.length} 篇:`);
          for (const doc of docs.slice(0, 50)) {
            lines.push(`- ${doc?.title ?? doc?.knowledge_title ?? '(untitled)'} [${doc?.parse_status ?? '?'}]`);
          }
        }
        return { ok: true, detail: lines.length > 0 ? lines.join('\n') : '未找到匹配的会话项目目录。' };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 3. List knowledge bases (base create/list capability, write-side).
  definitions.push({
    name: `${resolved.toolPrefix}_list_knowledge_bases`,
    description: '列出该 WeKnora 凭据可见的知识库（id 与名称），用于选择归档目标。List the WeKnora knowledge bases this credential can see, with ids. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: resolved.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute() {
      try {
        const bases = await client.listKnowledgeBases();
        const detail = bases.length === 0
          ? '该凭据没有可见的知识库。'
          : `${bases.length} 个知识库:\n${bases.map((kb) => `- ${kb?.name ?? '?'} (id: ${kb?.id ?? '?'})`).join('\n')}`;
        return { ok: true, detail };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 4. Create a knowledge base.
  definitions.push({
    name: `${resolved.toolPrefix}_create_knowledge_base`,
    description: '新建一个 WeKnora 知识库（名称 + 一句话描述）。注意：新建后可能需要在 WeKnora 端配置 embedding 模型，否则文档解析会失败。Create a WeKnora knowledge base (name + short description). Note: a freshly created KB may need an embedding model configured on the WeKnora side before documents parse.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '知识库名称。KB name.' },
        description: { type: 'string', description: '一句话描述。Short description.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    timeoutMs: resolved.requestTimeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const result = await client.createKnowledgeBase(args.name, args.description ?? '');
        const id = result?.id ?? result?.data?.id ?? '';
        return { ok: true, detail: `已创建知识库 ${args.name} (id: ${id})。如文档解析失败，请先在 WeKnora 端为该库配置 embedding 模型。` };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // ---- Passive work-profile (habit/style capture, local store) ----------
  const profileIo = createFsProfileIo(resolveDataDir(resolved));
  const mutateStore = (mutator, journalAction) => {
    const store = profileIo.load();
    const result = mutator(store);
    profileIo.save(store);
    profileIo.journal(journalAction, { detail: result });
    return result;
  };

  // 5. Capture one habit/style fact (the in-band "无感知" write path).
  definitions.push({
    name: `${resolved.toolPrefix}_profile_capture`,
    description: '把用户随口透露的工作习惯/偏好/风格/环境事实/项目约定无感知记入本地画像（不写知识库、不打断对话）。显式指令（含"以后/一律/别再/我喜欢"等）自动生效，其余进待审核。Capture a work habit / preference / style fact into the local work profile passively. Explicit directives auto-activate; everything else goes to the review inbox. Use whenever the user reveals a preference or corrects you — no confirmation needed.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '一句话事实本身，如"中间件一律原生安装拒绝 docker"。The fact, one sentence.' },
        kind: { type: 'string', enum: ['preference', 'habit', 'style', 'env-fact', 'project-convention'], description: '条目类型，默认 preference。Entry kind.' },
        evidence: { type: 'string', description: '可选：来源会话 id 或一句话上下文。Optional provenance.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' }, action: { type: 'string' },
          status: { type: 'string' }, id: { type: 'string' }, detail: { type: 'string' },
        },
        required: ['ok', 'action', 'status', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const result = mutateStore(
          (store) => captureProfileEntry(store, {
            kind: args.kind,
            content: args.content,
            evidence: args.evidence ?? '',
            source: 'agent',
          }),
          'capture',
        );
        const statusLine = result.entry.status === 'active' ? '已生效' : '已入待审核（用户确认后生效）';
        return {
          ok: true, action: result.action, status: result.entry.status, id: result.entry.id,
          detail: `画像${statusLine} [${result.entry.kind}] ${result.entry.content}`,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 6. Mine recent sessions for habit/style candidates (LLM-free heuristics).
  definitions.push({
    name: `${resolved.toolPrefix}_profile_scan`,
    description: '扫描某项目最近的 DSH 会话，用启发式规则（无 LLM）挖出习惯/偏好/纠正句式，作为画像候选入库。Scan a project\'s recent sessions and mine habit/style/preference candidates into the local profile with regex heuristics (no LLM). Explicit directives auto-activate.',
    parameters: {
      type: 'object',
      properties: {
        project_keyword: { type: 'string', description: '项目目录名关键词。Project directory keyword.' },
        max_sessions: { type: 'integer', description: '最近 N 个会话，默认 3。Recent sessions to scan (default 3).' },
      },
      required: ['project_keyword'],
      additionalProperties: false,
    },
    timeoutMs: resolved.requestTimeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const dirs = matchProjectDirs(resolved.sessionsDir, String(args.project_keyword));
        if (dirs.length === 0) return { ok: true, detail: `没有匹配 "${args.project_keyword}" 的会话项目目录。` };
        if (dirs.length > 1) return { ok: true, detail: `关键词有歧义，匹配到: ${dirs.join(', ')}` };
        const sessions = listSessions(resolved.sessionsDir, dirs[0]).slice(-Math.min(args.max_sessions ?? 3, 10));
        const parsed = [];
        for (const session of sessions) {
          try { parsed.push(readSessionText(session.filePath)); } catch { /* live session */ }
        }
        const summary = mutateStore(
          (store) => mineSessionsIntoProfile(store, parsed),
          'scan',
        );
        return {
          ok: true,
          detail: `扫描 ${parsed.length} 个会话：新增候选 ${summary.captured} 条（其中显式指令自动生效 ${summary.activated} 条，待审核 ${summary.candidates} 条）。`,
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 7. Render the current profile briefing (for session-start injection).
  definitions.push({
    name: `${resolved.toolPrefix}_profile_brief`,
    description: '输出当前工作画像简报（已确认的习惯/偏好/风格/环境事实/项目约定），供会话开始时快速对齐"这个用户怎么共事"。Render the active work-profile briefing: confirmed habits, preferences, style and conventions. Read-only.',
    parameters: {
      type: 'object',
      properties: { max_chars: { type: 'integer', description: '简报字符上限，默认 4000。Brief char cap.' } },
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const brief = renderProfileBrief(profileIo.load(), { maxChars: Math.min(args.max_chars ?? 4000, 20_000) });
        return { ok: true, detail: brief };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 8. Review inbox: list candidates, activate / retire / edit.
  definitions.push({
    name: `${resolved.toolPrefix}_profile_review`,
    description: '画像人工闸门：列出待审核候选（action=list），或对指定条目执行 activate/retire/edit。Review gate for the work profile: list candidates, or activate/retire/edit one entry by id.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'activate', 'retire', 'edit'], description: '默认 list。Action.' },
        id: { type: 'string', description: '条目 id（activate/retire/edit 必填）。Entry id.' },
        content: { type: 'string', description: 'edit 时的新文本。New text for edit.' },
        kind: { type: 'string', enum: ['preference', 'habit', 'style', 'env-fact', 'project-convention'], description: 'edit 时的类型。New kind for edit.' },
      },
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const action = args.action ?? 'list';
        if (action === 'list') {
          const candidates = listProfileEntries(profileIo.load(), { status: 'candidate' });
          if (candidates.length === 0) return { ok: true, detail: '待审核为空：所有条目均已生效或已弃用。' };
          return {
            ok: true,
            detail: ['待审核候选（按新→旧）:', ...candidates.map((entry) =>
              `- ${entry.id.slice(0, 8)} [${entry.kind}] ${entry.content}（来源 ${entry.source}，${String(entry.updated_at).slice(0, 10)}）`),
            ].join('\n'),
          };
        }
        if (!args.id) return { ok: true, detail: `action=${action} 需要 id。` };
        const entry = mutateStore(
          (store) => reviewProfileEntry(store, { id: args.id, action, content: args.content, kind: args.kind }),
          `review:${action}`,
        );
        if (!entry) return { ok: true, detail: `找不到条目 ${args.id}。` };
        return { ok: true, detail: `条目 ${args.id.slice(0, 8)} 已 ${action}：[${entry.kind}] ${entry.content}` };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // ---- Project ground truth (随时快速掌握项目真实情况) -------------------
  const singleProjectDir = (keyword) => {
    const dirs = matchProjectDirs(resolved.sessionsDir, String(keyword));
    if (dirs.length === 0) return { error: `没有匹配 "${keyword}" 的会话项目目录。` };
    if (dirs.length > 1) return { error: `关键词有歧义，匹配到: ${dirs.join(', ')}` };
    return { dir: dirs[0] };
  };

  // 9. Aggregate local sessions + git + WeKnora into one brief.
  definitions.push({
    name: `${resolved.toolPrefix}_project_brief`,
    description: '聚合项目真实情况：本地最近会话主题 + git 分支/最近提交/未提交改动 + WeKnora 知识库沉淀与 wiki 状态，输出一份可直接阅读的简报。任何时间接手/恢复项目时先调它。Aggregate a project\'s ground truth — recent session topics, git branch/commits/dirty state, WeKnora knowledge and wiki status — into one readable brief. Call this when (re-)orienting on a project at any time.',
    parameters: {
      type: 'object',
      properties: {
        project_keyword: { type: 'string', description: '项目目录名关键词。Project directory keyword.' },
      },
      required: ['project_keyword'],
      additionalProperties: false,
    },
    timeoutMs: resolved.requestTimeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const match = singleProjectDir(args.project_keyword);
        if (match.error) return { ok: true, detail: match.error };
        const state = await collectProjectState({ config: resolved, client }, { projectDir: match.dir });
        return { ok: true, detail: renderProjectBrief(state) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // 10. Push the state snapshot into WeKnora (idempotent update, wiki-ified server-side).
  definitions.push({
    name: `${resolved.toolPrefix}_project_state_sync`,
    description: '把项目状态快照写入/更新到同名 WeKnora 知识库的「项目状态」文档（幂等覆盖；WeKnora 端会自动重新摘要并生成 wiki 页），让 RAG/wiki 永远携带最新真实状态。Push the project state snapshot into the matching WeKnora knowledge base as an idempotently updated "项目状态" document; WeKnora re-summarizes and wiki-fies it server-side.',
    parameters: {
      type: 'object',
      properties: {
        project_keyword: { type: 'string', description: '项目目录名关键词。Project directory keyword.' },
      },
      required: ['project_keyword'],
      additionalProperties: false,
    },
    timeoutMs: resolved.uploadTimeoutMs,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args) {
      try {
        const match = singleProjectDir(args.project_keyword);
        if (match.error) return { ok: true, detail: match.error };
        const state = await collectProjectState({ config: resolved, client }, { projectDir: match.dir });
        const projectName = match.dir.replace(/^-+|-+$/g, '').split('-').filter(Boolean).at(-1) ?? match.dir;
        const title = `项目状态: ${projectName}`;
        const content = renderStateDocument(state);

        // Resolve the target KB: explicit config → match by name → create.
        let knowledgeBaseId = resolved.knowledgeBaseId;
        let created = false;
        if (!knowledgeBaseId) {
          const bases = await client.listKnowledgeBases();
          const matched = bases.find((base) => base?.name === projectName);
          knowledgeBaseId = matched?.id
            ?? (await client.createKnowledgeBase(projectName, `DSH session archive for ${match.dir} (by dsh-weknora-archive)`))?.id;
          created = !matched;
        }
        if (!knowledgeBaseId) return { ok: false, detail: '无法解析或创建目标知识库。' };

        // Idempotent update: same manual title → PUT body, else POST new.
        const docs = await client.listKnowledge(knowledgeBaseId);
        const existing = docs.find((doc) => (doc?.title ?? doc?.knowledge_title) === title);
        if (existing?.id) {
          await client.updateManualKnowledge(existing.id, content);
          return { ok: true, detail: `已更新「${title}」（覆盖模式，WeKnora 将自动重新摘要/wiki 化）。` };
        }
        const result = await client.createManualKnowledge({ knowledgeBaseId, title, content });
        const id = result?.data?.id ?? result?.knowledge_id ?? '';
        return { ok: true, detail: `已创建「${title}」（知识库 ${knowledgeBaseId}${created ? '，新建' : ''}，文档 ${id}）。` };
      } catch (error) {
        return fail(error);
      }
    },
  });

  for (const definition of definitions) ctx.tools.register(definition);
  log(`dsh-weknora-archive: registered ${definitions.map((d) => d.name).join(', ')}`);
}
