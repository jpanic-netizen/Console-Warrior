/**
 * SOP check catalogue — "Console": no uncaught errors on load (interaction
 * coverage — forms/CTA clicks — is Phase 4; this only covers what the
 * existing read-only audit already triggers: load plus the scroll pass
 * primePage() does to surface lazy content).
 *
 * Classification/dedup is kept as a pure function, separate from the
 * actual page.on('pageerror')/page.on('console') event wiring in
 * pageAudit.js, so it's unit-testable without a real browser.
 *
 * "Identify first-party versus third-party sources" (SOP §6's "third-party
 * assets attributed to us" trap) needs the error's origin: page.on('console')
 * messages carry real location() data from Chromium; uncaught exceptions
 * (page.on('pageerror')) don't expose that as cleanly, so their source is
 * best-effort parsed from the first http(s) URL in the stack trace — falling
 * back to 'unknown' rather than guessing wrong is safer than presenting a
 * wrong guess as first-party.
 */
export function classifyConsoleErrors(rawErrors, pageOrigin) {
  const seen = new Set();
  const out = [];

  for (const e of rawErrors) {
    const message = (e.message || '').trim();
    if (!message) continue;
    const dedupeKey = message.slice(0, 200);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let origin = 'unknown';
    if (e.sourceUrl) {
      try {
        origin = new URL(e.sourceUrl, pageOrigin).origin === pageOrigin ? 'internal' : 'external';
      } catch {
        origin = 'unknown';
      }
    }

    out.push({
      message: message.slice(0, 300),
      source: e.sourceUrl || null,
      kind: e.kind,
      origin,
    });
  }

  return out;
}

/** Best-effort source-file extraction from an uncaught exception's stack —
 * the first http(s) URL found, stripped of its trailing :line:col. */
export function sourceUrlFromStack(stack) {
  if (!stack) return null;
  const match = String(stack).match(/(https?:\/\/[^\s)]+)/);
  if (!match) return null;
  return match[1].replace(/:\d+:\d+$/, '');
}
