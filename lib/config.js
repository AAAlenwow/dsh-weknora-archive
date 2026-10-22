/**
 * Plugin configuration: shape, defaults and load-time validation.
 * The API key is sensitive: it is never included in log output, error
 * messages, or tool results — see redactConfig().
 * @module dsh-weknora-archive/config
 */

const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  knowledgeBaseId: '',
  sessionsDir: '',
  maxSummaryChars: 8000,
  requestTimeoutMs: 30_000,
  uploadTimeoutMs: 120_000,
  toolPrefix: 'weknora_archive',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  llmTimeoutMs: 60_000,
};

const API_ROOT = /\/api\/v\d+$/;
const TOOL_PREFIX = /^[a-z][a-z0-9_]*$/;

/** Error thrown when the config row cannot be served; message never embeds the key. */
export class ConfigError extends Error {
  constructor(violations) {
    super(`dsh-weknora-archive configuration is invalid:\n  - ${violations.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Normalize a WeKnora base URL to an API root. Both `http://host` and
 * `http://host/api/v1` are accepted, mirroring the official dsh-weknora plugin.
 */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  return API_ROOT.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

function optionalString(value, field, violations) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    violations.push(`${field} must be a string`);
    return '';
  }
  return value.trim();
}

function positiveInt(value, field, violations, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    violations.push(`${field} must be a positive number, received ${JSON.stringify(value)}`);
    return fallback;
  }
  return Math.floor(n);
}

/**
 * Apply defaults and reject an unusable row at load time, so a typo surfaces
 * at boot rather than inside the first tool call.
 * @param raw - the `config` value from the Cordis row.
 */
export function resolveConfig(raw) {
  const violations = [];
  const input = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {};
  const baseUrlRaw = optionalString(input.baseUrl, 'baseUrl', violations);
  let baseUrl = '';
  if (baseUrlRaw === '') {
    violations.push('baseUrl is required (your WeKnora deployment root or API root)');
  } else {
    try {
      const url = new URL(normalizeBaseUrl(baseUrlRaw));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        violations.push(`baseUrl must use http or https, received ${url.protocol}`);
      }
      baseUrl = url.toString().replace(/\/+$/, '');
    } catch {
      violations.push(`baseUrl must be an absolute URL, received a malformed value`);
    }
  }
  const apiKey = optionalString(input.apiKey, 'apiKey', violations);
  if (apiKey === '') violations.push('apiKey is required (a scoped WeKnora API key with ingest capability)');
  const toolPrefix = optionalString(input.toolPrefix, 'toolPrefix', violations) || DEFAULTS.toolPrefix;
  if (!TOOL_PREFIX.test(toolPrefix)) {
    violations.push(`toolPrefix must match ${String(TOOL_PREFIX)}, received a malformed value`);
  }
  const config = {
    baseUrl,
    apiKey,
    knowledgeBaseId: optionalString(input.knowledgeBaseId, 'knowledgeBaseId', violations),
    sessionsDir: optionalString(input.sessionsDir, 'sessionsDir', violations),
    maxSummaryChars: positiveInt(input.maxSummaryChars, 'maxSummaryChars', violations, DEFAULTS.maxSummaryChars),
    requestTimeoutMs: positiveInt(input.requestTimeoutMs, 'requestTimeoutMs', violations, DEFAULTS.requestTimeoutMs),
    uploadTimeoutMs: positiveInt(input.uploadTimeoutMs, 'uploadTimeoutMs', violations, DEFAULTS.uploadTimeoutMs),
    toolPrefix,
  };

  // Optional LLM refinement (OpenAI-compatible /chat/completions). Fully off
  // unless all three fields are provided; a partial row is a typo, so reject
  // it at load time instead of silently refining with the heuristic only.
  const llmBaseUrlRaw = optionalString(input.llmBaseUrl, 'llmBaseUrl', violations);
  const llmApiKey = optionalString(input.llmApiKey, 'llmApiKey', violations);
  const llmModel = optionalString(input.llmModel, 'llmModel', violations);
  const llmParts = [llmBaseUrlRaw, llmApiKey, llmModel];
  if (llmParts.some((part) => part !== '') && llmParts.some((part) => part === '')) {
    violations.push('llmBaseUrl, llmApiKey and llmModel must be provided together to enable LLM refinement (or all omitted to keep it off)');
  }
  let llmBaseUrl = '';
  if (llmBaseUrlRaw !== '') {
    try {
      const url = new URL(llmBaseUrlRaw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        violations.push(`llmBaseUrl must use http or https, received ${url.protocol}`);
      }
      llmBaseUrl = url.toString().replace(/\/+$/, '');
    } catch {
      violations.push('llmBaseUrl must be an absolute URL');
    }
  }
  config.llmBaseUrl = llmBaseUrl;
  config.llmApiKey = llmApiKey;
  config.llmModel = llmModel;
  config.llmTimeoutMs = positiveInt(input.llmTimeoutMs, 'llmTimeoutMs', violations, DEFAULTS.llmTimeoutMs);

  if (violations.length > 0) throw new ConfigError(violations);
  return config;
}

/**
 * Return a copy of the config safe for logging: both keys are replaced by a
 * fixed placeholder. Use this for every log/error path.
 */
export function redactConfig(config) {
  return { ...config, apiKey: '(redacted)', llmApiKey: config.llmApiKey ? '(redacted)' : '' };
}
