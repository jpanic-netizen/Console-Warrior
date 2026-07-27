import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, listCheckTypes, groupFindings, summarizeBreakdown, SEVERITIES, SOP_SEVERITIES, suggestSopSeverity } from '../src/report/findings.js';
import { sortFindings, searchFindings, defaultSortDir } from '../src/report/sortSearch.js';

/** Minimal but structurally complete synthetic page result, matching what auditPage() produces. */
function makePageResult(overrides = {}) {
  return {
    url: 'https://example.com/',
    slug: 'home',
    fullPageScreenshot: '/out/screenshots/home__full-page.png',
    pageErrors: [],
    axe: { violations: [] },
    contrast: { failures: [], manualReview: [] },
    altText: { totalImages: 0, noAttr: [], filenameAsAlt: [], linkedNoName: [], reviewEmptyAlt: [] },
    headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 1, h1InDomCount: 1, pageTitle: 'Example' },
    aria: {
      interactiveChecked: 0,
      noName: [],
      labelInName: [],
      inputNoLabel: [],
      noAutocomplete: [],
      ariaExpandedBad: [],
      duplicateIds: [],
      rolesInUse: [],
      mainLandmarkCount: 1,
      htmlLang: 'en',
    },
    keyboard: {
      tabOrder: { order: [], invisibleStops: [], expectedFocusableCount: 0, tabPressesRun: 0 },
      dropdowns: { results: [], failingCount: 0 },
      focusableHidden: { focusableButHidden: [], positiveTabindexCount: 0 },
    },
    focusState: { checkedCount: 0, noIndicator: [], weakIndicator: [] },
    ...overrides,
  };
}

test('extractFindings returns nothing for a clean page', () => {
  const findings = extractFindings([makePageResult()]);
  assert.deepEqual(findings, []);
});

test('extractFindings skips pages that errored', () => {
  const findings = extractFindings([{ url: 'https://example.com/broken', error: 'timeout' }]);
  assert.deepEqual(findings, []);
});

test('extractFindings flags contrast failures as serious, automated', () => {
  const page = makePageResult({
    contrast: {
      failures: [{ id: 'c1', text: 'Low contrast', ratio: 2.1, needed: 4.5, fg: 'rgb(1,1,1)', bg: 'rgb(2,2,2)', screenshot: '/out/c1.png' }],
      manualReview: [],
    },
  });
  const findings = extractFindings([page]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].checkKey, 'contrastFailures');
  assert.equal(findings[0].severity, 'serious');
  assert.equal(findings[0].manualReview, false);
  assert.equal(findings[0].screenshot, '/out/c1.png');
  assert.match(findings[0].summary, /Low contrast/);
});

test('extractFindings keeps manual-review items out of severity buckets', () => {
  const page = makePageResult({
    contrast: { failures: [], manualReview: [{ id: 'm1', text: 'Over gradient', reason: 'needs a human eye' }] },
    altText: { totalImages: 1, noAttr: [], filenameAsAlt: [], linkedNoName: [], reviewEmptyAlt: [{ id: 'a1', file: 'hero.png', widthPx: 40, nearestHeading: 'Welcome', inLink: false }] },
  });
  const findings = extractFindings([page]);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.manualReview === true));
  assert.ok(findings.every((f) => f.severity === null));
  assert.ok(findings.every((f) => f.suggestedSeverity === null), 'manual-review items get no automated severity suggestion at all');
});

// ---------- SOP severity mapping + candidate/triage fields ----------

test('suggestSopSeverity caps critical and serious at "High" — never "Blocker", which requires human judgement of launch/journey impact', () => {
  assert.equal(suggestSopSeverity('critical'), 'High');
  assert.equal(suggestSopSeverity('serious'), 'High');
  assert.equal(suggestSopSeverity('moderate'), 'Medium');
  assert.equal(suggestSopSeverity('minor'), 'Low');
  assert.equal(suggestSopSeverity(null), null);
  for (const internal of SEVERITIES) {
    assert.notEqual(suggestSopSeverity(internal), 'Blocker', `${internal} must never auto-suggest Blocker`);
  }
  assert.ok(SOP_SEVERITIES.includes('Blocker'), 'Blocker is still a valid confirmedSeverity value — just never an automated suggestion');
});

test('extractFindings: every finding starts life as an untriaged candidate with a suggested-vs-confirmed severity split', () => {
  const page = makePageResult({
    contrast: { failures: [{ id: 'c1', text: 'Low contrast', ratio: 2.1, needed: 4.5, screenshot: null }], manualReview: [] },
  });
  const findings = extractFindings([page]);
  const f = findings[0];
  assert.equal(f.severity, 'serious'); // internal vocabulary, unchanged
  assert.equal(f.suggestedSeverity, 'High'); // SOP-mapped, capped
  assert.equal(f.confirmedSeverity, null); // only a human sets this, later
  assert.equal(f.verificationStatus, 'candidate');
  assert.equal(f.classification, null);
  assert.equal(f.reproducible, null);
  assert.equal(f.origin, 'internal');
  assert.equal(f.reference, null);
});


test('extractFindings takes axe severity from axe\'s own impact field, not a fixed default', () => {
  const page = makePageResult({
    axe: {
      violations: [
        { rule: 'color-contrast', impact: 'serious', help: 'x', nodesCount: 3, nodes: [] },
        { rule: 'button-name', impact: 'critical', help: 'y', nodesCount: 1, nodes: [] },
        { rule: 'made-up-rule', impact: 'not-a-real-impact', help: 'z', nodesCount: 1, nodes: [] },
      ],
    },
  });
  const findings = extractFindings([page]);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].severity, 'serious');
  assert.equal(findings[1].severity, 'critical');
  // an unrecognized impact value still gets a valid severity, not garbage passed through
  assert.ok(SEVERITIES.includes(findings[2].severity));
});

test('extractFindings applies the same dropdown pass/fail rule as the report renderer', () => {
  const page = makePageResult({
    keyboard: {
      tabOrder: { order: [], invisibleStops: [], expectedFocusableCount: 0, tabPressesRun: 0 },
      dropdowns: {
        results: [
          { toggle: 'Good menu', role: 'button', opensWithEnter: true, closesWithEscape: true, opensWithSpace: true },
          { toggle: 'Broken menu', role: 'button', opensWithEnter: false, closesWithEscape: true, opensWithSpace: true },
        ],
        failingCount: 1,
      },
      focusableHidden: { focusableButHidden: [], positiveTabindexCount: 0 },
    },
  });
  const findings = extractFindings([page]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /Broken menu/);
  assert.equal(findings[0].severity, 'critical');
});

test('extractFindings reports page-level heading conditions only when they hold', () => {
  const missingTitle = extractFindings([makePageResult({ headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 1, h1InDomCount: 1, pageTitle: '' } })]);
  assert.equal(missingTitle.filter((f) => f.checkKey === 'headingMissingTitle').length, 1);

  const hasTitle = extractFindings([makePageResult()]);
  assert.equal(hasTitle.filter((f) => f.checkKey === 'headingMissingTitle').length, 0);

  const multipleH1 = extractFindings([makePageResult({ headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 2, h1InDomCount: 2, pageTitle: 'x' } })]);
  assert.equal(multipleH1.filter((f) => f.checkKey === 'headingMultipleH1').length, 1);
});

test('extractFindings assigns unique, stable ids across pages', () => {
  const pages = [
    makePageResult({ url: 'https://example.com/a', contrast: { failures: [{ id: 'x', text: 'a', ratio: 1, needed: 4.5 }], manualReview: [] } }),
    makePageResult({ url: 'https://example.com/b', contrast: { failures: [{ id: 'y', text: 'b', ratio: 1, needed: 4.5 }], manualReview: [] } }),
  ];
  const findings = extractFindings(pages);
  assert.equal(findings.length, 2);
  assert.notEqual(findings[0].id, findings[1].id);
  assert.equal(findings[0].page, 'https://example.com/a');
  assert.equal(findings[1].page, 'https://example.com/b');
});

// ---------- SEO metadata checks ----------

function seoPage(overrides = {}) {
  return makePageResult({
    headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 1, h1InDomCount: 1, pageTitle: 'A Real Title' },
    seo: { description: 'A real description', canonical: 'https://example.com/', ogTitle: 'x', ogDescription: 'x', ogImage: 'x', twitterCard: 'summary', robotsMeta: null, ...overrides },
  });
}

test('SEO checks: a fully-populated, clean page produces no SEO findings at all', () => {
  const findings = extractFindings([seoPage()]);
  assert.equal(findings.filter((f) => f.section === '10 · SEO metadata').length, 0);
});

test('SEO checks: a page result with no seo field at all (check never ran) is silently skipped, not treated as "everything missing"', () => {
  const findings = extractFindings([makePageResult()]); // no `seo` key
  assert.equal(findings.filter((f) => f.checkKey.startsWith('seo')).length, 0);
});

test('SEO checks: missing description/canonical/Twitter Card/H1 are each reported once, with the right severity', () => {
  const page = makePageResult({
    headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 0, h1InDomCount: 0, pageTitle: 'x' },
    seo: { description: null, canonical: null, ogTitle: 'x', ogDescription: 'x', ogImage: 'x', twitterCard: null, robotsMeta: null },
  });
  const findings = extractFindings([page]);
  const byKey = Object.fromEntries(findings.map((f) => [f.checkKey, f]));
  assert.equal(byKey.seoMissingH1.severity, 'serious');
  assert.equal(byKey.seoMissingDescription.severity, 'moderate');
  assert.equal(byKey.seoMissingCanonical.severity, 'moderate');
  assert.equal(byKey.seoMissingTwitterCard.severity, 'minor');
  assert.equal(byKey.seoMissingOpenGraph, undefined, 'all three OG tags were present, so this must not fire');
});

test('SEO checks: missing Open Graph tags are named individually in the summary', () => {
  const page = makePageResult({ seo: { description: 'd', canonical: 'c', ogTitle: null, ogDescription: null, ogImage: 'set', twitterCard: 't', robotsMeta: null } });
  const findings = extractFindings([page]);
  const og = findings.find((f) => f.checkKey === 'seoMissingOpenGraph');
  assert.ok(og);
  assert.match(og.summary, /og:title/);
  assert.match(og.summary, /og:description/);
  assert.ok(!og.summary.includes('og:image'), 'og:image was present and must not be listed as missing');
});

test('SEO checks: noindex is always a manual-review candidate, never an automated pass/fail, since that depends on staging vs production', () => {
  const page = makePageResult({ seo: { description: 'd', canonical: 'c', ogTitle: 'x', ogDescription: 'x', ogImage: 'x', twitterCard: 't', robotsMeta: 'noindex, nofollow' } });
  const findings = extractFindings([page]);
  const noindex = findings.find((f) => f.checkKey === 'seoNoindexReview');
  assert.ok(noindex);
  assert.equal(noindex.manualReview, true);
  assert.equal(noindex.severity, null);
});

test('SEO checks: duplicate titles/descriptions across pages are detected end-to-end through extractFindings', () => {
  const pages = [
    seoPage({ description: 'Same description' }),
    makePageResult({
      url: 'https://example.com/b',
      headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 1, h1InDomCount: 1, pageTitle: 'A Real Title' },
      seo: { description: 'Same description', canonical: 'https://example.com/b', ogTitle: 'x', ogDescription: 'x', ogImage: 'x', twitterCard: 'summary', robotsMeta: null },
    }),
  ];
  const findings = extractFindings(pages);
  const dupTitle = findings.filter((f) => f.checkKey === 'seoDuplicateTitle');
  const dupDesc = findings.filter((f) => f.checkKey === 'seoDuplicateDescription');
  assert.equal(dupTitle.length, 2, 'both pages share the exact same title');
  assert.equal(dupDesc.length, 2, 'both pages share the exact same description');
});

// ---------- Console errors ----------

test('consoleErrors check surfaces each classified error, labels first-party vs third-party in the summary, and carries origin/reference', () => {
  const page = makePageResult({
    consoleErrors: [
      { message: 'Internal bug', source: 'https://example.com/app.js', kind: 'uncaught', origin: 'internal' },
      { message: 'Widget crashed', source: 'https://widget.example.net/embed.js', kind: 'console.error', origin: 'external' },
    ],
  });
  const findings = extractFindings([page]);
  const consoleFindings = findings.filter((f) => f.checkKey === 'consoleErrors');
  assert.equal(consoleFindings.length, 2);
  assert.match(consoleFindings[0].summary, /^\[internal\] Internal bug/);
  assert.equal(consoleFindings[0].origin, 'internal');
  assert.match(consoleFindings[1].summary, /^\[external\] Widget crashed/);
  assert.equal(consoleFindings[1].origin, 'external');
  assert.equal(consoleFindings[1].reference, 'https://widget.example.net/embed.js');
});

test('consoleErrors check produces nothing when the page result has no consoleErrors field at all', () => {
  const findings = extractFindings([makePageResult()]);
  assert.equal(findings.filter((f) => f.checkKey === 'consoleErrors').length, 0);
});

// ---------- Infrastructure (site-level) ----------

test('infrastructure checks read from r.infrastructure (attached to one page result, not repeated per page) and split automated vs manual-review correctly', () => {
  const page = makePageResult({
    infrastructure: {
      robotsTxt: { manualReview: false, summary: 'robots.txt blocks production' },
      sitemapXml: { manualReview: false, summary: 'sitemap missing' },
      custom404: { manualReview: false, summary: 'soft-404' },
      httpsRedirect: { manualReview: true, summary: 'confirm HTTPS intent' },
    },
  });
  const findings = extractFindings([page]);
  const byKey = Object.fromEntries(findings.map((f) => [f.checkKey, f]));
  assert.ok(byKey.infraRobotsTxt);
  assert.equal(byKey.infraRobotsTxt.manualReview, false);
  assert.ok(byKey.infraSitemapXml);
  assert.ok(byKey.infraCustom404);
  assert.ok(byKey.infraHttpsReview);
  assert.equal(byKey.infraHttpsReview.manualReview, true);
  assert.equal(byKey.infraHttps, undefined, 'the manual-review variant fired, so the automated one must not');
  assert.equal(byKey.infraRobotsTxtReview, undefined, 'the automated variant fired, so the manual-review one must not');
});

test('infrastructure checks produce nothing when r.infrastructure is entirely absent (most pages, since it only attaches to one)', () => {
  const findings = extractFindings([makePageResult(), makePageResult({ url: 'https://example.com/b' })]);
  assert.equal(findings.filter((f) => f.checkKey.startsWith('infra')).length, 0);
});

test('listCheckTypes covers every SOW section and flags manual-review checks', () => {
  const checks = listCheckTypes();
  assert.ok(checks.length > 15);
  const manualKeys = checks.filter((c) => c.manualReview).map((c) => c.key);
  assert.deepEqual(manualKeys.sort(), ['altReviewEmptyAlt', 'brokenLinksExternalReview', 'brokenImagesExternalReview', 'contrastManualReview', 'deadClicks', 'seoNoindexReview', 'infraRobotsTxtReview', 'infraHttpsReview'].sort());
});

// ---------- groupFindings ----------

test('groupFindings collapses a shared-footer finding repeated across every page into one group', () => {
  const pages = ['https://example.com/', 'https://example.com/about', 'https://example.com/contact'].map((url) =>
    makePageResult({
      url,
      aria: {
        noName: [],
        labelInName: [],
        inputNoLabel: [],
        noAutocomplete: [],
        ariaExpandedBad: [],
        duplicateIds: ['footer-social-link'],
      },
    })
  );
  const findings = extractFindings(pages);
  assert.equal(findings.length, 3); // one per page, before grouping

  const groups = groupFindings(findings);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pageCount, 3);
  assert.equal(groups[0].instanceCount, 3);
  assert.deepEqual(groups[0].pages.slice().sort(), pages.map((p) => p.url).sort());
});

test('groupFindings keeps genuinely different findings in separate groups', () => {
  const pages = [
    makePageResult({ url: 'https://example.com/a', contrast: { failures: [{ id: 'x', text: 'Low contrast A', ratio: 2, needed: 4.5 }], manualReview: [] } }),
    makePageResult({ url: 'https://example.com/b', contrast: { failures: [{ id: 'y', text: 'Low contrast B', ratio: 3, needed: 4.5 }], manualReview: [] } }),
  ];
  const groups = groupFindings(extractFindings(pages));
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.pageCount === 1));
});

test('groupFindings sorts by pages-affected first, so shared-component issues surface at the top', () => {
  const sharedPages = ['https://example.com/', 'https://example.com/a', 'https://example.com/b'].map((url) =>
    makePageResult({ url, aria: { noName: [], labelInName: [], inputNoLabel: [], noAutocomplete: [], ariaExpandedBad: [], duplicateIds: ['shared-id'] } })
  );
  const uniquePage = makePageResult({
    url: 'https://example.com/unique',
    contrast: { failures: [{ id: 'u', text: 'One-off issue', ratio: 2, needed: 4.5 }], manualReview: [] },
  });
  const groups = groupFindings(extractFindings([...sharedPages, uniquePage]));
  assert.equal(groups[0].pageCount, 3);
  assert.equal(groups[groups.length - 1].pageCount, 1);
});

test('groupFindings never merges across different checks or severities even with identical summary text', () => {
  // Contrived but real risk: grouping only on summary text would wrongly merge unrelated checks.
  const page = makePageResult({
    aria: { noName: [{ id: 'n1', tag: 'BUTTON', html: '<button>x</button>' }], labelInName: [], inputNoLabel: [], noAutocomplete: [], ariaExpandedBad: [], duplicateIds: [] },
  });
  const findings = extractFindings([page]);
  const relabelled = findings.map((f) => ({ ...f, summary: 'same text', checkKey: f.checkKey === 'ariaNoName' ? 'a' : 'b' }));
  const groups = groupFindings(relabelled);
  assert.equal(groups.length, new Set(relabelled.map((f) => f.checkKey)).size);
});

test('groupFindings is presentation-only: every raw finding is still reachable through some group, with its own evidence intact', () => {
  // Guards the exact property the dashboard's grouped/raw toggle relies on —
  // collapsing repeated findings must never drop a finding or its
  // screenshot, only change how many cards render for the same data.
  const pages = ['https://example.com/', 'https://example.com/about', 'https://example.com/contact', 'https://example.com/pricing'].map((url, i) =>
    makePageResult({
      url,
      aria: { noName: [], labelInName: [], inputNoLabel: [], noAutocomplete: [], ariaExpandedBad: [], duplicateIds: ['shared-footer-id'] },
      contrast: {
        failures: [{ id: `c${i}`, text: `Distinct contrast issue ${i}`, ratio: 2, needed: 4.5, screenshot: `/out/c${i}.png` }],
        manualReview: [],
      },
    })
  );
  const findings = extractFindings(pages);
  const groups = groupFindings(findings);

  const totalFromGroups = groups.reduce((sum, g) => sum + g.instanceCount, 0);
  assert.equal(totalFromGroups, findings.length, 'sum of every group.instanceCount must equal the raw finding count');

  const instancesFromGroups = groups.flatMap((g) => g.instances);
  assert.equal(instancesFromGroups.length, findings.length, 'every group.instances array together must total the raw finding count');

  const rawIds = new Set(findings.map((f) => f.id));
  const groupedIds = new Set(instancesFromGroups.map((i) => i.id));
  assert.deepEqual(groupedIds, rawIds, 'grouping must not drop or duplicate any raw finding id');

  const rawScreenshots = new Set(findings.map((f) => f.screenshot).filter(Boolean));
  const groupedScreenshots = new Set(instancesFromGroups.map((i) => i.screenshot).filter(Boolean));
  assert.deepEqual(groupedScreenshots, rawScreenshots, 'grouping must not drop any finding\'s screenshot evidence');
});

// ---------- summarizeBreakdown ----------

test('summarizeBreakdown tallies severity, check, and page dimensions independently', () => {
  const pages = [
    makePageResult({
      url: 'https://example.com/a',
      contrast: { failures: [{ id: 'c1', text: 'x', ratio: 2, needed: 4.5 }], manualReview: [{ id: 'm1', text: 'y', reason: 'gradient' }] },
    }),
    makePageResult({
      url: 'https://example.com/b',
      keyboard: {
        tabOrder: { order: [], invisibleStops: [{ stop: 1, tag: 'A', name: 'x', y: 0 }], expectedFocusableCount: 1, tabPressesRun: 1 },
        dropdowns: { results: [], failingCount: 0 },
        focusableHidden: { focusableButHidden: [], positiveTabindexCount: 0 },
      },
    }),
  ];
  const findings = extractFindings(pages);
  const breakdown = summarizeBreakdown(findings);

  assert.equal(breakdown.bySeverity.serious, 1); // the contrast failure
  assert.equal(breakdown.bySeverity.critical, 1); // the invisible tab stop
  assert.equal(breakdown.bySeverity.manual, 1); // never folded into a severity bucket

  const contrastCheck = breakdown.byCheck.find((c) => c.checkKey === 'contrastFailures');
  assert.equal(contrastCheck.count, 1);
  assert.equal(contrastCheck.pages, 1);

  const pageA = breakdown.byPage.find((p) => p.page === 'https://example.com/a');
  assert.equal(pageA.automated, 1);
  assert.equal(pageA.manual, 1);
  const pageB = breakdown.byPage.find((p) => p.page === 'https://example.com/b');
  assert.equal(pageB.automated, 1);
  assert.equal(pageB.critical, 1);
});

// ---------- sortSearch ----------

test('sortFindings orders critical before serious before moderate before minor before manual', () => {
  const items = [
    { checkKey: 'ariaNoAutocomplete', severity: 'minor', manualReview: false, summary: 'd' },
    { checkKey: 'contrastManualReview', severity: null, manualReview: true, summary: 'e' },
    { checkKey: 'contrastFailures', severity: 'serious', manualReview: false, summary: 'b' },
    { checkKey: 'keyboardInvisibleFocus', severity: 'critical', manualReview: false, summary: 'a' },
    { checkKey: 'focusWeakIndicator', severity: 'moderate', manualReview: false, summary: 'c' },
  ];
  const sorted = sortFindings(items, 'severity', 'asc');
  assert.deepEqual(sorted.map((f) => f.summary), ['a', 'b', 'c', 'd', 'e']);
});

test('sortFindings by page/check is stable and defaultSortDir picks sensible directions', () => {
  assert.equal(defaultSortDir('severity'), 'asc');
  assert.equal(defaultSortDir('pageCount'), 'desc');
  assert.equal(defaultSortDir('instanceCount'), 'desc');

  const items = [
    { page: 'https://example.com/b', checkKey: 'contrastFailures', summary: '1' },
    { page: 'https://example.com/a', checkKey: 'contrastFailures', summary: '2' },
  ];
  const sorted = sortFindings(items, 'page', 'asc');
  assert.deepEqual(sorted.map((f) => f.page), ['https://example.com/a', 'https://example.com/b']);
});

test('searchFindings matches summary, check label, and page case-insensitively', () => {
  const items = [
    { summary: 'Low contrast on "Get Started"', checkLabel: 'Contrast failure', page: 'https://example.com/pricing' },
    { summary: 'Missing autocomplete', checkLabel: 'ARIA — 1.3.5 missing autocomplete', page: 'https://example.com/contact' },
  ];
  assert.equal(searchFindings(items, 'get started').length, 1);
  assert.equal(searchFindings(items, 'PRICING').length, 1);
  assert.equal(searchFindings(items, 'autocomplete').length, 1);
  assert.equal(searchFindings(items, '').length, 2);
  assert.equal(searchFindings(items, 'nonexistent').length, 0);
});
