/**
 * Local unit test for dsh-weknora-archive: runs the summarizer and the
 * incremental archive pipeline against mock session data and a mock WeKnora
 * client. No network access, no real credentials. Run: `npm test` or
 * `node test/mock.test.mjs`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { summarizeSession, summarizeProjectOverview, refineSummaryWithLlm } from '../lib/summarizer.js';
import { findNewSessions, sessionDocTitle, archiveProject, archiveAllProjects } from '../lib/archive.js';
import { resolveConfig, redactConfig, normalizeBaseUrl } from '../lib/config.js';

// ---- mock WeKnora client ---------------------------------------------------
class MockClient {
  constructor(bases = [], docs = {}) {
    this.bases = bases.map((b) => ({ ...b }));
    this.docs = new Map(Object.entries(docs).map(([k, v]) => [k, v.map((d) => ({ ...d }))]));
  }
  async listKnowledgeBases() { return this.bases; }
  async createKnowledgeBase(name, description) {
    const id = `kb-${this.bases.length + 1}`;
    this.bases.push({ id, name, description });
    this.docs.set(id, []);
    return { id };
  }
  async listKnowledge(kbId) { return this.docs.get(kbId) ?? []; }
  async uploadKnowledge({ knowledgeBaseId, title, content }) {
    this.docs.get(knowledgeBaseId)?.push({ title, parse_status: 'completed', content: content ?? '' });
    this.uploads = this.uploads ?? [];
    this.uploads.push({ knowledgeBaseId, title, content: content ?? '' });
    return { knowledge_id: `k-${title.length}` };
  }
}

// ---- tiny test runner (sync + async) ---------------------------------------
let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`  FAIL - ${name}: ${error.message}`);
  }
}

// ---- config ----------------------------------------------------------------
console.log('config:');
await check('normalizeBaseUrl appends /api/v1', () => {
  assert.equal(normalizeBaseUrl('http://localhost:8090'), 'http://localhost:8090/api/v1');
  assert.equal(normalizeBaseUrl('http://localhost:8090/api/v1/'), 'http://localhost:8090/api/v1');
});
await check('resolveConfig rejects missing baseUrl/apiKey', () => {
  assert.throws(() => resolveConfig({}), /baseUrl is required/);
});
await check('resolveConfig accepts a full config', () => {
  const cfg = resolveConfig({ baseUrl: 'http://x.example', apiKey: 'sk-secret-abc', sessionsDir: '/tmp/s' });
  assert.equal(cfg.baseUrl, 'http://x.example/api/v1');
});
await check('redactConfig hides the key', () => {
  const cfg = resolveConfig({ baseUrl: 'http://x.example', apiKey: 'sk-secret-abc' });
  assert.ok(!JSON.stringify(redactConfig(cfg)).includes('sk-secret-abc'));
});
await check('partial LLM config is rejected at load time', () => {
  assert.throws(
    () => resolveConfig({ baseUrl: 'http://x.example', apiKey: 'sk-1', llmBaseUrl: 'http://llm.example', llmApiKey: 'sk-llm' }),
    /must be provided together/,
  );
});
await check('full LLM config resolves and redacts the llm key', () => {
  const cfg = resolveConfig({
    baseUrl: 'http://x.example', apiKey: 'sk-1',
    llmBaseUrl: 'http://llm.example/v1', llmApiKey: 'sk-llm-secret', llmModel: 'test-model',
  });
  assert.equal(cfg.llmModel, 'test-model');
  assert.ok(!JSON.stringify(redactConfig(cfg)).includes('sk-llm-secret'));
});

// ---- summarizer ------------------------------------------------------------
console.log('summarizer:');
await check('summarizeSession follows the template', () => {
  const session = {
    sessionId: 'abcdef1234567890',
    messages: [
      { role: 'user', text: '请把 /Users/hechao/project/foo 的接口对接到 pnpm build 流程里，端口 8090' },
      { role: 'assistant', text: '已完成：修改了 index.js 并运行 node --check 通过。' },
    ],
  };
  const { title, markdown } = summarizeSession(session, { projectName: 'foo' });
  assert.equal(title, '会话总结: foo_abcdef12');
  assert.ok(markdown.includes('**主题**'));
  assert.ok(markdown.includes('8090'));
  assert.ok(!markdown.toLowerCase().includes('sk-'));
});
await check('empty-assistant session is marked dispatch-only', () => {
  const { markdown } = summarizeSession(
    { sessionId: 'ffffffff', messages: [{ role: 'user', text: '任务书内容很长很长很长很长' }] },
    { projectName: 'p' },
  );
  assert.ok(markdown.includes('派工型会话'));
});
await check('project overview lists summaries', () => {
  const overview = summarizeProjectOverview({
    projectName: 'p', projectDir: '--x--', sessions: [{}, {}], summaries: [{ title: '会话总结: p_aa' }],
  });
  assert.ok(overview.markdown.includes('会话总结: p_aa'));
});

// ---- archive pipeline (mock) ----------------------------------------------
console.log('archive pipeline (mock):');
const root = mkdtempSync(join(tmpdir(), 'dsh-wa-test-'));
const PROJECT = '--Users-me-demo--';
function writeFakeSession(sessionId, userText, assistantText) {
  const dir = join(root, PROJECT, sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: userText }] } }),
    JSON.stringify({ type: 'assistant/attempt', data: { stream: [{ type: 'text', text: assistantText }] } }),
  ];
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n'))));
}
writeFakeSession('session-11111111', '修复登录 bug，路径 /srv/app/login.ts', 'done, ran git commit');
writeFakeSession('session-22222222', '新增导出功能', 'ok');
function writeFakeSessionIn(projectDir, sessionId, userText, assistantText) {
  const dir = join(root, projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: userText }] } }),
    JSON.stringify({ type: 'assistant/attempt', data: { stream: [{ type: 'text', text: assistantText }] } }),
  ];
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n'))));
}
writeFakeSessionIn('--Users-me-demo2--', 'session-33333333', '另一个项目', 'ok');
const config = resolveConfig({ baseUrl: 'http://weknora.invalid', apiKey: 'sk-test', sessionsDir: root });

await check('first run creates KB, uploads all + overview', async () => {
  const client = new MockClient();
  const first = await archiveProject({ client, config }, { projectKeyword: 'demo--' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.uploaded.length, 2);
  assert.equal(first.overview, '项目总览: demo');
});
await check('second run dedupes: uploads nothing, skips all', async () => {
  const client = new MockClient();
  await archiveProject({ client, config }, { projectKeyword: 'demo--' });
  const second = await archiveProject({ client, config }, { projectKeyword: 'demo--' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.uploaded.length, 0);
  assert.equal(second.skippedCount, 2);
});
await check('findNewSessions skips archived titles', () => {
  const sessions = [{ sessionId: 'aaaaaaaa' }, { sessionId: 'bbbbbbbb' }];
  const fresh = findNewSessions(sessions, [sessionDocTitle('x', 'aaaaaaaa')]);
  assert.deepEqual(fresh, ['bbbbbbbb']);
});
await check('ambiguous keyword errors cleanly', async () => {
  const client = new MockClient();
  const result = await archiveProject({ client, config }, { projectKeyword: '--Users-me' });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('ambiguous'));
});

// ---- auto sweep + explicit projectDir (mock) ------------------------------
console.log('auto sweep (mock):');
await check('archiveAllProjects sweeps every project (dry run counts, no upload)', async () => {
  const client = new MockClient();
  const sweep = await archiveAllProjects({ client, config }, { dryRun: true });
  assert.equal(sweep.projects, 2);
  assert.equal(sweep.uploadedCount, 3); // 2 in demo + 1 in demo2
  assert.equal((client.uploads ?? []).length, 0); // dry run never uploads
});
await check('archiveAllProjects uploads everything, second run is idempotent', async () => {
  const client = new MockClient();
  const first = await archiveAllProjects({ client, config }, {});
  assert.equal(first.ok, true);
  assert.equal(first.uploadedCount, 3);
  assert.equal(first.failures.length, 0);
  const second = await archiveAllProjects({ client, config }, {});
  assert.equal(second.uploadedCount, 0);
  assert.equal(second.skippedCount, 3);
});
await check('archiveAllProjects isolates a failing project', async () => {
  const client = new MockClient();
  client.createKnowledgeBase = async (name) => { throw new Error('kb quota exceeded for ' + name); };
  const sweep = await archiveAllProjects({ client, config }, {});
  assert.equal(sweep.ok, false);
  assert.equal(sweep.failures.length, 2); // both projects need a fresh KB
  assert.equal(sweep.projects, 2);
});
await check('archiveProject accepts an explicit projectDir', async () => {
  const client = new MockClient();
  const result = await archiveProject({ client, config }, { projectDir: PROJECT });
  assert.equal(result.ok, true);
  assert.equal(result.project, 'demo');
  assert.equal(result.uploaded.length, 2);
});

// ---- optional LLM refinement (mock fetch) ---------------------------------
console.log('llm refinement (mock fetch):');
const llmConfig = resolveConfig({
  baseUrl: 'http://weknora.invalid', apiKey: 'sk-test', sessionsDir: root,
  llmBaseUrl: 'http://llm.invalid/v1', llmApiKey: 'sk-llm-test', llmModel: 'test-model',
});
const originalFetch = globalThis.fetch;
try {
  await check('refines via chat/completions and uploads the refined text', async () => {
    let seen;
    globalThis.fetch = async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '精炼后的总结（测试标记）' } }] }) };
    };
    const client = new MockClient();
    const result = await archiveProject({ client, config: llmConfig }, { projectKeyword: 'demo--' });
    assert.equal(result.ok, true);
    assert.ok(seen.url.endsWith('/chat/completions'));
    assert.equal(seen.body.model, 'test-model');
    assert.ok(!JSON.stringify(seen.body).includes('sk-llm-test')); // key never travels in the body
    const uploadedContent = client.uploads.find((u) => u.title.startsWith('会话总结'))?.content ?? '';
    assert.ok(uploadedContent.includes('精炼后的总结（测试标记）'));
    globalThis.fetch = originalFetch;
  });
  await check('falls back to the heuristic summary when the LLM call fails', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const client = new MockClient();
    const result = await archiveProject({ client, config: llmConfig }, { projectKeyword: 'demo2' });
    assert.equal(result.ok, true); // the archive never fails because of refinement
    const uploadedContent = client.uploads.find((u) => u.title.startsWith('会话总结'))?.content ?? '';
    assert.ok(uploadedContent.includes('启发式总结生成'));
    globalThis.fetch = originalFetch;
  });
  await check('refineSummaryWithLlm refuses to run unconfigured', async () => {
    await assert.rejects(() => refineSummaryWithLlm(config, 'x'.repeat(300)), /not configured/);
  });
} finally {
  globalThis.fetch = originalFetch;
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nall ${passed} tests passed`);
