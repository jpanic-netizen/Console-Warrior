import { launchBrowser, newAuditContext } from './browser.js';
import { auditPage } from './pageAudit.js';
import { installSsrfGuard } from './ssrfGuard.js';
import { auditInfrastructure } from './checks/infrastructure.js';

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
 * `environment` (optional 'staging' | 'production') feeds the infrastructure
 * check (robots.txt/sitemap/custom-404/HTTPS), which runs once for the
 * whole site — not once per page — against the first URL's origin, run
 * concurrently with the per-page audits since it doesn't depend on them.
 * Its result is attached to the first successfully-completed page result's
 * `.infrastructure` field (a pragmatic compromise: the per-page result
 * array is this engine's one shared data shape, and every downstream
 * consumer — buildSummary, extractFindings, reports — already iterates it;
 * introducing a true second, site-level return value would touch all of
 * them for one check). If every page errors, the infrastructure result is
 * simply not attached anywhere and is dropped — an accepted edge case.
 */
export async function auditSite({ urls, outDir, viewport, concurrency = 3, onPageDone, onPageStart, signal, ssrf, environment }) {
  const browser = await launchBrowser();
  const onAbort = () => browser.close().catch(() => {});
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const infrastructurePromise = (async () => {
      if (!urls.length) return null;
      try {
        const origin = new URL(urls[0]).origin;
        return await auditInfrastructure(origin, { environment });
      } catch {
        return null;
      }
    })();

    const results = await mapWithConcurrency(urls, concurrency, async (url, index) => {
      if (signal?.aborted) return null;
      if (onPageStart) onPageStart(url, index);
      const context = await newAuditContext(browser, viewport);
      if (ssrf) await installSsrfGuard(context, ssrf);
      try {
        const result = await auditPage(context, url, { outDir, ssrf });
        if (onPageDone) onPageDone(result);
        return result;
      } catch (e) {
        const failure = { url, error: String(e && e.stack ? e.stack : e) };
        if (onPageDone) onPageDone(failure);
        return failure;
      } finally {
        await context.close().catch(() => {});
      }
    }, signal);

    const okResults = results.filter(Boolean);
    const infrastructure = await infrastructurePromise;
    const firstOk = okResults.find((r) => !r.error);
    if (infrastructure && firstOk) firstOk.infrastructure = infrastructure;

    return okResults;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
