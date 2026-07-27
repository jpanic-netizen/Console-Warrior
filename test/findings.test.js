import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, listCheckTypes, SEVERITIES } from '../src/report/findings.js';

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
