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
import { summarizeSession, summarizeProjectOverview } from '../lib/summarizer.js';
import { findNewSessions, sessionDocTitle, archiveProject } from '../lib/archive.js';
import { resolveConfig, redactConfig, normalizeBaseUrl } from '../lib/config.js';
import {
  captureProfileEntry, listProfileEntries, reviewProfileEntry, renderProfileBrief, createProfileIo,
} from '../lib/work-profile.js';
import { mineSessionsIntoProfile, mineProfileCandidates } from '../lib/session-miner.js';
import {
  decodeProjectDirPath, renderProjectBrief, renderStateDocument, collectProjectState,
} from '../lib/project-state.js';

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
  async uploadKnowledge({ knowledgeBaseId, title }) {
    this.docs.get(knowledgeBaseId)?.push({ title, parse_status: 'completed' });
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

// ---- work profile (lifecycle, gate, correction) ----------------------------
console.log('work profile:');
function newStore() {
  return { version: 1, entries: [] };
}
await check('explicit directive auto-activates', () => {
  const store = newStore();
  const { entry, action } = captureProfileEntry(store, { kind: 'preference', content: '以后部署一律原生安装拒绝 docker', source: 'agent' });
  assert.equal(action, 'activated');
  assert.equal(entry.status, 'active');
});
await check('implicit fact lands in the inbox as candidate', () => {
  const store = newStore();
  const { entry, action } = captureProfileEntry(store, { kind: 'habit', content: '他用 Vue 写管理端' });
  assert.equal(action, 'created');
  assert.equal(entry.status, 'candidate');
});
await check('exact duplicate leaves the store untouched', () => {
  const store = newStore();
  captureProfileEntry(store, { kind: 'preference', content: '以后部署一律原生安装拒绝 docker' });
  const size = store.entries.length;
  const { action } = captureProfileEntry(store, { kind: 'preference', content: '以后部署一律原生安装拒绝 docker' });
  assert.equal(action, 'duplicate');
  assert.equal(store.entries.length, size);
});
await check('correction supersedes the contradictory active entry', () => {
  const store = newStore();
  captureProfileEntry(store, { kind: 'preference', content: '以后部署一律原生安装拒绝 docker' });
  const { action } = captureProfileEntry(store, { kind: 'preference', content: '以后部署一律原生安装并用 systemd 托管，而不是 docker' });
  assert.equal(action, 'superseded');
  const active = listProfileEntries(store, { status: 'active' });
  assert.equal(active.length, 1);
  assert.ok(active[0].content.includes('systemd'));
  const retired = listProfileEntries(store, { status: 'retired' });
  assert.equal(retired.length, 1);
});
await check('review gate activates and retires', () => {
  const store = newStore();
  const { entry } = captureProfileEntry(store, { kind: 'style', content: '回复保持极短' });
  assert.equal(entry.status, 'candidate');
  reviewProfileEntry(store, { id: entry.id, action: 'activate' });
  assert.equal(listProfileEntries(store, { status: 'active' }).length, 1);
  reviewProfileEntry(store, { id: entry.id, action: 'retire' });
  assert.equal(listProfileEntries(store, { status: 'active' }).length, 0);
});
await check('brief groups kinds and flags near-conflicts', () => {
  const store = newStore();
  captureProfileEntry(store, { kind: 'env-fact', content: 'MySQL 端口一律 3337 只绑 127.0.0.1' });
  // Near-identical restatements (≥0.8 overlap) would supersede; use a
  // 0.5–0.8 overlap pair to build two genuinely co-existing actives.
  captureProfileEntry(store, { kind: 'env-fact', content: 'Redis 端口一律 6779 只绑 127.0.0.1' });
  const brief = renderProfileBrief(store);
  assert.ok(brief.includes('## 环境事实（2）'), brief);
  assert.ok(brief.includes('⚠'), brief);
});
await check('profile io adapter is atomic + journaled', () => {
  const writes = [];
  const journal = [];
  const io = createProfileIo({
    readStore: () => writes.at(-1) ?? null,
    writeStore: (store) => writes.push(JSON.parse(JSON.stringify(store))),
    appendJournal: (record) => journal.push(record),
  });
  const store = io.load();
  captureProfileEntry(store, { kind: 'preference', content: '以后测试一律先备份' });
  io.save(store);
  io.journal('capture', { id: 'x' });
  assert.equal(io.load().entries.length, 1);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].action, 'capture');
});

// ---- session miner ---------------------------------------------------------
console.log('session miner:');
await check('mines explicit directives and corrections only from user turns', () => {
  const session = {
    sessionId: 'session-abc',
    messages: [
      { role: 'user', text: '以后所有新接口一律 REST 风格，别再混 RPC 命名' },
      { role: 'assistant', text: '以后我会注意的（助手的话不算数）' },
      { role: 'user', text: '不是这样的，其实是网关层拦的' },
    ],
  };
  const candidates = mineProfileCandidates(session);
  assert.ok(candidates.length >= 2);
  assert.ok(candidates.every((c) => c.evidence === 'session-abc'));
  const store = newStore();
  const summary = mineSessionsIntoProfile(store, [session]);
  assert.ok(summary.activated >= 1, 'explicit directive should auto-activate');
  const active = listProfileEntries(store, { status: 'active' });
  assert.ok(active.every((entry) => entry.source === 'session-mined'));
});

// ---- project state ---------------------------------------------------------
console.log('project state:');
await check('decodeProjectDirPath rejects data and missing paths', () => {
  assert.equal(decodeProjectDirPath('--data--'), null);
  assert.equal(decodeProjectDirPath('--no-such-xyz-abc--'), null);
});
await check('decodeProjectDirPath resolves an existing tmp path', () => {
  const rand = Math.random().toString(36).slice(2, 8);
  const dir = join(tmpdir(), `dwa${rand}`);
  mkdirSync(dir, { recursive: true });
  const encoded = `--${dir.slice(1).replaceAll('/', '-')}--`;
  assert.equal(decodeProjectDirPath(encoded), dir);
});
await check('renderProjectBrief includes git skip + knowledge + wiki', async () => {
  const state = {
    projectDir: '--Users-me-demo--',
    projectPath: null,
    collectedAt: '2026-10-22T03:00:00.000Z',
    recent: [{ sessionId: 'session-12345678', updatedAt: '2026-10-22T02:00:00.000Z', bytes: 100, topic: '修复导出 bug' }],
    git: null,
    knowledge: {
      knowledgeBaseId: 'kb-1', docCount: 12,
      latestDocs: [{ title: '会话总结: demo_1234', status: 'completed', updatedAt: '' }],
      wiki: { pages: 46, links: 120, active: true },
    },
  };
  const brief = renderProjectBrief(state);
  assert.ok(brief.includes('项目真实情况: demo'));
  assert.ok(brief.includes('git:'));
  assert.ok(brief.includes('修复导出 bug'));
  assert.ok(brief.includes('wiki 46 页 / 120 互链'));
  const doc = renderStateDocument(state);
  assert.ok(doc.includes('整体覆盖更新'));
});
await check('collectProjectState aggregates sessions + mock client', async () => {
  const client = {
    async listKnowledgeBases() { return [{ id: 'kb-9', name: 'demo' }]; },
    async listKnowledge() { return [{ id: 'k1', title: '会话总结: demo_11111111', parse_status: 'completed' }]; },
    async wikiStats() { return { total_pages: 3, total_links: 5, is_active: true }; },
  };
  const state = await collectProjectState({ config, client }, { projectDir: PROJECT, maxSessions: 2 });
  assert.equal(state.recent.length, 2);
  assert.equal(state.knowledge.knowledgeBaseId, 'kb-9');
  assert.equal(state.knowledge.wiki.pages, 3);
  assert.ok(state.projectPath === null || typeof state.projectPath === 'string');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`\nall ${passed} tests passed`);
