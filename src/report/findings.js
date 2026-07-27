/**
 * Flattens the raw per-page results (the same shape auditSite() / auditPage()
 * already produce) into one finding-per-instance list, for UIs that need to
 * filter/browse individual findings rather than read the aggregated counts
 * buildSummary() produces. This is a read-only derived view — it does not
 * change what any check computes.
 *
 * CHECK_DEFS below is the single source of truth for "what checks exist and
 * how to read their raw fields" — both this file's extractFindings() and
 * buildSummary.js's totals/perCheckPages derive from it, so a new check only
 * ever needs to be listed here once. Adding a check here automatically makes
 * it show up in reports and dashboard totals; there is nowhere else to edit.
 */

export const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];

/**
 * VAN QA SOP severity taxonomy (Blocker/High/Medium/Low), display-only —
 * the internal critical/serious/moderate/minor vocabulary above is axe-core's
 * own and stays exactly as-is everywhere it's used for sorting/grouping.
 *
 * A check's own `suggestedSeverity` is capped at "High": only a human can
 * know whether something actually blocks launch or a core journey (the SOP's
 * own definition of Blocker), so no automated check is ever allowed to
 * self-assign it — "critical" and "serious" both cap at "High" here.
 */
export const SOP_SEVERITIES = ['Low', 'Medium', 'High', 'Blocker'];

const SOP_SEVERITY_BY_INTERNAL = {
  critical: 'High',
  serious: 'High',
  moderate: 'Medium',
  minor: 'Low',
};

/** Null in, null out: a finding with no internal severity (manual-review
 * items today) gets no automated suggestion either — the tool declines to
 * guess rather than invent one. */
export function suggestSopSeverity(internalSeverity) {
  if (!internalSeverity) return null;
  return SOP_SEVERITY_BY_INTERNAL[internalSeverity] || 'Medium';
}

/**
 * Why a manualReview:true finding can't be auto-confirmed, distinct from
 * *whether* it's confirmed (that's verificationStatus/classification):
 *   - 'subjective'            needs a human's eyes/judgment on something
 *                             automation has no ground truth for (decorative
 *                             image? real dead click? text over a gradient?)
 *   - 'external-blocked'      automation's own request was refused/blocked
 *                             (403/429/503/timeout on a third-party host) —
 *                             may well be a false positive, not a real defect
 *   - 'environment-dependent' the SAME technical fact means something
 *                             different on staging vs. production (SOP's own
 *                             "Disallow: /" example) and the environment
 *                             wasn't known/confirmed at audit time
 * Only set on findings where manualReview is true; null otherwise.
 */
export const REVIEW_REASONS = ['subjective', 'external-blocked', 'environment-dependent'];

function truncate(s, n = 90) {
  const str = String(s ?? '').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * Cross-page duplicate title/meta-description detection, mutating each
 * page result in place (the same "annotate after the fact" pattern
 * captureHighlightedFindings already uses for screenshots) — the engine's
 * per-page seoMetadata check physically cannot see other pages' results,
 * so this runs once, here, over the whole audited set. Called from both
 * extractFindings() and buildSummary() (idempotent either way) so neither
 * has an implicit ordering dependency on the other.
 */
export function annotateCrossPageSeoDuplicates(pageResults) {
  const titleMap = new Map();
  const descriptionMap = new Map();

  for (const r of pageResults) {
    if (!r || r.error || !r.seo) continue;
    const title = (r.headings?.pageTitle || '').trim().toLowerCase();
    if (title) {
      if (!titleMap.has(title)) titleMap.set(title, []);
      titleMap.get(title).push(r.url);
    }
    const description = (r.seo.description || '').trim().toLowerCase();
    if (description) {
      if (!descriptionMap.has(description)) descriptionMap.set(description, []);
      descriptionMap.get(description).push(r.url);
    }
  }

  for (const r of pageResults) {
    if (!r || r.error || !r.seo) continue;
    const title = (r.headings?.pageTitle || '').trim().toLowerCase();
    const description = (r.seo.description || '').trim().toLowerCase();
    const titlePages = title ? titleMap.get(title) : [];
    const descriptionPages = description ? descriptionMap.get(description) : [];
    r.seo.duplicateTitleWith = titlePages.length > 1 ? titlePages.filter((u) => u !== r.url) : [];
    r.seo.duplicateDescriptionWith = descriptionPages.length > 1 ? descriptionPages.filter((u) => u !== r.url) : [];
  }
}

function normalizeAxeImpact(impact) {
  return SEVERITIES.includes(impact) ? impact : 'moderate';
}

/**
 * Each entry describes one SOW check's findings array (or a page-level
 * boolean condition) and how to turn its raw items into a display summary.
 * `severity` here is a fixed default; `axeViolations` overrides it per-item
 * from axe's own `impact` field since axe already grades that per rule.
 */
export const CHECK_DEFS = [
  {
    key: 'axeViolations',
    section: '0 · Axe baseline',
    label: 'Axe-core cross-check violation',
    manualReview: false,
    items: (r) =>
      (r.axe.violations || []).map((v) => ({
        severity: normalizeAxeImpact(v.impact),
        summary: `${v.rule} — ${v.help} (${v.nodesCount} node${v.nodesCount === 1 ? '' : 's'})`,
      })),
  },
  {
    key: 'contrastFailures',
    section: '1 · Contrast',
    label: 'Contrast failure',
    severity: 'serious',
    manualReview: false,
    items: (r) =>
      r.contrast.failures.map((f) => ({
        summary: `"${truncate(f.text)}" — ${f.ratio}:1 (needs ${f.needed}:1)`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'contrastManualReview',
    section: '1 · Contrast',
    label: 'Contrast — text over image/gradient',
    manualReview: true,
    reviewReason: 'subjective',
    items: (r) =>
      r.contrast.manualReview.map((f) => ({
        summary: `"${truncate(f.text)}" — ${f.reason}`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'keyboardInvisibleFocus',
    section: '2 · Keyboard nav',
    label: 'Invisible tab stop',
    severity: 'critical',
    manualReview: false,
    items: (r) =>
      r.keyboard.tabOrder.invisibleStops.map((o) => ({
        summary: `Stop ${o.stop}: ${o.tag} "${truncate(o.name, 50)}" receives focus but is not visible`,
      })),
  },
  {
    key: 'dropdownFailures',
    section: '2 · Keyboard nav',
    label: 'Dropdown/toggle keyboard-inoperable',
    severity: 'critical',
    manualReview: false,
    items: (r) =>
      r.keyboard.dropdowns.results
        .filter((d) => !d.opensWithEnter || !d.opensWithSpace)
        .map((d) => ({
          summary: `"${truncate(d.toggle, 40)}" (${d.role}) — Enter:${d.opensWithEnter ? 'ok' : 'FAIL'} Escape:${
            d.closesWithEscape ? 'ok' : 'FAIL'
          } Space:${d.opensWithSpace ? 'ok' : 'FAIL'}`,
        })),
  },
  {
    key: 'focusableButHidden',
    section: '2 · Keyboard nav',
    label: 'Focusable but hidden (keyboard trap)',
    severity: 'critical',
    manualReview: false,
    items: (r) =>
      r.keyboard.focusableHidden.focusableButHidden.map((f) => ({
        summary: `${f.tag} "${truncate(f.text, 50)}" is focusable but hidden${f.href ? ` (href: ${f.href})` : ''}`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'focusNoIndicator',
    section: '3 · Focus state',
    label: 'No visible focus indicator',
    severity: 'serious',
    manualReview: false,
    items: (r) =>
      r.focusState.noIndicator.map((f) => ({
        summary: `${f.tag} "${truncate(f.element, 50)}" — no visible change on focus`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'focusWeakIndicator',
    section: '3 · Focus state',
    label: 'Weak focus indicator',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.focusState.weakIndicator.map((f) => ({
        summary: `${f.tag} "${truncate(f.element, 50)}" — changes ${f.indicator} instead of outline/box-shadow`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'altMissingAttr',
    section: '4 · Alt text',
    label: 'Missing alt attribute',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.altText.noAttr.map((f) => ({ summary: `<img src="${truncate(f.src, 60)}"> has no alt attribute`, screenshot: f.screenshot })),
  },
  {
    key: 'altFilenameAsAlt',
    section: '4 · Alt text',
    label: 'Filename used as alt text',
    severity: 'moderate',
    manualReview: false,
    items: (r) => r.altText.filenameAsAlt.map((f) => ({ summary: `alt="${truncate(f.alt, 60)}" looks like a filename`, screenshot: f.screenshot })),
  },
  {
    key: 'altLinkedNoName',
    section: '4 · Alt text',
    label: 'Linked image with no accessible name',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.altText.linkedNoName.map((f) => ({ summary: `Linked image "${truncate(f.src, 60)}" has no accessible name`, screenshot: f.screenshot })),
  },
  {
    key: 'altReviewEmptyAlt',
    section: '4 · Alt text',
    label: 'Alt text — confirm decorative (alt="")',
    manualReview: true,
    reviewReason: 'subjective',
    items: (r) =>
      r.altText.reviewEmptyAlt.map((f) => ({
        summary: `"${truncate(f.file, 50)}" (${f.widthPx}px) near heading "${truncate(f.nearestHeading, 30)}"${f.inLink ? ', inside a link' : ''} — confirm decorative`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'headingSkips',
    section: '5 · Headings',
    label: 'Heading level skip',
    severity: 'moderate',
    manualReview: false,
    items: (r) => r.headings.skips.map((s) => ({ summary: String(s) })),
  },
  {
    key: 'headingMissingTitle',
    section: '5 · Headings',
    label: 'Missing page title',
    severity: 'serious',
    manualReview: false,
    items: (r) => (r.headings.pageTitle ? [] : [{ summary: 'Page has no <title> element' }]),
  },
  {
    key: 'headingMultipleH1',
    section: '5 · Headings',
    label: 'Multiple visible H1s',
    severity: 'moderate',
    manualReview: false,
    items: (r) => (r.headings.visibleH1Count > 1 ? [{ summary: `${r.headings.visibleH1Count} visible H1 elements found` }] : []),
  },
  {
    key: 'ariaNoName',
    section: '6 · ARIA',
    label: 'Interactive element with no accessible name',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.aria.noName.map((f) => ({ summary: `${f.tag}: ${truncate(f.html, 70)}`, screenshot: f.screenshot })),
  },
  {
    key: 'ariaLabelInName',
    section: '6 · ARIA',
    label: '2.5.3 Label in Name violation',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.aria.labelInName.map((f) => ({
        summary: `Visible text "${truncate(f.visible, 40)}" not contained in aria-label "${truncate(f.ariaLabel, 40)}"`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'ariaInputNoLabel',
    section: '6 · ARIA',
    label: 'Form input with no label',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.aria.inputNoLabel.map((f) => ({
        summary: `<input type="${f.type}"${f.fieldId ? ` id="${f.fieldId}"` : ''}${f.name ? ` name="${f.name}"` : ''}> has no label${
          f.placeholder ? ` (placeholder: "${truncate(f.placeholder, 30)}")` : ''
        }`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'ariaNoAutocomplete',
    section: '6 · ARIA',
    label: '1.3.5 Missing autocomplete',
    severity: 'minor',
    manualReview: false,
    items: (r) => r.aria.noAutocomplete.map((f) => ({ summary: `Field "${truncate(f.field, 40)}" (${f.type}) has no autocomplete attribute` })),
  },
  {
    key: 'ariaExpandedBad',
    section: '6 · ARIA',
    label: 'aria-expanded on non-interactive element',
    severity: 'moderate',
    manualReview: false,
    items: (r) => r.aria.ariaExpandedBad.map((f) => ({ summary: `"${truncate(f.text, 60)}" has aria-expanded but no interactive role`, screenshot: f.screenshot })),
  },
  {
    key: 'ariaDuplicateIds',
    section: '6 · ARIA',
    label: '4.1.1 Duplicate IDs',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.aria.duplicateIds.map((id) => ({ summary: `Duplicate id="${id}"` })),
  },
  {
    key: 'brokenLinks',
    section: '7 · Broken links',
    label: 'Broken link',
    severity: 'serious',
    manualReview: false,
    items: (r) =>
      (r.linkResolution?.broken || [])
        .filter((b) => !b.manualReview)
        .map((b) => ({
          summary: `"${truncate(b.text, 50)}" → ${truncate(b.href, 70)} (${b.status !== null ? `HTTP ${b.status}` : b.networkError})`,
          screenshot: b.screenshot,
          origin: b.origin,
          reference: b.reference,
        })),
  },
  {
    key: 'brokenLinksExternalReview',
    section: '7 · Broken links',
    label: 'External link — verify before reporting (SOP §6: automation may be blocked)',
    manualReview: true,
    reviewReason: 'external-blocked',
    items: (r) =>
      (r.linkResolution?.broken || [])
        .filter((b) => b.manualReview)
        .map((b) => ({
          summary: `"${truncate(b.text, 50)}" → ${truncate(b.href, 70)} (${b.status !== null ? `HTTP ${b.status}` : b.networkError}) — confirm in a real browser before calling it broken`,
          screenshot: b.screenshot,
          origin: b.origin,
          reference: b.reference,
        })),
  },
  {
    key: 'brokenImages',
    section: '8 · Broken images',
    label: 'Broken image',
    severity: 'serious',
    manualReview: false,
    items: (r) =>
      (r.imageResolution?.broken || [])
        .filter((b) => !b.manualReview)
        .map((b) => ({
          summary: `"${truncate(b.alt || '(no alt text)', 40)}" → ${truncate(b.href, 70)} (${
            b.status !== null ? `HTTP ${b.status}${b.renderedOk ? '' : ', fails to render'}` : b.networkError
          })`,
          screenshot: b.screenshot,
          origin: b.origin,
          reference: b.reference,
        })),
  },
  {
    key: 'brokenImagesExternalReview',
    section: '8 · Broken images',
    label: 'External image — verify before reporting (SOP §6: automation may be blocked)',
    manualReview: true,
    reviewReason: 'external-blocked',
    items: (r) =>
      (r.imageResolution?.broken || [])
        .filter((b) => b.manualReview)
        .map((b) => ({
          summary: `"${truncate(b.alt || '(no alt text)', 40)}" → ${truncate(b.href, 70)} (${
            b.status !== null ? `HTTP ${b.status}` : b.networkError
          }) — confirm in a real browser before calling it broken`,
          screenshot: b.screenshot,
          origin: b.origin,
          reference: b.reference,
        })),
  },
  {
    key: 'deadClicks',
    section: '9 · Dead clicks',
    label: 'Dead-click candidate (empty/# link with no static sign of JS behavior)',
    manualReview: true,
    reviewReason: 'subjective',
    items: (r) =>
      (r.deadClicks?.dead || []).map((d) => ({
        summary: `"${truncate(d.text, 50)}" has no destination and no visible click-binding attribute — confirm in a real browser before calling it dead`,
        screenshot: d.screenshot,
      })),
  },
  {
    key: 'seoMissingH1',
    section: '10 · SEO metadata',
    label: 'No visible H1',
    severity: 'serious',
    manualReview: false,
    items: (r) => (r.headings.visibleH1Count === 0 ? [{ summary: 'Page has no visible H1 element' }] : []),
  },
  {
    key: 'seoMissingDescription',
    section: '10 · SEO metadata',
    label: 'Missing meta description',
    severity: 'moderate',
    manualReview: false,
    items: (r) => (!r.seo || r.seo.description ? [] : [{ summary: 'Page has no <meta name="description"> tag' }]),
  },
  {
    key: 'seoMissingCanonical',
    section: '10 · SEO metadata',
    label: 'Missing canonical link',
    severity: 'moderate',
    manualReview: false,
    items: (r) => (!r.seo || r.seo.canonical ? [] : [{ summary: 'Page has no <link rel="canonical"> tag' }]),
  },
  {
    key: 'seoMissingOpenGraph',
    section: '10 · SEO metadata',
    label: 'Missing Open Graph tags',
    severity: 'moderate',
    manualReview: false,
    items: (r) => {
      if (!r.seo) return [];
      const missing = [['og:title', r.seo.ogTitle], ['og:description', r.seo.ogDescription], ['og:image', r.seo.ogImage]]
        .filter(([, v]) => !v)
        .map(([k]) => k);
      return missing.length ? [{ summary: `Missing Open Graph tag(s): ${missing.join(', ')}` }] : [];
    },
  },
  {
    key: 'seoMissingTwitterCard',
    section: '10 · SEO metadata',
    label: 'Missing Twitter Card tag',
    severity: 'minor',
    manualReview: false,
    items: (r) => (!r.seo || r.seo.twitterCard ? [] : [{ summary: 'Page has no <meta name="twitter:card"> tag' }]),
  },
  {
    key: 'seoDuplicateTitle',
    section: '10 · SEO metadata',
    label: 'Duplicate page title',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.seo?.duplicateTitleWith?.length
        ? [{ summary: `Title "${truncate(r.headings.pageTitle, 50)}" is identical to ${r.seo.duplicateTitleWith.length} other page(s): ${r.seo.duplicateTitleWith.slice(0, 3).join(', ')}${r.seo.duplicateTitleWith.length > 3 ? ', …' : ''}` }]
        : [],
  },
  {
    key: 'seoDuplicateDescription',
    section: '10 · SEO metadata',
    label: 'Duplicate meta description',
    severity: 'minor',
    manualReview: false,
    items: (r) =>
      r.seo?.duplicateDescriptionWith?.length
        ? [{ summary: `Meta description is identical to ${r.seo.duplicateDescriptionWith.length} other page(s): ${r.seo.duplicateDescriptionWith.slice(0, 3).join(', ')}${r.seo.duplicateDescriptionWith.length > 3 ? ', …' : ''}` }]
        : [],
  },
  {
    key: 'seoNoindexReview',
    section: '10 · SEO metadata',
    label: 'noindex present — confirm intentional for this environment',
    manualReview: true,
    reviewReason: 'environment-dependent',
    items: (r) =>
      r.seo?.robotsMeta && /noindex/i.test(r.seo.robotsMeta)
        ? [{ summary: `<meta name="robots" content="${r.seo.robotsMeta}"> — normal on staging, a problem on production; confirm which this is` }]
        : [],
  },
  {
    key: 'placeholderText',
    section: '11 · Placeholder text',
    label: 'Unreplaced placeholder text',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      (r.placeholderText?.found || []).map((p) => ({
        summary: `${p.tag}: "${truncate(p.text, 60)}" looks like unreplaced placeholder text (${p.pattern})`,
        screenshot: p.screenshot,
      })),
  },
  {
    key: 'consoleErrors',
    section: '12 · Console errors',
    label: 'Console error',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      (r.consoleErrors || []).map((c) => ({
        summary: `[${c.origin}] ${truncate(c.message, 90)}${c.source ? ` (${truncate(c.source, 60)})` : ''}`,
        origin: c.origin === 'external' ? 'external' : 'internal',
        reference: c.source,
      })),
  },
  {
    key: 'infraRobotsTxt',
    section: '13 · Infrastructure',
    label: 'robots.txt concern',
    severity: 'serious',
    manualReview: false,
    items: (r) => (r.infrastructure?.robotsTxt && !r.infrastructure.robotsTxt.manualReview ? [{ summary: r.infrastructure.robotsTxt.summary }] : []),
  },
  {
    key: 'infraRobotsTxtReview',
    section: '13 · Infrastructure',
    label: 'robots.txt — confirm intentional for this environment',
    manualReview: true,
    reviewReason: 'environment-dependent',
    items: (r) => (r.infrastructure?.robotsTxt?.manualReview ? [{ summary: r.infrastructure.robotsTxt.summary }] : []),
  },
  {
    key: 'infraSitemapXml',
    section: '13 · Infrastructure',
    label: 'sitemap.xml concern',
    severity: 'moderate',
    manualReview: false,
    items: (r) => (r.infrastructure?.sitemapXml ? [{ summary: r.infrastructure.sitemapXml.summary }] : []),
  },
  {
    key: 'infraCustom404',
    section: '13 · Infrastructure',
    label: 'Custom 404 concern',
    severity: 'serious',
    manualReview: false,
    items: (r) => (r.infrastructure?.custom404 ? [{ summary: r.infrastructure.custom404.summary }] : []),
  },
  {
    key: 'infraHttps',
    section: '13 · Infrastructure',
    label: 'HTTPS concern',
    severity: 'serious',
    manualReview: false,
    items: (r) => (r.infrastructure?.httpsRedirect && !r.infrastructure.httpsRedirect.manualReview ? [{ summary: r.infrastructure.httpsRedirect.summary }] : []),
  },
  {
    key: 'infraHttpsReview',
    section: '13 · Infrastructure',
    label: 'HTTPS — confirm intentional for this environment',
    manualReview: true,
    reviewReason: 'environment-dependent',
    items: (r) => (r.infrastructure?.httpsRedirect?.manualReview ? [{ summary: r.infrastructure.httpsRedirect.summary }] : []),
  },
];

/**
 * @param {Array} pageResults - the array auditSite() resolves with (one entry per URL).
 * @returns {Array} flat list of { id, page, slug, section, checkKey, checkLabel, severity,
 *   suggestedSeverity, confirmedSeverity, manualReview, reviewReason, verificationStatus,
 *   classification, reproducible, origin, reference, summary, screenshot, fullPageScreenshot,
 *   bucket } — bucket is one of REPORT_BUCKETS, derived from the fields above via
 *   findingBucket() and kept as a plain field so API consumers (the dashboard) can filter
 *   on it without re-implementing the same rule.
 *
 * suggestedSeverity/confirmedSeverity, verificationStatus, and classification encode the
 * SOP's phase-6 triage gate as data rather than prose: every finding a check produces
 * starts as a `'candidate'` with no classification and no confirmedSeverity — "automated
 * output is a candidate list, not a finding list" (SOP §11). Nothing here promotes a
 * finding to `'verified'` or assigns a classification/confirmedSeverity automatically;
 * those are set only by an explicit human action (the Phase 2 dashboard triage workflow
 * this schema exists ahead of, so that workflow never needs a second data migration).
 */
export function extractFindings(pageResults) {
  annotateCrossPageSeoDuplicates(pageResults);
  const findings = [];
  let seq = 0;
  for (const r of pageResults) {
    if (!r || r.error) continue;
    for (const def of CHECK_DEFS) {
      const items = def.items(r) || [];
      for (const item of items) {
        seq += 1;
        const severity = item.severity || def.severity || null;
        const finding = {
          id: `f${seq}`,
          page: r.url,
          slug: r.slug,
          section: def.section,
          checkKey: def.key,
          checkLabel: def.label,
          severity,
          suggestedSeverity: def.manualReview ? null : suggestSopSeverity(severity),
          confirmedSeverity: null,
          manualReview: !!def.manualReview,
          reviewReason: def.manualReview ? def.reviewReason || 'subjective' : null,
          verificationStatus: 'candidate',
          classification: null,
          reproducible: null,
          origin: item.origin || 'internal',
          reference: item.reference || null,
          summary: item.summary,
          screenshot: item.screenshot || null,
          fullPageScreenshot: r.fullPageScreenshot || null,
        };
        finding.bucket = findingBucket(finding);
        findings.push(finding);
      }
    }
  }
  return findings;
}

/** The 7 report buckets SOP §9 requires reporting keep separate, in the order they should read. */
export const REPORT_BUCKETS = [
  'candidatesAwaitingVerification',
  'verifiedDefects',
  'manualReviewItems',
  'externalEnvironmentIssues',
  'clientChangeRequests',
];

/** Display copy for the 5 finding-level buckets, shared by both report renderers and the dashboard API. */
export const BUCKET_META = {
  candidatesAwaitingVerification: {
    title: 'Candidates awaiting verification',
    hint: 'Automated output nobody has triaged yet. SOP §11: "automated output is a candidate list, not a finding list" — treat these as leads to confirm, not confirmed defects.',
  },
  verifiedDefects: {
    title: 'Verified defects',
    hint: 'A human confirmed these as real, launch-relevant issues.',
  },
  manualReviewItems: {
    title: 'Manual-review items',
    hint: 'Needs a human’s judgment on something automation has no ground truth for (decorative image? a real dead click? text over a gradient?).',
  },
  externalEnvironmentIssues: {
    title: 'External / environment issues',
    hint: 'Automation was blocked by a third party, or the same technical fact means something different on staging vs. production and the environment wasn’t confirmed — may not be a real defect.',
  },
  clientChangeRequests: {
    title: 'Client change requests',
    hint: 'A human classified this as an intentional client decision, not a bug.',
  },
};

/**
 * Which of the 5 finding-level SOP report buckets a single finding belongs
 * to. Reads entirely off fields already on the finding — no extra state, so
 * it stays correct automatically once the Phase 2 triage UI starts writing
 * verificationStatus/classification.
 *   - clientChangeRequests: a human classified it as an intentional client
 *     decision, not a bug — checked first so a triaged item never also
 *     shows as a defect or a review item.
 *   - verifiedDefects: a human confirmed it as a real, launch-relevant issue.
 *   - externalEnvironmentIssues: manual-review because automation was
 *     blocked externally or the environment wasn't known/confirmed —
 *     kept apart from subjective manual-review items per the SOP's own list.
 *   - manualReviewItems: manual-review for any other reason (needs a
 *     human's eyes/judgment — decorative image, real dead click, etc).
 *   - candidatesAwaitingVerification: everything else — automated output
 *     nobody has triaged yet ("automated output is a candidate list, not a
 *     finding list", SOP §11).
 */
export function findingBucket(f) {
  if (f.classification === 'change-request') return 'clientChangeRequests';
  if (f.verificationStatus === 'verified' && f.classification === 'defect') return 'verifiedDefects';
  if (f.manualReview && (f.reviewReason === 'external-blocked' || f.reviewReason === 'environment-dependent')) return 'externalEnvironmentIssues';
  if (f.manualReview) return 'manualReviewItems';
  return 'candidatesAwaitingVerification';
}

/**
 * Splits extracted findings into the 5 finding-level buckets the SOP's
 * reporting standards require kept apart (the other 2 — "what passed" and
 * "what was not verified" — aren't properties of a single finding, so
 * buildCoverageReport() computes those from pageResults instead).
 */
export function bucketFindings(findings) {
  const buckets = Object.fromEntries(REPORT_BUCKETS.map((k) => [k, []]));
  for (const f of findings) {
    buckets[f.bucket || findingBucket(f)].push(f);
  }
  return buckets;
}

/**
 * The other 2 of the SOP's 7 reporting buckets: coverage, not findings.
 * "What passed" needs stating explicitly per the SOP's own reporting
 * standards — a check that ran and found nothing is different from a check
 * that never ran, and a client reading only a list of problems can't tell
 * those apart otherwise. "What was not verified" covers pages the audit
 * itself couldn't complete (load failure, timeout) — zero findings there
 * means "untested", not "clean".
 */
export function buildCoverageReport(pageResults) {
  const ok = pageResults.filter((r) => r && !r.error);
  const errored = pageResults.filter((r) => r && r.error);
  const okUrls = ok.map((r) => r.url);

  const passed = [];
  for (const def of CHECK_DEFS) {
    const pagesWithFindings = new Set(ok.filter((r) => (def.items(r) || []).length > 0).map((r) => r.url));
    const passedPages = okUrls.filter((u) => !pagesWithFindings.has(u));
    if (passedPages.length) {
      passed.push({ key: def.key, section: def.section, label: def.label, manualReview: !!def.manualReview, pages: passedPages });
    }
  }

  return {
    passed,
    notVerified: errored.map((r) => ({ url: r.url, reason: r.error })),
  };
}

/** Distinct check-type options for a filter dropdown, in SOW order. */
export function listCheckTypes() {
  return CHECK_DEFS.map((d) => ({ key: d.key, section: d.section, label: d.label, manualReview: !!d.manualReview }));
}

/**
 * Collapses findings that are effectively the same instance repeated across
 * pages — the common case being a shared header/nav/footer element that
 * trips the same check with the same message on every page. Two findings
 * group together when they share a check, severity, and summary text
 * exactly; genuinely page-specific findings (different text, different
 * ratio, different element) just end up in their own group of one.
 *
 * Sorted by pages-affected descending by default, since that's the useful
 * "what's the shared problem worth fixing once" ordering — a caller that
 * wants a different order can re-sort the returned array.
 */
export function groupFindings(findings) {
  const groups = new Map();
  let seq = 0;
  for (const f of findings) {
    const key = `${f.checkKey}::${f.severity ?? 'none'}::${f.summary}`;
    let g = groups.get(key);
    if (!g) {
      seq += 1;
      g = {
        id: `g${seq}`,
        checkKey: f.checkKey,
        checkLabel: f.checkLabel,
        section: f.section,
        severity: f.severity,
        manualReview: f.manualReview,
        summary: f.summary,
        pageSet: new Set(),
        instances: [],
      };
      groups.set(key, g);
    }
    g.instances.push(f);
    g.pageSet.add(f.page);
  }
  return [...groups.values()]
    .map((g) => ({
      id: g.id,
      checkKey: g.checkKey,
      checkLabel: g.checkLabel,
      section: g.section,
      severity: g.severity,
      manualReview: g.manualReview,
      summary: g.summary,
      pageCount: g.pageSet.size,
      instanceCount: g.instances.length,
      pages: [...g.pageSet].sort(),
      instances: g.instances.map((f) => ({
        id: f.id,
        page: f.page,
        screenshot: f.screenshot,
        fullPageScreenshot: f.fullPageScreenshot,
      })),
    }))
    .sort((a, b) => b.pageCount - a.pageCount || b.instanceCount - a.instanceCount);
}

const SEVERITY_BUCKETS = ['critical', 'serious', 'moderate', 'minor', 'manual'];

/**
 * Aggregate counts for the dashboard's breakdown views: by severity
 * (manual-review kept as its own bucket, never folded into a severity),
 * by check type (with distinct pages affected), and by page (automated vs.
 * manual, plus a severity split) — everything the four headline KPIs don't
 * show on their own.
 */
export function summarizeBreakdown(findings) {
  const bySeverity = Object.fromEntries(SEVERITY_BUCKETS.map((k) => [k, 0]));
  const byCheckMap = new Map();
  const byPageMap = new Map();

  for (const f of findings) {
    const severityBucket = f.manualReview ? 'manual' : f.severity || 'moderate';
    bySeverity[severityBucket] = (bySeverity[severityBucket] || 0) + 1;

    if (!byCheckMap.has(f.checkKey)) {
      byCheckMap.set(f.checkKey, {
        checkKey: f.checkKey,
        checkLabel: f.checkLabel,
        section: f.section,
        manualReview: f.manualReview,
        count: 0,
        pages: new Set(),
      });
    }
    const check = byCheckMap.get(f.checkKey);
    check.count += 1;
    check.pages.add(f.page);

    if (!byPageMap.has(f.page)) {
      byPageMap.set(f.page, { page: f.page, automated: 0, manual: 0, critical: 0, serious: 0, moderate: 0, minor: 0 });
    }
    const page = byPageMap.get(f.page);
    if (f.manualReview) {
      page.manual += 1;
    } else {
      page.automated += 1;
      const bucket = f.severity || 'moderate';
      page[bucket] = (page[bucket] || 0) + 1;
    }
  }

  const byCheck = [...byCheckMap.values()]
    .map((c) => ({ ...c, pages: c.pages.size }))
    .sort((a, b) => b.count - a.count);
  const byPage = [...byPageMap.values()].sort((a, b) => b.automated + b.manual - (a.automated + a.manual));

  return { bySeverity, byCheck, byPage };
}
