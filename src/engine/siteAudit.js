import { launchBrowser, newAuditContext } from './browser.js';
import { auditPage } from './pageAudit.js';
import { installSsrfGuard } from './ssrfGuard.js';
import { resolveDeviceProfile } from './deviceProfiles.js';

async function mapWithConcurrency(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length && !signal?.aborted) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Audits every URL in `urls`, each in its own browser context (clean
 * cookies/storage per page — the "always run in Incognito" rule from the
 * source methodology, applied automatically instead of relying on the
 * human running it to remember).
 *
 * `signal` (optional AbortSignal) lets a caller cancel a run in progress —
 * closing the browser is the only way to interrupt in-flight Playwright
 * calls, so an abort ends the whole browser immediately; URLs not yet
 * started are simply never picked up. Either way, whatever pages did
 * finish are still returned, so a cancelled run still yields a usable
 * partial result set instead of nothing.
 *
 * `ssrf` (optional { allowHosts? }) installs a per-request SSRF guard on
 * every context — see engine/ssrfGuard.js. Off by default so the CLI (a
 * trusted operator auditing a site directly) and the local fixture-server
 * smoke test keep working unchanged; the dashboard turns this on since it
 * lets arbitrary callers submit arbitrary URLs.
 *
 * `deviceProfile` (optional, the object resolveDeviceProfile() returns, or a
 * bare {width,height}) controls the viewport/DPR/mobile-emulation settings
 * every page context is created with; defaults to the Desktop profile.
 * `engine` names which browser engine actually ran this ('chromium' |
 * 'webkit') — stamped onto every page result so reports/diagnostics always
 * know how a finding was reproduced; auditSite() itself doesn't choose the
 * engine (the caller already picked a launcher), it just labels the output.
 */
export async function auditSite({ urls, outDir, viewport, deviceProfile, concurrency = 3, onPageDone, onPageStart, signal, ssrf, engine = 'chromium', launch }) {
  const resolvedDevice =
    deviceProfile ||
    (viewport
      ? resolveDeviceProfile({ deviceKey: 'custom', width: viewport.width, height: viewport.height, engine })
      : resolveDeviceProfile({ deviceKey: 'desktop', engine }));
  const browser = await (launch ? launch() : launchBrowser());
  const onAbort = () => browser.close().catch(() => {});
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const results = await mapWithConcurrency(urls, concurrency, async (url, index) => {
      if (signal?.aborted) return null;
      if (onPageStart) onPageStart(url, index);
      const context = await newAuditContext(browser, resolvedDevice);
      if (ssrf) await installSsrfGuard(context, ssrf);
      try {
        const result = await auditPage(context, url, { outDir, deviceProfile: resolvedDevice, engine });
        if (onPageDone) onPageDone(result);
        return result;
      } catch (e) {
        const failure = { url, error: String(e && e.stack ? e.stack : e), engine, deviceProfile: resolvedDevice };
        if (onPageDone) onPageDone(failure);
        return failure;
      } finally {
        await context.close().catch(() => {});
      }
    }, signal);
    return results.filter(Boolean);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
