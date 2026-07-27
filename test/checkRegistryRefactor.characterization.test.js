import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../src/report/buildSummary.js';
import { extractFindings, listCheckTypes } from '../src/report/findings.js';

/**
 * Locks in today's exact behavior of buildSummary()/extractFindings()/
 * listCheckTypes() BEFORE the check-definition registry consolidation, so
 * the refactor (buildSummary deriving totals from the same CHECK_DEFS
 * extractFindings already uses, instead of hand-listing every field twice)
 * can be verified against this file without editing it — except the one
 * documented exception below.
 *
 * Known, disclosed, intentional exception: buildSummary.js's totals/
 * perCheckPages object is hand-typed today with 'axeViolations' LAST, while
 * findings.js's CHECK_DEFS (which drives extractFindings' finding-id
 * sequence and listCheckTypes' dropdown order) has always had it FIRST.
 * These two pre-existing orders already disagreed before this refactor.
 * True single-source-of-truth requires picking one; we keep CHECK_DEFS'
 * order (the one that actually drives finding ids/dashboard filtering) and
 * let buildSummary's object-key order follow it — a purely cosmetic change
 * to which row prints first in the HTML/DOCX executive-summary table, with
 * zero effect on any count, id, screenshot, or classification. The
 * 'documents pre-refactor totals key order' test below is the one test in
 * this file expected to change, and only in its expected-order array.
 */

function comprehensivePageResult(url, n) {
  // n is a per-page multiplier so multi-page fixtures produce distinct,
  // individually-attributable counts per check instead of every page
  // looking identical.
  return {
    url,
    error: null,
    axe: { violations: Array.from({ length: n }, (_, i) => ({ rule: `axe-rule-${i}`, impact: 'serious', help: 'help text', nodesCount: 1 })) },
    contrast: {
      failures: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `Low contrast ${i}`, ratio: 2, needed: 4.5, screenshot: `/out/c${url}${i}.png` })),
      manualReview: Array.from({ length: n }, (_, i) => ({ id: `cm${i}`, text: `Gradient text ${i}`, reason: 'over gradient', screenshot: null })),
    },
    altText: {
      totalImages: n * 4,
      noAttr: Array.from({ length: n }, (_, i) => ({ src: `img-noattr-${i}.png`, screenshot: null })),
      filenameAsAlt: Array.from({ length: n }, (_, i) => ({ alt: `photo-${i}.jpg`, screenshot: null })),
      linkedNoName: Array.from({ length: n }, (_, i) => ({ src: `linked-${i}.png`, screenshot: null })),
      reviewEmptyAlt: Array.from({ length: n }, (_, i) => ({ file: `decorative-${i}.png`, widthPx: 40, nearestHeading: 'Section', inLink: false, screenshot: null })),
    },
    headings: {
      visibleHeadings: [{ level: 1, text: 'Title' }],
      skips: n > 0 ? Array.from({ length: n }, (_, i) => `h2 -> h4 near "Section ${i}"`) : [],
      emptyHeadingsCount: 0,
      visibleH1Count: n > 0 ? 2 : 1,
      h1InDomCount: n > 0 ? 2 : 1,
      pageTitle: n > 0 ? '' : 'A Real Title',
    },
    aria: {
      noName: Array.from({ length: n }, (_, i) => ({ tag: 'BUTTON', html: `<button>${i}</button>`, screenshot: null })),
      labelInName: Array.from({ length: n }, (_, i) => ({ visible: `Click ${i}`, ariaLabel: 'Something else', screenshot: null })),
      inputNoLabel: Array.from({ length: n }, (_, i) => ({ type: 'text', fieldId: `f${i}`, name: '', placeholder: '', screenshot: null })),
      noAutocomplete: Array.from({ length: n }, (_, i) => ({ field: `field-${i}`, type: 'email' })),
      ariaExpandedBad: Array.from({ length: n }, (_, i) => ({ text: `toggle ${i}`, screenshot: null })),
      duplicateIds: n > 0 ? Array.from({ length: n }, (_, i) => `dup-id-${i}`) : [],
    },
    keyboard: {
      tabOrder: {
        invisibleStops: Array.from({ length: n }, (_, i) => ({ stop: i + 1, tag: 'A', name: `Item ${i}`, y: i * 10 })),
        expectedFocusableCount: 10,
        tabPressesRun: 10,
        order: [],
      },
      dropdowns: {
        // failingCount is kept consistent with what a live filter of
        // `results` would produce, since that's what findings.js's item
        // extractor actually derives from — real check output always keeps
        // these in sync (both come from the same auditDropdownOperability
        // call), so this fixture matches that invariant deliberately.
        results: Array.from({ length: n }, (_, i) => ({ toggle: `Toggle ${i}`, role: 'button', opensWithEnter: false, closesWithEscape: true, opensWithSpace: false })),
        failingCount: n,
      },
      focusableHidden: {
        focusableButHidden: Array.from({ length: n }, (_, i) => ({ tag: 'A', text: `Ghost ${i}`, href: '#x', screenshot: null })),
        positiveTabindexCount: 0,
      },
    },
    focusState: {
      noIndicator: Array.from({ length: n }, (_, i) => ({ tag: 'BUTTON', element: `No ring ${i}`, screenshot: null })),
      weakIndicator: Array.from({ length: n }, (_, i) => ({ tag: 'BUTTON', element: `Weak ${i}`, indicator: 'background', screenshot: null })),
    },
  };
}

const FIXTURE = [comprehensivePageResult('https://example.com/a', 2), comprehensivePageResult('https://example.com/b', 1), comprehensivePageResult('https://example.com/clean', 0)];

test('totals key order now follows CHECK_DEFS (post-refactor) — axeViolations first, matching finding ids and listCheckTypes, not the old hand-typed order that had it last', () => {
  const summary = buildSummary(FIXTURE);
  assert.deepEqual(Object.keys(summary.totals), [
    'axeViolations',
    'contrastFailures',
    'keyboardInvisibleFocus',
    'dropdownFailures',
    'focusableButHidden',
    'focusNoIndicator',
    'focusWeakIndicator',
    'altMissingAttr',
    'altFilenameAsAlt',
    'altLinkedNoName',
    'headingSkips',
    'headingMissingTitle',
    'headingMultipleH1',
    'ariaNoName',
    'ariaLabelInName',
    'ariaInputNoLabel',
    'ariaNoAutocomplete',
    'ariaExpandedBad',
    'ariaDuplicateIds',
    'brokenLinks',
    'brokenImages',
  ]);
});

test('buildSummary totals: exact per-check counts across a multi-page fixture', () => {
  const summary = buildSummary(FIXTURE);
  // page a: n=2, page b: n=1, page clean: n=0 => totals of 3 for most checks
  assert.equal(summary.totals.axeViolations, 3);
  assert.equal(summary.totals.contrastFailures, 3);
  assert.equal(summary.totals.keyboardInvisibleFocus, 3);
  assert.equal(summary.totals.dropdownFailures, 3);
  assert.equal(summary.totals.focusableButHidden, 3);
  assert.equal(summary.totals.focusNoIndicator, 3);
  assert.equal(summary.totals.focusWeakIndicator, 3);
  assert.equal(summary.totals.altMissingAttr, 3);
  assert.equal(summary.totals.altFilenameAsAlt, 3);
  assert.equal(summary.totals.altLinkedNoName, 3);
  assert.equal(summary.totals.headingSkips, 3);
  assert.equal(summary.totals.headingMissingTitle, 2); // pages a & b have blank titles
  assert.equal(summary.totals.headingMultipleH1, 2); // pages a & b have visibleH1Count 2
  assert.equal(summary.totals.ariaNoName, 3);
  assert.equal(summary.totals.ariaLabelInName, 3);
  assert.equal(summary.totals.ariaInputNoLabel, 3);
  assert.equal(summary.totals.ariaNoAutocomplete, 3);
  assert.equal(summary.totals.ariaExpandedBad, 3);
  assert.equal(summary.totals.ariaDuplicateIds, 3);
  // Manual-review keys must never appear in totals at all.
  assert.equal('contrastManualReview' in summary.totals, false);
  assert.equal('altReviewEmptyAlt' in summary.totals, false);
});

test('buildSummary perCheckPages: exact affected-page lists, in page-iteration order', () => {
  const summary = buildSummary(FIXTURE);
  assert.deepEqual(summary.perCheckPages.contrastFailures, ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(summary.perCheckPages.headingMissingTitle, ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(summary.perCheckPages.axeViolations, ['https://example.com/a', 'https://example.com/b']);
  // The clean page (n=0) must not appear anywhere.
  for (const key of Object.keys(summary.perCheckPages)) {
    assert.ok(!summary.perCheckPages[key].includes('https://example.com/clean'), `clean page leaked into ${key}`);
  }
});

test('buildSummary manualReviewCount: sums contrastManualReview + altReviewEmptyAlt only', () => {
  const summary = buildSummary(FIXTURE);
  // page a: 2+2=4, page b: 1+1=2, clean: 0 => 6
  assert.equal(summary.manualReviewCount, 6);
});

test('extractFindings: exact finding count, sequential ids, and CHECK_DEFS-driven order per page', () => {
  const findings = extractFindings(FIXTURE);
  // 17 checks scale with n; headingMissingTitle/headingMultipleH1 are
  // boolean-style checks that produce exactly 0 or 1 regardless of n;
  // contrastManualReview/altReviewEmptyAlt (manual) scale with n.
  // page a (n=2): 17*2 + 1 + 1 automated (36) + 2*2 manual (4) = 40
  // page b (n=1): 17*1 + 1 + 1 automated (19) + 2*1 manual (2) = 21
  // page clean (n=0): 0
  assert.equal(findings.length, 61);
  assert.equal(findings[0].id, 'f1');
  assert.equal(findings[findings.length - 1].id, `f${findings.length}`);

  // First check in CHECK_DEFS order is axeViolations — the very first
  // finding on the very first page must be an axe finding.
  assert.equal(findings[0].checkKey, 'axeViolations');
  assert.equal(findings[0].page, 'https://example.com/a');

  // Screenshots and manualReview classification survive verbatim.
  const contrastFinding = findings.find((f) => f.checkKey === 'contrastFailures' && f.page === 'https://example.com/a');
  assert.equal(contrastFinding.screenshot, '/out/chttps://example.com/a0.png');
  assert.equal(contrastFinding.manualReview, false);
  const manualFinding = findings.find((f) => f.checkKey === 'contrastManualReview');
  assert.equal(manualFinding.manualReview, true);
});

test('listCheckTypes: set, order, and manualReview flags (grows as Phase 1 checks are added — this is the running record, not a frozen snapshot)', () => {
  const types = listCheckTypes();
  assert.deepEqual(
    types.map((t) => t.key),
    [
      'axeViolations', 'contrastFailures', 'contrastManualReview', 'keyboardInvisibleFocus', 'dropdownFailures',
      'focusableButHidden', 'focusNoIndicator', 'focusWeakIndicator', 'altMissingAttr', 'altFilenameAsAlt',
      'altLinkedNoName', 'altReviewEmptyAlt', 'headingSkips', 'headingMissingTitle', 'headingMultipleH1',
      'ariaNoName', 'ariaLabelInName', 'ariaInputNoLabel', 'ariaNoAutocomplete', 'ariaExpandedBad', 'ariaDuplicateIds',
      'brokenLinks', 'brokenLinksExternalReview', 'brokenImages', 'brokenImagesExternalReview',
    ]
  );
  const manualKeys = types.filter((t) => t.manualReview).map((t) => t.key);
  assert.deepEqual(manualKeys, ['contrastManualReview', 'altReviewEmptyAlt', 'brokenLinksExternalReview', 'brokenImagesExternalReview']);
});

test('CLI "Total flagged findings" arithmetic (Object.values(totals) sum) is order-independent and unchanged', () => {
  const summary = buildSummary(FIXTURE);
  const total = Object.values(summary.totals).reduce((a, b) => a + b, 0);
  // 18 non-heading checks * 3 + headingSkips(3) + headingMissingTitle(2) + headingMultipleH1(2)
  // = axeViolations(3) + contrastFailures(3) + keyboardInvisibleFocus(3) + dropdownFailures(3) +
  //   focusableButHidden(3) + focusNoIndicator(3) + focusWeakIndicator(3) + altMissingAttr(3) +
  //   altFilenameAsAlt(3) + altLinkedNoName(3) + headingSkips(3) + headingMissingTitle(2) +
  //   headingMultipleH1(2) + ariaNoName(3) + ariaLabelInName(3) + ariaInputNoLabel(3) +
  //   ariaNoAutocomplete(3) + ariaExpandedBad(3) + ariaDuplicateIds(3) = 55
  assert.equal(total, 55);
});
