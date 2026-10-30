import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Only metadata is persisted: never session text, summaries, URLs or keys. */
export function createManifest({ dryRun = false } = {}) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dryRun,
    summary: { total: 0, completed: 0, parsing: 0, failed: 0, discovered: 0, skipped: 0 },
    documents: [],
    projects: [],
  };
}

export function addManifestProject(manifest, result) {
  manifest.projects.push({ name: result.project, knowledgeBaseId: result.knowledgeBaseId });
  // `uploaded` are session summaries; `extraDocuments` currently carries the
  // first-run project overview. Both get identical metadata + status counting.
  for (const doc of [...(result.uploaded ?? []), ...(result.extraDocuments ?? [])]) {
    const status = doc.dryRun ? 'discovered' : (doc.parseStatus ?? 'parsing');
    manifest.documents.push({
      id: doc.knowledgeId ?? null,
      project: result.project,
      title: doc.title,
      status,
      error: doc.parseError ?? null,
    });
    // `total` counts every document row; the status keys count per status.
    // `discovered` is reserved for dry-run rows (not yet uploaded).
    manifest.summary.total += 1;
    manifest.summary[status] = (manifest.summary[status] ?? 0) + 1;
  }
  manifest.summary.skipped += result.skippedCount ?? 0;
  return manifest;
}

/** Atomic replace: readers see the previous complete report or the new one. */
export function writeManifest(directory, manifest) {
  const finished = { ...manifest, finishedAt: manifest.finishedAt ?? new Date().toISOString() };
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'archive-manifest.json');
  const temporary = join(directory, `.archive-manifest.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(finished, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}
