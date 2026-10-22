/**
 * Minimal write-side WeKnora HTTP client (RESTful, aligned with the endpoints
 * the read-only dsh-weknora plugin and Tencent WeKnora document; routes use
 * kebab-case `/knowledge-bases` and auth is the `X-API-Key` header — NOT
 * Bearer). If a deployment diverges, only this module needs adjusting; see
 * README "API compatibility".
 * @module dsh-weknora-archive/client
 */

import { normalizeBaseUrl } from './config.js';

/** Error carrying HTTP status; message never includes the API key. */
export class WeknoraApiError extends Error {
  constructor(status, method, path, bodySnippet) {
    super(`WeKnora ${method} ${path} failed with HTTP ${status}: ${bodySnippet}`);
    this.name = 'WeknoraApiError';
    this.status = status;
  }
}

export class WeknoraClient {
  /**
   * @param config - resolved plugin config (baseUrl normalized, apiKey present).
   */
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.uploadTimeoutMs = config.uploadTimeoutMs;
  }

  headers(extra = {}) {
    return { 'X-API-Key': this.apiKey, ...extra };
  }

  async request(method, path, { json, timeoutMs, expect = [200] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!expect.includes(response.status)) {
        throw new WeknoraApiError(response.status, method, path, text.slice(0, 300));
      }
      try {
        return text === '' ? {} : JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /knowledge-bases */
  listKnowledgeBases(signal) {
    return this.request('GET', '/knowledge-bases', { timeoutMs: signal?.timeoutMs }).then(
      (body) => Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []),
    );
  }

  /** POST /knowledge-bases — { name, description } */
  createKnowledgeBase(name, description) {
    return this.request('POST', '/knowledge-bases', {
      json: { name, description: description ?? '' },
      expect: [200, 201],
    });
  }

  /** GET /knowledge-bases/{id}/knowledge?page_size=100 — list documents. */
  listKnowledge(knowledgeBaseId) {
    return this.request('GET', `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge?page_size=100`)
      .then((body) => Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []));
  }

  /**
   * POST /knowledge-bases/{id}/knowledge/file — upload one Markdown document.
   *
   * This deployment exposes the multipart upload under the knowledge-base
   * scoped `/knowledge/file` route (taken from the WeKnora web client's own
   * request), not the flat `/knowledge` route used by the upstream docs.
   */
  async uploadKnowledge({ knowledgeBaseId, title, content, filename }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.uploadTimeoutMs);
    const path = `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/file`;
    try {
      const form = new FormData();
      form.append('file', new Blob([new TextEncoder().encode(content)], { type: 'text/markdown' }),
        filename ?? `${title}.md`);
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: form,
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status !== 200 && response.status !== 201) {
        throw new WeknoraApiError(response.status, 'POST', path, text.slice(0, 300));
      }
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /knowledge/{id}/reparse — retry parsing a failed document. */
  reparse(knowledgeId) {
    return this.request('POST', `/knowledge/${encodeURIComponent(knowledgeId)}/reparse`, { expect: [200, 201, 202] });
  }

  /** GET /knowledge/{id} — poll parse status of one document. */
  getKnowledge(knowledgeId) {
    return this.request('GET', `/knowledge/${encodeURIComponent(knowledgeId)}`);
  }

  /**
   * POST /knowledge-bases/{id}/knowledge/manual — create a Markdown note.
   * Lighter than multipart upload; WeKnora parses it exactly like a file and
   * (when the KB has wiki mode on) generates wiki pages server-side.
   */
  createManualKnowledge({ knowledgeBaseId, title, content, channel = 'dsh-weknora-archive' }) {
    return this.request('POST', `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/manual`, {
      json: { title, content, status: 'publish', channel },
      expect: [200, 201],
    });
  }

  /** PUT /knowledge/manual/{id} — replace the body of a manual note. */
  updateManualKnowledge(knowledgeId, content) {
    return this.request('PUT', `/knowledge/manual/${encodeURIComponent(knowledgeId)}`, {
      json: { content, status: 'publish' },
      expect: [200],
    });
  }

  /**
   * GET /knowledgebase/{id}/wiki/stats — wiki page counters. This endpoint is
   * NOT data-wrapped: totals sit at the top level of the response body.
   */
  wikiStats(knowledgeBaseId) {
    return this.request('GET', `/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/stats`);
  }
}

export { normalizeBaseUrl };
