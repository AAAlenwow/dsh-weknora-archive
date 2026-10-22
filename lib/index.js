/**
 * dsh-weknora-archive: DeepSeek Harness host plugin that incrementally
 * archives DSH sessions into a WeKnora knowledge base (the write-side
 * complement to the read-only official dsh-weknora plugin).
 * @module dsh-weknora-archive
 */

import { WeknoraClient } from './client.js';
import { resolveConfig, redactConfig } from './config.js';
import { listProjectDirs, listSessions } from './session-reader.js';
import { archiveProject, archiveAllProjects } from './archive.js';

export const name = 'dsh-weknora-archive';
/** Cordis waits for the tool registry before applying this plugin. */
export const inject = ['tools'];

export { resolveConfig, redactConfig } from './config.js';
export { WeknoraClient } from './client.js';
export { archiveProject, archiveAllProjects } from './archive.js';

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

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
        const result = await archiveProject({ client, config: resolved, log }, {
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

  // 5. Auto-archive sweep across all (or keyword-filtered) projects — the
  //    entry point a nightly scheduled task calls, so archiving no longer
  //    depends on the user remembering to ask.
  definitions.push({
    name: `${resolved.toolPrefix}_auto`,
    description: '全量自动归档：扫描本机所有 DSH 项目的会话并增量归档进各自的知识库（按项目名自动匹配/新建），已归档的自动跳过，可重复执行。设计为被定时任务（如每晚提醒）调用，也支持 project_keyword 过滤只归档部分项目。Auto-archive sweep: incrementally archive sessions of ALL local DSH projects into their per-project knowledge bases (matched/created by project name), skipping what is already archived. Idempotent; designed for a nightly scheduled task. Set dry_run to preview.',
    parameters: {
      type: 'object',
      properties: {
        project_keyword: { type: 'string', description: '可选：只扫描目录名匹配该关键词的项目。Optional keyword to filter project directories.' },
        dry_run: { type: 'boolean', description: '可选：只统计将要归档的内容，不上传。Preview without uploading.' },
      },
      additionalProperties: false,
    },
    // A sweep touches every project; give it the full DSH tool timeout cap.
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          projects: { type: 'integer' },
          uploaded_count: { type: 'integer' },
          skipped_count: { type: 'integer' },
          failures: { type: 'integer' },
          detail: { type: 'string' },
        },
        required: ['ok', 'detail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.detail ?? JSON.stringify(value) }],
    },
    async execute(args) {
      try {
        const sweep = await archiveAllProjects({ client, config: resolved, log }, {
          projectKeyword: args.project_keyword,
          dryRun: args.dry_run === true,
        });
        const lines = [
          `${sweep.dryRun ? '预览' : '自动归档完成'}：扫描 ${sweep.projects} 个项目，${sweep.dryRun ? '将上传' : '上传'} ${sweep.uploadedCount} 篇，跳过已归档 ${sweep.skippedCount} 篇`,
          ...sweep.results.map((r) => `- ${r.project}: ${r.empty ? '无会话' : `${sweep.dryRun ? '将上传' : '上传'} ${r.uploaded}，跳过 ${r.skipped}（kb ${r.knowledgeBaseId}${r.created ? '，新建' : ''}）`}`),
          ...sweep.failures.map((f) => `- ⚠️ ${f.project} 失败: ${f.error}`),
        ];
        return {
          ok: sweep.ok,
          projects: sweep.projects,
          uploaded_count: sweep.uploadedCount,
          skipped_count: sweep.skippedCount,
          failures: sweep.failures.length,
          detail: lines.filter(Boolean).join('\n'),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  for (const definition of definitions) ctx.tools.register(definition);
  log(`dsh-weknora-archive: registered ${definitions.map((d) => d.name).join(', ')}`);
}
