import { checkTargetSafety } from '../ssrfGuard.js';

/**
 * SOP check catalogue — "Broken links": resolve every visible, distinct
 * link and record its status code. Requests go through the page's own
 * request context (page.request — an APIRequestContext that reuses the
 * page's cookies/session) rather than real navigation, so checking N links
 * costs N HTTP requests, not N browser-tab loads, and never risks
 * triggering a side-effecting action a real click on a button would (a
 * GET-method request against a link href is the read-only case the SOP's
 * "do not activate destructive controls" rule is not about).
 *
 * page.request does NOT go through a context's route() handlers the way
 * real page navigation does — the dashboard's SSRF guard for the audited
 * page's own navigation would otherwise silently not apply here, and a
 * page can contain attacker-influenced links pointing at private/internal
 * addresses regardless of who authorized the original audit target. Every
 * unique EXTERNAL link origin is re-checked with the same
 * checkTargetSafety() the dashboard uses for the initial target, before
 * anything is fetched — internal (same-origin) links are exempt, since
 * we're already navigated to that origin (it was already the audit
 * target), so re-checking it would just incorrectly block a legitimately
 * private/local audit target's own same-site links.
 *
 * False-positive traps this guards against (SOP §6):
 * - "Hidden elements counted as defects" / "Responsive duplicate markup":
 *   only isShown() elements are considered, deduped by resolved URL +
 *   visible text, so a desktop/mobile duplicate reads as one link.
 * - "External 403/503 read as broken": a non-2xx/3xx response from a
 *   different origin than the audited page, with a status/failure
 *   consistent with automated-request blocking, is reported with
 *   manualReview:true — a human has to confirm it in a real browser
 *   before it's a real defect, never an automatic one.
 */

const AUTOMATION_BLOCK_STATUSES = new Set([401, 403, 429, 503]);
const REQUEST_TIMEOUT_MS = 10_000;

export async function auditLinkResolution(page, opts = {}) {
  const { allowHosts = [] } = opts;
  const pageOrigin = new URL(page.url()).origin;

  const links = await page.evaluate(() => {
    const { isShown, cleanText, tag } = window.__cw;
    const seen = new Set();
    const out = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      if (!isShown(a)) return;
      const raw = (a.getAttribute('href') || '').trim();
      // Empty/#/javascript: anchors have no destination to resolve — those
      // are dead-click candidates (a separate check), not broken links.
      if (raw === '' || raw === '#' || raw.toLowerCase().startsWith('javascript:')) return;
      let resolved;
      try {
        resolved = new URL(raw, location.href).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(resolved)) return; // mailto:, tel:, etc. aren't web links to resolve
      const text = cleanText(a.textContent) || '(icon or empty text)';
      const dedupeKey = `${resolved}::${text}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      out.push({ id: tag(a, 'link'), href: resolved, text: text.slice(0, 60) });
    });
    return out;
  });

  // Resolve target safety once per unique EXTERNAL origin, not once per
  // link — a page can easily repeat the same external origin dozens of
  // times, and internal links never need this check at all (see header).
  const safetyByOrigin = new Map();
  const broken = [];

  for (const link of links) {
    const linkOrigin = new URL(link.href).origin;
    const isExternal = linkOrigin !== pageOrigin;

    if (isExternal) {
      // eslint-disable-next-line no-await-in-loop
      if (!safetyByOrigin.has(linkOrigin)) safetyByOrigin.set(linkOrigin, await checkTargetSafety(link.href, { allowHosts }));
    }
    const safety = isExternal ? safetyByOrigin.get(linkOrigin) : { ok: true };
    if (!safety.ok) {
      broken.push({
        id: link.id, href: link.href, text: link.text, status: null, networkError: safety.reason,
        isExternal, manualReview: true, origin: isExternal ? 'external' : 'internal', reference: link.href,
      });
      continue;
    }

    let status = null;
    let networkError = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await page.request.get(link.href, { timeout: REQUEST_TIMEOUT_MS, failOnStatusCode: false });
      status = res.status();
    } catch (e) {
      networkError = String((e && e.message) || e).slice(0, 200);
    }

    const ok = status !== null && status >= 200 && status < 400;
    if (ok) continue;

    const looksAutomationBlocked = isExternal && (networkError !== null || AUTOMATION_BLOCK_STATUSES.has(status));
    broken.push({
      id: link.id,
      href: link.href,
      text: link.text,
      status,
      networkError,
      isExternal,
      manualReview: looksAutomationBlocked,
      origin: isExternal ? 'external' : 'internal',
      reference: link.href,
    });
  }

  return { checkedCount: links.length, broken };
}
