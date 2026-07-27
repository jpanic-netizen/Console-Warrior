import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, listCheckTypes, groupFindings, summarizeBreakdown, SEVERITIES } from '../src/report/findings.js';
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

test('listCheckTypes covers every SOW section and flags manual-review checks', () => {
  const checks = listCheckTypes();
  assert.ok(checks.length > 15);
  const manualKeys = checks.filter((c) => c.manualReview).map((c) => c.key);
  assert.deepEqual(manualKeys.sort(), ['altReviewEmptyAlt', 'contrastManualReview'].sort());
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
