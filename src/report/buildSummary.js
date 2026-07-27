import { CHECK_DEFS } from './findings.js';

/**
 * Reduces the raw per-page results into (a) a scorecard of hard-fail counts
 * per check, (b) a "needs a human eye" bucket kept separate from failures so
 * it never inflates or hides in the fail count, and (c) a cross-page table
 * of which pages share each failure type — the site-wide items (contrast
 * tokens, nav, footer) only need calling out once instead of once per page.
 *
 * Every check's definition — including how to read its raw fields — lives
 * once in findings.js's CHECK_DEFS; this file only decides how to fold that
 * per-item list into totals, so a new check never needs a second edit here.
 */
export function buildSummary(pageResults) {
  const ok = pageResults.filter((r) => !r.error);
  const errored = pageResults.filter((r) => r.error);

  const automatedDefs = CHECK_DEFS.filter((d) => !d.manualReview);
  const totals = Object.fromEntries(automatedDefs.map((d) => [d.key, 0]));
  const perCheckPages = Object.fromEntries(automatedDefs.map((d) => [d.key, []]));
  let manualReviewCount = 0;

  ok.forEach((r) => {
    for (const def of CHECK_DEFS) {
      const items = def.items(r) || [];
      if (def.manualReview) {
        manualReviewCount += items.length;
      } else if (items.length > 0) {
        totals[def.key] += items.length;
        perCheckPages[def.key].push(r.url);
      }
    }
  });

  return {
    pagesAudited: ok.length,
    pagesErrored: errored.length,
    erroredUrls: errored.map((r) => r.url),
    totals,
    manualReviewCount,
    perCheckPages,
  };
}
