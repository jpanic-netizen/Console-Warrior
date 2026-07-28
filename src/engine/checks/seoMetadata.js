/**
 * SOP check catalogue — "SEO metadata": unique title and meta description,
 * canonical present, OG/Twitter tags present, exactly one H1, no stray
 * noindex. Title and H1 count are already captured by the headings check
 * (r.headings.pageTitle / r.headings.visibleH1Count) — this module only
 * captures the fields nothing else already reads, to avoid two places
 * disagreeing about the same DOM query.
 *
 * "No stray noindex" is judged relative to which environment is being
 * audited (a noindex on staging is normal, the same tag on production is a
 * problem) — that judgement needs the environment intake field this module
 * doesn't have access to on its own, so a noindex tag here is always
 * reported as a manual-review candidate ("confirm this is intentional"),
 * never an automated pass/fail either way. The infra checks (robots.txt)
 * carry the actual environment-aware escalation.
 *
 * Cross-page duplicate title/description detection is NOT here — a
 * per-page check function physically cannot see other pages' results —
 * see annotateCrossPageSeoDuplicates() in report/findings.js, the layer
 * that already aggregates across pages.
 */
export async function auditSeoMetadata(page) {
  return page.evaluate(() => {
    const metaContent = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || null;
    return {
      description: metaContent('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
      ogTitle: metaContent('meta[property="og:title"]'),
      ogDescription: metaContent('meta[property="og:description"]'),
      ogImage: metaContent('meta[property="og:image"]'),
      twitterCard: metaContent('meta[name="twitter:card"]'),
      robotsMeta: metaContent('meta[name="robots"]'),
      lang: document.documentElement.lang || '',
    };
  });
}
