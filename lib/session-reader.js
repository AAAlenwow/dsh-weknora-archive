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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

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
  const jsonl = zstdDecompressSync(compressed).toString('utf8');
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
    } else if (event?.type === 'assistant/attempt') {
      const text = (event?.data?.stream ?? [])
        .filter((chunk) => chunk?.type === 'text' && typeof chunk.text === 'string')
        .map((chunk) => chunk.text)
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
    const filePath = join(base, entry.name, 'session.v3.jsonl.zstd');
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
