import { launchBrowser, newAuditContext } from './browser.js';
import { auditPage } from './pageAudit.js';

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
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
 */
export async function auditSite({ urls, outDir, viewport, concurrency = 3, onPageDone }) {
  const browser = await launchBrowser();
  try {
    const results = await mapWithConcurrency(urls, concurrency, async (url) => {
      const context = await newAuditContext(browser, viewport);
      try {
        const result = await auditPage(context, url, { outDir });
        if (onPageDone) onPageDone(result);
        return result;
      } catch (e) {
        const failure = { url, error: String(e && e.stack ? e.stack : e) };
        if (onPageDone) onPageDone(failure);
        return failure;
      } finally {
        await context.close();
      }
    });
    return results;
  } finally {
    await browser.close();
  }
}
