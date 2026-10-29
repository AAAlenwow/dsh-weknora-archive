/**
 * Local work-profile store: passively captured facts about HOW the user
 * works — preferences, habits, style, environment facts, project conventions.
 *
 * Design contract (mirrors the dsh-longterm-memory engineering standard for
 * plugins that write user data):
 *  - lifecycle: candidate → active | retired; a correction supersedes the old
 *    entry instead of leaving two contradictory active rows;
 *  - human gate: only EXPLICIT directives ("以后一律 X") become active on
 *    capture; everything else lands in the inbox as a candidate;
 *  - atomic writes: every mutation goes through tmp-file + rename;
 *  - journal: an append-only JSONL audit trail lives next to the store.
 *
 * Pure functions over injected `deps.load()/deps.save()/deps.journal()`, so
 * tests run against memory. @module dsh-weknora-archive/work-profile
 */

import { randomUUID } from 'node:crypto';

/** Entry statuses. */
export const STATUS = { CANDIDATE: 'candidate', ACTIVE: 'active', RETIRED: 'retired' };

/** Entry kinds (closed set keeps the brief rendering stable). */
export const KINDS = ['preference', 'habit', 'style', 'env-fact', 'project-convention'];

/** Explicit-directive markers that justify auto-activation (human intent on record). */
const EXPLICIT_PATTERN = /(以后|今后|往后|一律|永远|下次(?:也|都|请)|都?请?记住|别再|不要再|不要在|必须|习惯[于是]|我喜欢|我偏好|我不喜欢|我讨厌)/;

/** Correction markers: the new fact REPLACES same-kind active rules. */
const CORRECTION_PATTERN = /(而不是|不是这样的|其实(?:是|不是)|应该是|改成|改为|更正|纠正|错了|作废)/;

/** Normalized keys for near-duplicate detection (CJK-friendly: strip punctuation/space). */
function normalizeKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s，。、；：,.:;!?！？'"「」『』()（）【】\[\]_-]+/g, '')
    .slice(0, 120);
}

function emptyStore() {
  return { version: 1, entries: [] };
}

/**
 * Capture one fact. Returns `{ entry, action }` where action is one of
 * `created` | `activated` | `duplicate` | `superseded`.
 *
 * Dedupe/correction rules:
 *  - same normalized text already stored (any status) → `duplicate`, store untouched;
 *  - same kind + near-identical normalized text (≥ 0.8 overlap) on an ACTIVE
 *    entry → the new text REPLACES it (correction wins), old row is marked
 *    superseded_by — never two contradictory active rows;
 *  - otherwise a new row is created, active only when `explicit` (or forced).
 */
export function captureProfileEntry(store, { kind, content, evidence, source = 'agent', explicit, force }) {
  const text = String(content ?? '').trim();
  if (text === '') throw new Error('content is required');
  const entryKind = KINDS.includes(kind) ? kind : 'preference';
  const key = normalizeKey(text);
  const now = new Date().toISOString();

  const sameText = store.entries.find((e) => normalizeKey(e.content) === key && e.status !== STATUS.RETIRED);
  if (sameText) return { entry: sameText, action: 'duplicate' };

  const isExplicit = explicit ?? EXPLICIT_PATTERN.test(text);
  const isCorrection = CORRECTION_PATTERN.test(text);
  const near = store.entries.find((e) =>
    e.status === STATUS.ACTIVE && e.kind === entryKind && overlap(normalizeKey(e.content), key) >= 0.8);

  // Correction path: an explicit correction (or a near-identical restatement)
  // retires ALL same-kind active rules before the new fact is recorded, so
  // two contradictory rules are never active at once.
  const supersedes = near ? [near] : isCorrection
    ? store.entries.filter((e) => e.status === STATUS.ACTIVE && e.kind === entryKind)
    : [];
  if (supersedes.length > 0) {
    for (const old of supersedes) {
      old.status = STATUS.RETIRED;
      old.superseded_by = null; // filled below
    }
    const entry = {
      id: randomUUID(), kind: entryKind, content: text, evidence: evidence ?? '',
      status: STATUS.ACTIVE, source, created_at: now, updated_at: now,
      supersedes: supersedes.map((old) => old.id),
    };
    for (const old of supersedes) old.superseded_by = entry.id;
    store.entries.push(entry);
    return { entry, action: 'superseded' };
  }

  const entry = {
    id: randomUUID(), kind: entryKind, content: text, evidence: evidence ?? '',
    status: force || isExplicit ? STATUS.ACTIVE : STATUS.CANDIDATE,
    source, created_at: now, updated_at: now,
  };
  store.entries.push(entry);
  return { entry, action: force || isExplicit ? 'activated' : 'created' };
}

/** Character-bigram overlap of two normalized strings, 0..1. */
function overlap(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Set();
  for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) if (grams.has(b.slice(i, i + 2))) hit++;
  return hit / Math.max(grams.size, 1);
}

/** List entries, newest first, optionally filtered by status. */
export function listProfileEntries(store, { status } = {}) {
  return store.entries
    .filter((e) => !status || e.status === status)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

/** Move one entry through the gate: activate | retire | edit. */
export function reviewProfileEntry(store, { id, action, content, kind }) {
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return null;
  if (action === 'activate') entry.status = STATUS.ACTIVE;
  else if (action === 'retire') entry.status = STATUS.RETIRED;
  else if (action === 'edit') {
    if (content !== undefined) entry.content = String(content).trim();
    if (kind !== undefined && KINDS.includes(kind)) entry.kind = kind;
  } else throw new Error(`unknown review action: ${action}`);
  entry.updated_at = new Date().toISOString();
  return entry;
}

/**
 * Render the active profile as a compact Markdown briefing for session
 * injection / agent self-check. Conflicting active rows of the same kind are
 * surfaced with a ⚠ marker instead of being silently resolved.
 */
export function renderProfileBrief(store, { maxChars = 4000 } = {}) {
  const active = listProfileEntries(store, { status: STATUS.ACTIVE });
  if (active.length === 0) return '(工作画像为空：尚无已确认的习惯与风格条目)';
  const byKind = new Map(KINDS.map((k) => [k, []]));
  for (const entry of active) byKind.get(entry.kind)?.push(entry);
  const labels = {
    preference: '偏好', habit: '习惯', style: '风格',
    'env-fact': '环境事实', 'project-convention': '项目约定',
  };
  const lines = ['# 工作习惯与风格画像', ''];
  for (const kind of KINDS) {
    const rows = byKind.get(kind);
    if (rows.length === 0) continue;
    lines.push(`## ${labels[kind]}（${rows.length}）`);
    for (const entry of rows) {
      const conflict = rows.some((other) => other.id !== entry.id
        && overlap(normalizeKey(other.content), normalizeKey(entry.content)) >= 0.5);
      lines.push(`- ${conflict ? '⚠ 疑似冲突，待复核：' : ''}${entry.content}（${entry.source}，${String(entry.updated_at).slice(0, 10)}）`);
    }
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…(截断)`;
  return out;
}

/**
 * IO adapter factory over the filesystem: store JSON + append-only journal.
 * Every save is atomic (tmp + rename); every mutation is journaled.
 */
export function createProfileIo({ readStore, writeStore, appendJournal }) {
  return {
    load() {
      try { return readStore() ?? emptyStore(); } catch { return emptyStore(); }
    },
    save(store) { writeStore(store); },
    journal(action, detail) { appendJournal({ ts: new Date().toISOString(), action, ...detail }); },
  };
}
