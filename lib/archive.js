/**
 * Archive orchestration: incremental find-new → summarize → create-or-update
 * knowledge base → upload. Pure orchestration over injected client + reader,
 * so tests can substitute mocks.
 * @module dsh-weknora-archive/archive
 */

import { listSessions, readSessionText } from './session-reader.js';
import { summarizeSession, summarizeProjectOverview } from './summarizer.js';

/** Doc title convention must match the session-archive skill: `会话总结: <project>_<sessionId8>`. */
export function sessionDocTitle(projectName, sessionId) {
  return `会话总结: ${projectName}_${sessionId.slice(0, 8)}`;
}

/**
 * Compute which sessions are new relative to existing document titles.
 * @returns string[] of sessionIds not yet archived.
 */
export function findNewSessions(sessions, existingTitles) {
  const known = new Set([...existingTitles].map((title) => String(title).split('_').at(-1)));
  return sessions.map((session) => session.sessionId).filter((id) => !known.has(id.slice(0, 8)));
}

/**
 * Run one archive pass against a project.
 * @param deps - { client, config, log }
 * @param options - { projectKeyword, dryRun, knowledgeBaseId }
 */
export async function archiveProject(deps, options) {
  const { client, config, log } = deps;
  const { matchProjectDirs } = await import('./session-reader.js');
  const dirs = matchProjectDirs(config.sessionsDir, options.projectKeyword);
  if (dirs.length === 0) {
    return { ok: false, error: `no session project dir matches keyword "${options.projectKeyword}" under ${config.sessionsDir}` };
  }
  if (dirs.length > 1) {
    return { ok: false, error: `keyword "${options.projectKeyword}" is ambiguous, matches: ${dirs.join(', ')}` };
  }
  const projectDir = dirs[0];
  const projectName = projectDir.replace(/^-+|-+$/g, '').split('-').filter(Boolean).at(-1) ?? projectDir;
  const sessions = listSessions(config.sessionsDir, projectDir);

  // Resolve target knowledge base (explicit id → config default → match by name → create).
  let knowledgeBaseId = options.knowledgeBaseId || config.knowledgeBaseId;
  let created = false;
  if (!knowledgeBaseId) {
    const bases = await client.listKnowledgeBases();
    const matched = bases.find((kb) => kb?.name === projectName);
    if (matched) {
      knowledgeBaseId = matched.id;
    } else {
      const result = await client.createKnowledgeBase(projectName, `DSH session archive for ${projectDir} (by dsh-weknora-archive)`);
      knowledgeBaseId = result?.id ?? result?.data?.id ?? '';
      created = true;
    }
  }
  if (!knowledgeBaseId) return { ok: false, error: 'could not resolve or create a target knowledge base' };

  const existing = await client.listKnowledge(knowledgeBaseId);
  const existingTitles = new Set(existing.map((doc) => doc?.title ?? doc?.knowledge_title ?? ''));

  const uploaded = [];
  const skipped = [];
  const isFirstRun = existingTitles.size === 0;
  for (const session of sessions) {
    const title = sessionDocTitle(projectName, session.sessionId);
    if (existingTitles.has(title)) {
      skipped.push(session.sessionId);
      continue;
    }
    const text = readSessionText(session.filePath);
    if (text.messages.length === 0) {
      skipped.push(session.sessionId);
      continue;
    }
    const summary = summarizeSession(text, { projectName, maxChars: config.maxSummaryChars });
    if (options.dryRun) {
      uploaded.push({ sessionId: session.sessionId, title, dryRun: true, chars: summary.markdown.length });
      continue;
    }
    const filename = `${projectName}_${session.sessionId.slice(0, 8)}.md`;
    await client.uploadKnowledge({ knowledgeBaseId, title, content: summary.markdown, filename });
    uploaded.push({ sessionId: session.sessionId, title, filename, chars: summary.markdown.length });
  }

  // First run also contributes a project overview.
  let overview = null;
  if (isFirstRun && !options.dryRun && uploaded.length > 0) {
    overview = summarizeProjectOverview({ projectName, projectDir, sessions, summaries: uploaded });
    await client.uploadKnowledge({
      knowledgeBaseId,
      title: overview.title,
      content: overview.markdown,
      filename: '00_项目总览.md',
    });
  }

  log?.info(`dsh-weknora-archive: ${projectName} → kb ${knowledgeBaseId}: ${uploaded.length} uploaded, ${skipped.length} skipped`);
  return {
    ok: true,
    knowledgeBaseId,
    created,
    project: projectName,
    projectDir,
    totalSessions: sessions.length,
    uploaded,
    skippedCount: skipped.length,
    overview: overview ? overview.title : null,
    dryRun: Boolean(options.dryRun),
  };
}
