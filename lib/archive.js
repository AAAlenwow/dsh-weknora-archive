/**
 * Archive orchestration: incremental find-new → summarize → create-or-update
 * knowledge base → upload. Pure orchestration over injected client + reader,
 * so tests can substitute mocks.
 * @module dsh-weknora-archive/archive
 */

import { listSessions, readSessionText, matchProjectDirs } from './session-reader.js';
import { summarizeSession, summarizeProjectOverview, refineSummaryWithLlm } from './summarizer.js';

/** Doc title convention must match the session-archive skill: `会话总结: <project>_<sessionId8>`. */
export function sessionDocTitle(projectName, sessionId) {
  // Session ids look like `session-<uuid>` or a bare `<uuid>`; both carry a
  // long `session-` prefix that a plain slice(0, 8) would swallow whole.
  const tail = String(sessionId).replace(/^session-/, '');
  const short = tail.length > 8 ? tail.slice(0, 8) : tail;
  return `会话总结: ${projectName}_${short}`;
}

/**
 * dsh encodes a project path by collapsing `/`, `\` and `:` into a single `-`
 * (see session-persistence-jsonl/format.ts), wrapping the slug in `--…--`.
 * `--data--` is the project `data`; `--Users-me-demo--` is `Users/me/demo`.
 */
export function projectNameFromDir(projectDir) {
  return projectDir.replace(/^-+|-+$/g, '').split('-').filter(Boolean).at(-1) ?? projectDir;
}

/**
 * Compute which sessions are new relative to existing document titles.
 * @returns string[] of sessionIds not yet archived.
 */
export function findNewSessions(sessions, existingTitles) {
  const known = new Set([...existingTitles].map((title) => String(title).split('_').at(-1)));
  return sessions
    .map((session) => session.sessionId)
    .filter((id) => {
      const tail = String(id).replace(/^session-/, '');
      const short = tail.length > 8 ? tail.slice(0, 8) : tail;
      return !known.has(short);
    });
}

/**
 * Run one archive pass against a project.
 * @param deps - { client, config, log }
 * @param options - { projectKeyword?, projectDir?, dryRun?, knowledgeBaseId? }
 *   Pass `projectDir` (an encoded dir from listProjectDirs) to skip keyword
 *   matching — that is how archiveAllProjects drives this function.
 */
export async function archiveProject(deps, options) {
  const { client, config, log } = deps;
  let projectDir;
  if (options.projectDir) {
    projectDir = options.projectDir;
  } else {
    const dirs = matchProjectDirs(config.sessionsDir, options.projectKeyword);
    if (dirs.length === 0) {
      return { ok: false, error: `no session project dir matches keyword "${options.projectKeyword}" under ${config.sessionsDir}` };
    }
    if (dirs.length > 1) {
      return { ok: false, error: `keyword "${options.projectKeyword}" is ambiguous, matches: ${dirs.join(', ')}` };
    }
    projectDir = dirs[0];
  }
  const projectName = projectNameFromDir(projectDir);
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
  // WeKnora titles a document after the uploaded FILE, so the library shows
  // `data_xxx.md` while the intended title is `会话总结: data_xxx`. Compare on
  // the session key so both spellings deduplicate.
  const isArchived = (title) => {
    if (existingTitles.has(title)) return true;
    const key = title.replace(/^会话总结: /, '').replace(/\.md$/i, '');
    return [...existingTitles].some((existingTitle) =>
      existingTitle.replace(/\.md$/i, '').endsWith(key));
  };

  const uploaded = [];
  const skipped = [];
  const isFirstRun = existingTitles.size === 0;
  for (const session of sessions) {
    const title = sessionDocTitle(projectName, session.sessionId);
    if (isArchived(title)) {
      skipped.push(session.sessionId);
      continue;
    }
    const text = readSessionText(session.filePath);
    if (text.messages.length === 0) {
      skipped.push(session.sessionId);
      continue;
    }
    const summary = summarizeSession(text, { projectName, maxChars: config.maxSummaryChars });
    let markdown = summary.markdown;
    let refined = false;
    if (config.llmBaseUrl && config.llmApiKey && config.llmModel && !options.dryRun) {
      try {
        markdown = await refineSummaryWithLlm(config, markdown);
        refined = markdown !== summary.markdown;
      } catch (err) {
        // Refinement is best-effort: never fail (or leak secrets over) an
        // archive because the optional model call did. One redacted line.
        log?.warn?.(`dsh-weknora-archive: LLM refine failed for ${session.sessionId}, keeping heuristic summary (${String(err?.message ?? err).split('X-API-Key')[0]})`);
      }
    }
    if (options.dryRun) {
      uploaded.push({ sessionId: session.sessionId, title, dryRun: true, chars: summary.markdown.length });
      continue;
    }
    const filename = `${sessionDocTitle(projectName, session.sessionId).replace(/^会话总结: /, '')}.md`;
    try {
      await client.uploadKnowledge({ knowledgeBaseId, title, content: markdown, filename, refined });
      uploaded.push({ sessionId: session.sessionId, title, filename, chars: markdown.length, refined });
    } catch (err) {
      // WeKnora answers 409 duplicate_file when a same-named document already
      // exists. The pre-upload title check misses it whenever a previous run
      // uploaded before its document became listable, so treat it as a skip
      // rather than aborting the whole pass.
      if (err?.status === 409) {
        skipped.push(session.sessionId);
        continue;
      }
      throw err;
    }
  }

  // First run also contributes a project overview.
  let overview = null;
  if (isFirstRun && !options.dryRun && uploaded.length > 0) {
    overview = summarizeProjectOverview({ projectName, projectDir, sessions, summaries: uploaded });
    try {
      await client.uploadKnowledge({
        knowledgeBaseId,
        title: overview.title,
        content: overview.markdown,
        filename: '00_项目总览.md',
      });
    } catch (err) {
      if (err?.status !== 409) throw err;   // an existing overview is fine
      overview = null;
    }
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

/**
 * Archive EVERY (or keyword-filtered) project on this machine in one pass.
 * Designed to be invoked by a scheduled task (e.g. a nightly DSH reminder)
 * so archiving stops depending on the user remembering to ask. One failing
 * project never aborts the sweep — its error is reported per project.
 * Deduplication is the existing per-KB title check, so the sweep is
 * idempotent and safe to re-run at any cadence.
 * @param deps - { client, config, log }
 * @param options - { projectKeyword?, dryRun? }
 */
export async function archiveAllProjects(deps, options = {}) {
  const dirs = matchProjectDirs(deps.config.sessionsDir, options.projectKeyword);
  const results = [];
  const failures = [];
  let uploadedCount = 0;
  let skippedCount = 0;
  for (const projectDir of dirs) {
    const projectName = projectNameFromDir(projectDir);
    try {
      const result = await archiveProject(deps, { projectDir, dryRun: options.dryRun === true });
      if (result.ok) {
        uploadedCount += result.uploaded.length;
        skippedCount += result.skippedCount;
        results.push({
          project: result.project,
          knowledgeBaseId: result.knowledgeBaseId,
          created: result.created,
          uploaded: result.uploaded.length,
          skipped: result.skippedCount,
          empty: result.totalSessions === 0,
          overview: result.overview,
        });
      } else {
        failures.push({ project: projectName, error: result.error });
      }
    } catch (error) {
      failures.push({ project: projectName, error: String(error?.message ?? error).split('X-API-Key')[0] });
    }
  }
  return {
    ok: failures.length === 0,
    projects: dirs.length,
    uploadedCount,
    skippedCount,
    results,
    failures,
    dryRun: options.dryRun === true,
  };
}
