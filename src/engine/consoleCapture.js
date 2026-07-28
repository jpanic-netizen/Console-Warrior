/**
 * Captures a page's own browser console/network activity during an audit —
 * console.log/info/debug/warn/error, uncaught exceptions, failed network
 * requests, and HTTP 4xx/5xx responses — so it can be reviewed later
 * (dashboard live stream + persisted diagnostics) without re-running
 * anything.
 *
 * Deliberately narrow about what it records: request/response HEADERS and
 * BODIES are never captured at all (so cookies, Authorization headers, and
 * request bodies containing passwords/tokens never enter this data in the
 * first place — there's no redaction step for what was never collected).
 * URLs are the one place secrets commonly leak via query strings (API keys,
 * session tokens), so those are redacted before being retained. Retention is
 * capped per page so a chatty/broken site can't grow the in-memory result
 * (and the persisted JSON) without bound.
 */

/** Query-string parameter names that commonly carry a credential/secret. Matched case-insensitively. */
const SENSITIVE_PARAM_NAMES = new Set([
  'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'id_token', 'idtoken',
  'api_key', 'apikey', 'api-key', 'key', 'secret', 'client_secret', 'clientsecret',
  'password', 'passwd', 'pwd', 'auth', 'authorization', 'session', 'sessionid', 'session_id',
  'sid', 'jwt', 'credential', 'credentials', 'signature', 'sig',
]);

/** Per-category cap on retained entries — generous enough for real debugging, bounded enough that a
 * runaway/chatty page can't grow a result file without limit. Documented here since it's the one
 * source of truth other code (and tests) should reference rather than re-guessing a number. */
export const MAX_RETAINED_ENTRIES = 500;

/** Redacts known-sensitive query-string parameter values in a URL; leaves the path, host, and any
 * non-sensitive params untouched. Malformed URLs are returned as-is (nothing to parse). */
export function redactUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  let redactedAny = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM_NAMES.has(key.toLowerCase())) {
      url.searchParams.set(key, '[REDACTED]');
      redactedAny = true;
    }
  }
  return redactedAny ? url.toString() : rawUrl;
}

function pushCapped(list, entry, cap) {
  if (list.length >= cap) {
    list.truncated = true;
    return;
  }
  list.push(entry);
}

/**
 * Attaches capture listeners to a page and returns the live-growing result
 * object. Call this before navigation so nothing early is missed.
 *
 * @param {import('playwright').Page} page
 * @param {{ onEntry?: (category: string, entry: object) => void, cap?: number }} [opts]
 *   onEntry fires for every captured entry as it happens — the dashboard's
 *   live-stream hook; the returned object is also the durable, persisted
 *   record once the page audit finishes.
 */
export function attachConsoleCapture(page, opts = {}) {
  const cap = opts.cap ?? MAX_RETAINED_ENTRIES;
  const notify = opts.onEntry || (() => {});

  const consoleMessages = [];
  consoleMessages.truncated = false;
  const pageErrors = [];
  pageErrors.truncated = false;
  const networkFailures = [];
  networkFailures.truncated = false;
  const httpErrors = [];
  httpErrors.truncated = false;

  page.on('console', (msg) => {
    const loc = msg.location();
    const entry = {
      level: msg.type(), // 'log' | 'info' | 'debug' | 'warning' | 'error' | ...
      text: msg.text(),
      sourceUrl: loc && loc.url ? redactUrl(loc.url) : null,
      sourceLine: loc && typeof loc.lineNumber === 'number' ? loc.lineNumber + 1 : null,
      timestamp: new Date().toISOString(),
    };
    pushCapped(consoleMessages, entry, cap);
    notify('console', entry);
  });

  page.on('pageerror', (err) => {
    const entry = {
      message: String((err && err.message) || err),
      stack: err && err.stack ? String(err.stack) : null,
      timestamp: new Date().toISOString(),
    };
    pushCapped(pageErrors, entry, cap);
    notify('pageerror', entry);
  });

  page.on('requestfailed', (request) => {
    const entry = {
      url: redactUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || 'unknown network error',
      timestamp: new Date().toISOString(),
    };
    pushCapped(networkFailures, entry, cap);
    notify('networkFailure', entry);
  });

  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const entry = {
      url: redactUrl(response.url()),
      method: response.request().method(),
      status,
      statusText: response.statusText(),
      resourceType: response.request().resourceType(),
      timestamp: new Date().toISOString(),
    };
    pushCapped(httpErrors, entry, cap);
    notify('httpError', entry);
  });

  return { consoleMessages, pageErrors, networkFailures, httpErrors };
}
