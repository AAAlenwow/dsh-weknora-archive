/**
 * Project ground-truth aggregation: recent sessions + local git state +
 * WeKnora knowledge/wiki state → one brief an agent can read to re-orient on
 * a project at any time ("项目真实情况"). Also renders the `00_项目状态.md`
 * snapshot that gets pushed into WeKnora so RAG/wiki always carry the current
 * state. Git access degrades silently when the project dir or git is absent.
 * @module dsh-weknora-archive/project-state
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { listSessions, readSessionText } from './session-reader.js';
import { meaningfulLines } from './summarizer.js';

const execFileAsync = promisify(execFile);

/**
 * Recover a local filesystem path from a dsh encoded session dir name:
 * `--Users-hechao-project-foo--` → `/Users/hechao/project/foo`.
 * @returns string|null absolute path when it exists on disk.
 */
export function decodeProjectDirPath(encodedDir) {
  const stem = String(encodedDir).replace(/^-+/, '').replace(/-+$/, '');
  if (stem === '' || stem === 'data') return null;
  const candidate = `/${stem.split('-').filter(Boolean).join('/')}`;
  return existsSync(candidate) ? candidate : null;
}

/** Run a git command with a short timeout; null on any failure. */
async function git(cwd, args, timeoutMs = 4000) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Collect the local git slice: branch, last commits, dirty file count. */
export async function collectGitState(projectPath) {
  if (!projectPath) return null;
  const [branch, log, status] = await Promise.all([
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectPath, ['log', '--oneline', '-10', '--date=short', '--pretty=%ad %h %s']),
    git(projectPath, ['status', '--porcelain']),
  ]);
  if (branch === null && log === null) return null;
  const dirty = status === null ? null : status.split('\n').filter((line) => line.trim() !== '').length;
  return {
    projectPath,
    branch: branch ?? '?',
    commits: log === null ? [] : log.split('\n').filter(Boolean),
    dirtyCount: dirty ?? 0,
  };
}

/**
 * Aggregate everything known about a project.
 * @param deps - { config }
 * @param options - { projectDir (encoded), maxSessions }
 */
export async function collectProjectState(deps, { projectDir, maxSessions = 5 } = {}) {
  const { config, client } = deps;
  const sessions = listSessions(config.sessionsDir, projectDir)
    .slice(-maxSessions)
    .reverse();
  const recent = [];
  for (const session of sessions) {
    let topic = '';
    try {
      const text = readSessionText(session.filePath);
      const firstUser = text.messages.find((m) => m.role === 'user');
      topic = firstUser ? (meaningfulLines(firstUser.text)[0] ?? '') : '';
    } catch { /* live session may fail to decompress */ }
    recent.push({
      sessionId: session.sessionId,
      updatedAt: new Date(session.mtimeMs).toISOString(),
      bytes: session.size,
      topic: topic.slice(0, 160),
    });
  }
  const projectPath = decodeProjectDirPath(projectDir);
  const gitState = await collectGitState(projectPath);

  let knowledge = null;
  try {
    const bases = await client.listKnowledgeBases();
    const projectName = projectDir.replace(/^-+|-+$/g, '').split('-').filter(Boolean).at(-1) ?? projectDir;
    const kb = bases.find((base) => base?.name === projectName);
    if (kb?.id) {
      const docs = await client.listKnowledge(kb.id);
      const stats = await client.wikiStats(kb.id).catch(() => null);
      knowledge = {
        knowledgeBaseId: kb.id,
        docCount: docs.length,
        latestDocs: docs.slice(0, 10).map((doc) => ({
          title: doc?.title ?? doc?.knowledge_title ?? '(untitled)',
          status: doc?.parse_status ?? '?',
          updatedAt: doc?.updated_at ?? '',
        })),
        wiki: stats ? { pages: stats.total_pages ?? 0, links: stats.total_links ?? 0, active: stats.is_active ?? false } : null,
      };
    }
  } catch { /* WeKnora unreachable → local-only brief */ }

  return { projectDir, projectPath, recent, git: gitState, knowledge, collectedAt: new Date().toISOString() };
}

/**
 * Render the aggregated state as a compact Markdown brief.
 */
export function renderProjectBrief(state) {
  const lines = [`# 项目真实情况: ${state.projectDir.replace(/^-+|-+$/g, '').split('-').filter(Boolean).at(-1) ?? state.projectDir}`, ''];
  lines.push(`- 采集时间: ${state.collectedAt}`);
  if (state.projectPath) lines.push(`- 本地路径: \`${state.projectPath}\``);
  if (state.git) {
    lines.push(`- git 分支: \`${state.git.branch}\`${state.git.dirtyCount > 0 ? `，未提交改动 ${state.git.dirtyCount} 个文件` : '，工作区干净'}`);
    if (state.git.commits.length > 0) {
      lines.push('- 最近提交:');
      for (const commit of state.git.commits.slice(0, 8)) lines.push(`  - ${commit}`);
    }
  } else {
    lines.push('- git: （本地目录不存在或不可用，跳过）');
  }
  if (state.recent.length > 0) {
    lines.push('- 最近会话（新→旧）:');
    for (const session of state.recent) {
      lines.push(`  - ${String(session.updatedAt).slice(0, 16).replace('T', ' ')} ${session.topic || '(无可解析主题)'} [${session.sessionId.slice(0, 8)}]`);
    }
  }
  if (state.knowledge) {
    const k = state.knowledge;
    lines.push(`- WeKnora 知识库 \`${k.knowledgeBaseId}\`: ${k.docCount} 篇文档` +
      (k.wiki ? `，wiki ${k.wiki.pages} 页 / ${k.wiki.links} 互链${k.wiki.active ? '' : '（wiki 未激活）'}` : ''));
    if (k.latestDocs.length > 0) {
      lines.push('- 最新沉淀:');
      for (const doc of k.latestDocs.slice(0, 6)) {
        lines.push(`  - ${doc.title} [${doc.status}]`);
      }
    }
  } else {
    lines.push('- WeKnora: （未找到同名知识库或服务不可达）');
  }
  lines.push('');
  lines.push('> 由 dsh-weknora-archive project_brief 聚合（本地会话 + git + WeKnora）。');
  return lines.join('\n');
}

/**
 * Render the `00_项目状态.md` document body pushed to WeKnora. Suffixing the
 * update timestamp lets readers judge staleness at a glance.
 */
export function renderStateDocument(state) {
  const brief = renderProjectBrief(state);
  return `${brief}
> 本文档由 dsh-weknora-archive 在 project_state_sync 时整体覆盖更新（${state.collectedAt}）。
`;
}
