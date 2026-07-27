import { checkTargetSafety } from '../ssrfGuard.js';

/**
 * SOP check catalogue — "Broken images": pass condition is "every image
 * source returns 200 and renders with non-zero dimensions" — both halves,
 * not just the HTTP status. An image can 200 and still be broken (corrupt
 * data, an HTML error page served with an image content-type); relying on
 * status alone would miss that, and relying on rendering alone would miss
 * a 404 the browser silently swallows into a broken-image icon.
 *
 * Lazy-loaded images (native loading="lazy" or a JS/IntersectionObserver
 * swap-on-scroll pattern) don't have real image data yet at page-load time
 * — scrollIntoViewIfNeeded() plus waiting for load/error before reading
 * naturalWidth is required, or every lazy image below the fold would read
 * as "broken" simply for not having loaded yet (SOP §6's spirit: don't
 * report something that was never actually given a chance to render).
 *
 * Shares linkResolution's SSRF handling exactly: page.request bypasses a
 * context's route()-based guard, so every unique *external* image origin
 * is re-checked with checkTargetSafety() before anything is fetched;
 * same-origin images are exempt (already the vetted audit target).
 */

const AUTOMATION_BLOCK_STATUSES = new Set([401, 403, 429, 503]);
const REQUEST_TIMEOUT_MS = 10_000;

async function waitForRender(page, id) {
  const locator = page.locator(`[data-cw-id~="${id}"]`);
  try {
    await locator.first().scrollIntoViewIfNeeded({ timeout: 3000 });
    await locator.first().evaluate(
      (el) =>
        el.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              el.addEventListener('load', resolve, { once: true });
              el.addEventListener('error', resolve, { once: true });
              setTimeout(resolve, 4000); // don't hang forever on a truly stalled load
            })
    );
    return await locator.first().evaluate((el) => el.naturalWidth > 0 && el.naturalHeight > 0);
  } catch {
    return false;
  }
}

export async function auditImageResolution(page, opts = {}) {
  const { allowHosts = [] } = opts;
  const pageOrigin = new URL(page.url()).origin;

  const images = await page.evaluate(() => {
    const { isShown, tag } = window.__cw;
    const seen = new Set();
    const out = [];
    document.querySelectorAll('img').forEach((img) => {
      if (!isShown(img)) return;
      // currentSrc reflects the browser's own srcset/picture resolution —
      // the actual URL rendered for this viewport, not just the fallback
      // `src` attribute — so a responsive desktop/mobile duplicate pair
      // that resolves to the same file dedupes correctly below.
      const src = img.currentSrc || img.src;
      if (!src) return;
      let resolved;
      try {
        resolved = new URL(src, location.href).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(resolved)) return; // data: URIs render inline; nothing to resolve over HTTP
      if (seen.has(resolved)) return;
      seen.add(resolved);
      out.push({ id: tag(img, 'img'), href: resolved, alt: (img.getAttribute('alt') || '').slice(0, 60) });
    });
    return out;
  });

  const safetyByOrigin = new Map();
  const broken = [];

  for (const image of images) {
    const imgOrigin = new URL(image.href).origin;
    const isExternal = imgOrigin !== pageOrigin;

    if (isExternal) {
      // eslint-disable-next-line no-await-in-loop
      if (!safetyByOrigin.has(imgOrigin)) safetyByOrigin.set(imgOrigin, await checkTargetSafety(image.href, { allowHosts }));
    }
    const safety = isExternal ? safetyByOrigin.get(imgOrigin) : { ok: true };
    if (!safety.ok) {
      broken.push({
        id: image.id, href: image.href, alt: image.alt, status: null, networkError: safety.reason, renderedOk: false,
        isExternal, manualReview: true, origin: 'external', reference: image.href,
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const renderedOk = await waitForRender(page, image.id);

    let status = null;
    let networkError = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await page.request.get(image.href, { timeout: REQUEST_TIMEOUT_MS, failOnStatusCode: false });
      status = res.status();
    } catch (e) {
      networkError = String((e && e.message) || e).slice(0, 200);
    }

    const httpOk = status !== null && status >= 200 && status < 400;
    if (httpOk && renderedOk) continue;

    const looksAutomationBlocked = isExternal && (networkError !== null || AUTOMATION_BLOCK_STATUSES.has(status));
    // httpOk-but-not-rendered is genuinely ambiguous from this data alone:
    // it can mean truly corrupt image bytes, but it can equally mean the
    // <img>'s own load event just hadn't fired yet within waitForRender's
    // wait window (a large/slow asset, a carousel slide the outer page's
    // scrollIntoViewIfNeeded() can't reach because it's clipped/positioned
    // by an inner, non-scrollable track, etc.) — seen on a real regression
    // run as a run of otherwise-valid CDN images all reporting this way.
    // Automation has no way to tell those apart without clicking/waiting
    // indefinitely (out of scope — no interaction, no unbounded waits), so
    // never assume the worse case; leave it for a human to actually look at.
    const renderUnconfirmed = httpOk && !renderedOk;
    broken.push({
      id: image.id,
      href: image.href,
      alt: image.alt,
      status,
      networkError,
      renderedOk,
      isExternal,
      manualReview: looksAutomationBlocked || renderUnconfirmed,
      reviewReason: looksAutomationBlocked ? 'external-blocked' : renderUnconfirmed ? 'subjective' : null,
      origin: isExternal ? 'external' : 'internal',
      reference: image.href,
    });
  }

  return { checkedCount: images.length, broken };
}
