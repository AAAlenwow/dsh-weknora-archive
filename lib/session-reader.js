/**
 * Read DSH session storage (read-only, in-process) and extract plain
 * conversation text from `session.v3.jsonl.zstd` files.
 *
 * Layout: `<sessionsRoot>/<encodedProjectDir>/<sessionId>/session.v3.jsonl.zstd`
 * where encodedProjectDir is the absolute project path with `/` replaced by
 * `--`. Extraction rules follow the session-archive skill: `user/message`
 * events carry `data.content[].text`; `assistant/attempt` events carry
 * `data.stream[].chunk.text`.
 * @module dsh-weknora-archive/session-reader
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** zstd frame magic number (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decompress a file made of MANY concatenated zstd frames.
 *
 * dsh >= 0.2 writes one frame per flush instead of a single stream, so
 * `zstdDecompressSync` only returns the first frame (session metadata) and
 * silently drops every conversation event after it. Walk the buffer and
 * decompress at each magic offset instead.
 *
 * @param {Buffer} buf raw file bytes
 * @returns {string} concatenated decompressed text
 */
function decompressConcatenatedFrames(buf) {
  const parts = [];
  let pos = 0;
  // Frames are dense; a failed offset just means a magic byte inside payload
  // data, so keep scanning rather than giving up on the first error.
  while (pos < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, pos);
    if (idx === -1) break;
    try {
      parts.push(zstdDecompressSync(buf.subarray(idx)));
    } catch {
      // Not a real frame boundary — skip this byte and rescan.
    }
    pos = idx + 1;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Session file names, newest format first. */
const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'];

/** Assistant event names carrying the reply stream. */
const ASSISTANT_EVENTS = new Set(['assistant/message', 'assistant/attempt']);

/**
 * List project directories under the sessions root.
 * @returns string[] of encoded project directory names.
 */
export function listProjectDirs(sessionsRoot) {
  return readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('--'))
    .map((entry) => entry.name)
    .sort();
}

/** Fuzzy-match project dirs by keyword (case-insensitive substring). */
export function matchProjectDirs(sessionsRoot, keyword) {
  const dirs = listProjectDirs(sessionsRoot);
  if (!keyword) return dirs;
  const needle = keyword.toLowerCase();
  return dirs.filter((dir) => dir.toLowerCase().includes(needle));
}

/**
 * Read one session file and extract ordered plain conversation text.
 * @returns {{ sessionId: string, messages: Array<{role: 'user'|'assistant', text: string}>, bytes: number }}
 */
export function readSessionText(sessionFilePath) {
  const compressed = readFileSync(sessionFilePath);
  const jsonl = decompressConcatenatedFrames(compressed);
  const sessionId = sessionFilePath.split('/').at(-2) ?? '';
  const messages = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // tolerate trailing partial lines on live sessions
    }
    if (event?.type === 'user/message') {
      const text = (event?.data?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      if (text.trim() !== '') messages.push({ role: 'user', text });
    } else if (ASSISTANT_EVENTS.has(event?.type)) {
      // v4 keeps the final reply in data.message.content (same shape as
      // user/message) and uses data.stream only for incremental deltas;
      // v3 carried the text directly in the stream entries.
      const blocks = event?.data?.message?.content
        ?? (event?.data?.stream ?? []).map((entry) => entry?.chunk ?? entry);
      const text = (blocks ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (text.trim() !== '') {
        const last = messages.at(-1);
        if (last?.role === 'assistant') last.text += `\n${text}`;
        else messages.push({ role: 'assistant', text });
      }
    }
  }
  return { sessionId, messages, bytes: compressed.length };
}

/**
 * List sessions of one project with mtime and size metadata.
 * @returns Array<{ sessionId: string, dir: string, filePath: string, mtimeMs: number, size: number }>
 */
export function listSessions(sessionsRoot, projectDir) {
  const base = join(sessionsRoot, projectDir);
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = SESSION_FILES
      .map((name) => join(base, entry.name, name))
      .find((candidate) => existsSync(candidate));
    if (!filePath) continue;
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      continue;
    }
    out.push({ sessionId: entry.name, dir: entry.name, filePath, mtimeMs: stats.mtimeMs, size: stats.size });
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
