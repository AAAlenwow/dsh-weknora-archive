/** Read-only parse polling. Unknown IDs and timeouts stay non-success. */
export function unwrapKnowledge(body) {
  return body?.data && !Array.isArray(body.data) ? body.data : (body ?? {});
}

export function knowledgeIdOf(body) {
  const value = unwrapKnowledge(body);
  return value?.id ?? value?.knowledge_id ?? value?.knowledgeId ?? null;
}

const delay = (ms, sleep) => (sleep ? sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

export async function waitForKnowledge(client, knowledgeId, {
  timeoutMs = 60_000,
  intervalMs = 1_000,
  sleep,
  now = () => Date.now(),
} = {}) {
  if (!knowledgeId || typeof client.getKnowledge !== 'function') {
    return { status: 'parsing', error: 'Upload returned no document id; refresh to reconcile parse status.' };
  }
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      const doc = unwrapKnowledge(await client.getKnowledge(knowledgeId));
      const status = String(doc.parse_status ?? doc.status ?? 'parsing').toLowerCase();
      if (status === 'completed') return { status, error: null };
      if (['failed', 'error'].includes(status)) {
        return { status: 'failed', error: String(doc.parse_error ?? doc.error_message ?? 'WeKnora parsing failed').slice(0, 300) };
      }
    } catch (error) {
      lastError = String(error?.message ?? error).split('X-API-Key')[0].slice(0, 300);
    }
    await delay(intervalMs, sleep);
  }
  return { status: 'parsing', error: lastError ?? 'Parsing has not completed before the observation timeout.' };
}

export async function reconcileDocuments(client, documents, options = {}) {
  const reconciled = [];
  for (const document of documents) {
    if (document.dryRun) {
      reconciled.push(document);
      continue;
    }
    const result = await waitForKnowledge(client, document.knowledgeId, options);
    reconciled.push({ ...document, parseStatus: result.status, parseError: result.error });
  }
  return reconciled;
}
