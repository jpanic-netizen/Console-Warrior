import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../src/report/buildSummary.js';

function makePageResult(overrides = {}) {
  return {
    url: 'https://example.com/',
    error: null,
    axe: { violations: [] },
    contrast: { failures: [], manualReview: [] },
    altText: { totalImages: 0, noAttr: [], filenameAsAlt: [], linkedNoName: [], reviewEmptyAlt: [] },
    headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 1, h1InDomCount: 1, pageTitle: 'Example' },
    aria: { noName: [], labelInName: [], inputNoLabel: [], noAutocomplete: [], ariaExpandedBad: [], duplicateIds: [] },
    keyboard: {
      tabOrder: { invisibleStops: [] },
      dropdowns: { results: [], failingCount: 0 },
      focusableHidden: { focusableButHidden: [] },
    },
    focusState: { noIndicator: [], weakIndicator: [] },
    ...overrides,
  };
}

test('headingMissingTitle and headingMultipleH1 totals count affected pages, not stay stuck at 0', () => {
  const pages = [
    makePageResult({ url: 'https://example.com/a', headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 1, h1InDomCount: 1, pageTitle: '' } }),
    makePageResult({ url: 'https://example.com/b', headings: { visibleHeadings: [], skips: [], emptyHeadingsCount: 0, visibleH1Count: 2, h1InDomCount: 2, pageTitle: 'Has one' } }),
    makePageResult({ url: 'https://example.com/c' }), // clean page: has a title, one H1
  ];
  const summary = buildSummary(pages);

  assert.equal(summary.totals.headingMissingTitle, 1);
  assert.equal(summary.totals.headingMultipleH1, 1);
  assert.deepEqual(summary.perCheckPages.headingMissingTitle, ['https://example.com/a']);
  assert.deepEqual(summary.perCheckPages.headingMultipleH1, ['https://example.com/b']);

  // The scorecard total (what reports print as "Total flagged findings") must
  // actually include these two checks, not silently omit them.
  const grandTotal = Object.values(summary.totals).reduce((a, b) => a + b, 0);
  assert.ok(grandTotal >= 2);
});

test('buildSummary excludes errored pages from pagesAudited and totals', () => {
  const summary = buildSummary([
    makePageResult(),
    { url: 'https://example.com/broken', error: 'timeout' },
  ]);
  assert.equal(summary.pagesAudited, 1);
  assert.equal(summary.pagesErrored, 1);
  assert.deepEqual(summary.erroredUrls, ['https://example.com/broken']);
});

test('manual-review items never appear in totals', () => {
  const summary = buildSummary([
    makePageResult({
      contrast: { failures: [], manualReview: [{ id: 'm1' }] },
      altText: { totalImages: 1, noAttr: [], filenameAsAlt: [], linkedNoName: [], reviewEmptyAlt: [{ id: 'a1' }] },
    }),
  ]);
  assert.equal(summary.manualReviewCount, 2);
  assert.equal(Object.values(summary.totals).reduce((a, b) => a + b, 0), 0);
});
