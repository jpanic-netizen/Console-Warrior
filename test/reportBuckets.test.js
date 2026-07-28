import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, bucketFindings, buildCoverageReport, findingBucket, REPORT_BUCKETS } from '../src/report/findings.js';

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

// ---------- bucketFindings ----------

test('bucketFindings covers every input exactly once, across all 5 finding-level buckets', () => {
  const findings = [
    { manualReview: false, reviewReason: null, verificationStatus: 'candidate', classification: null },
    { manualReview: true, reviewReason: 'subjective', verificationStatus: 'candidate', classification: null },
    { manualReview: true, reviewReason: 'external-blocked', verificationStatus: 'candidate', classification: null },
    { manualReview: true, reviewReason: 'environment-dependent', verificationStatus: 'candidate', classification: null },
    { manualReview: false, reviewReason: null, verificationStatus: 'verified', classification: 'defect' },
    { manualReview: false, reviewReason: null, verificationStatus: 'verified', classification: 'change-request' },
    { manualReview: true, reviewReason: 'subjective', verificationStatus: 'verified', classification: 'change-request' },
  ];

  const buckets = bucketFindings(findings);

  assert.deepEqual(Object.keys(buckets), REPORT_BUCKETS);
  assert.equal(buckets.candidatesAwaitingVerification.length, 1);
  assert.equal(buckets.manualReviewItems.length, 1);
  assert.equal(buckets.externalEnvironmentIssues.length, 2);
  assert.equal(buckets.verifiedDefects.length, 1);
  assert.equal(buckets.clientChangeRequests.length, 2); // a change-request wins even if it was also manual-review

  const total = REPORT_BUCKETS.reduce((sum, k) => sum + buckets[k].length, 0);
  assert.equal(total, findings.length); // every finding lands in exactly one bucket
});

test('bucketFindings: a candidate never counts as a verified defect without an explicit human classification', () => {
  const findings = [{ manualReview: false, reviewReason: null, verificationStatus: 'candidate', classification: null }];
  const buckets = bucketFindings(findings);
  assert.equal(buckets.verifiedDefects.length, 0);
  assert.equal(buckets.candidatesAwaitingVerification.length, 1);
});

test('bucketFindings on an empty list returns every bucket present but empty', () => {
  const buckets = bucketFindings([]);
  for (const key of REPORT_BUCKETS) assert.deepEqual(buckets[key], []);
});

test('end-to-end: real checks land in the SOP-intended bucket via extractFindings', () => {
  const page = makePageResult({
    contrast: { failures: [], manualReview: [{ id: 'm1', text: 'Over gradient', reason: 'needs a human eye' }] },
    linkResolution: {
      broken: [{ text: 'Partner site', href: 'https://partner.example/', status: 403, manualReview: true, origin: 'external', reference: null }],
    },
    infrastructure: {
      origin: 'https://example.com',
      environment: null,
      robotsTxt: null,
      sitemapXml: null,
      custom404: null,
      httpsRedirect: { manualReview: true, summary: 'confirm environment' },
    },
  });
  const findings = extractFindings([page]);
  const buckets = bucketFindings(findings);

  const contrastFinding = findings.find((f) => f.checkKey === 'contrastManualReview');
  assert.ok(buckets.manualReviewItems.includes(contrastFinding));

  const linkFinding = findings.find((f) => f.checkKey === 'brokenLinksExternalReview');
  assert.ok(buckets.externalEnvironmentIssues.includes(linkFinding));

  const httpsFinding = findings.find((f) => f.checkKey === 'infraHttpsReview');
  assert.ok(buckets.externalEnvironmentIssues.includes(httpsFinding));

  // Automated, un-triaged output — still just a candidate, not a promoted defect.
  assert.equal(buckets.verifiedDefects.length, 0);
  assert.equal(buckets.clientChangeRequests.length, 0);
});

test('extractFindings stamps a bucket field on every finding, matching findingBucket() and bucketFindings() grouping', () => {
  const page = makePageResult({
    contrast: { failures: [], manualReview: [{ id: 'm1', text: 'Over gradient', reason: 'needs a human eye' }] },
  });
  const findings = extractFindings([page]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].bucket, findingBucket(findings[0]));
  assert.equal(findings[0].bucket, 'manualReviewItems');

  const buckets = bucketFindings(findings);
  assert.ok(buckets.manualReviewItems.includes(findings[0]));
});

test('every automated result starts life as a candidate, never a confirmed defect — across every Phase 1 check, not just one example', () => {
  const page = makePageResult({
    contrast: { failures: [{ id: 'c1', text: 'Low contrast', ratio: 2, needed: 4.5, fg: '#000', bg: '#111' }], manualReview: [{ id: 'm1', text: 'Over gradient', reason: 'needs a human eye' }] },
    linkResolution: {
      broken: [
        { text: 'Dead link', href: 'https://example.com/dead', status: 404, manualReview: false, origin: 'internal', reference: null },
        { text: 'Partner site', href: 'https://partner.example/', status: 403, manualReview: true, origin: 'external', reference: null },
      ],
    },
    deadClicks: { checkedCount: 1, dead: [{ text: 'Click me', screenshot: null }] },
    seo: { description: null, canonical: 'https://example.com/', ogTitle: 'x', ogDescription: 'x', ogImage: 'x', twitterCard: null, robotsMeta: 'noindex', lang: 'en' },
    placeholderText: { checkedCount: 1, found: [{ tag: 'H1', text: 'Lorem ipsum', pattern: 'lorem ipsum', screenshot: null }] },
    consoleErrors: [
      { message: 'Internal bug', source: 'https://example.com/app.js', origin: 'internal' },
      { message: 'Widget crashed', source: 'https://widget.example.net/embed.js', origin: 'external' },
    ],
    infrastructure: {
      origin: 'https://example.com',
      environment: null,
      robotsTxt: { manualReview: true, summary: 'confirm environment' },
      sitemapXml: { manualReview: false, summary: 'sitemap.xml malformed' },
      custom404: null,
      httpsRedirect: { manualReview: true, summary: 'confirm environment' },
    },
  });

  const findings = extractFindings([page]);
  assert.ok(findings.length > 10, 'fixture should exercise a broad mix of automated and manual-review checks');

  for (const f of findings) {
    assert.equal(f.verificationStatus, 'candidate', `${f.checkKey} must start as a candidate`);
    assert.equal(f.classification, null, `${f.checkKey} must start with no human classification`);
    assert.equal(f.confirmedSeverity, null, `${f.checkKey} must start with no human-confirmed severity`);
  }

  // Necessarily follows from the above, but assert it directly since it's the exact SOP requirement:
  // nothing new is ever pre-classified as a defect or a change request.
  const buckets = bucketFindings(findings);
  assert.deepEqual(buckets.verifiedDefects, []);
  assert.deepEqual(buckets.clientChangeRequests, []);
});

// ---------- buildCoverageReport ----------

test('buildCoverageReport: a check with zero findings on a page counts as passed for that page', () => {
  const page = makePageResult({ url: 'https://example.com/clean' });
  const { passed, notVerified } = buildCoverageReport([page]);
  assert.deepEqual(notVerified, []);
  const contrastPass = passed.find((p) => p.key === 'contrastFailures');
  assert.ok(contrastPass, 'contrastFailures should be listed as passed');
  assert.deepEqual(contrastPass.pages, ['https://example.com/clean']);
});

test('buildCoverageReport: a check with a finding on one page still shows "passed" for a different clean page', () => {
  const dirty = makePageResult({
    url: 'https://example.com/dirty',
    contrast: { failures: [{ id: 'c1', text: 'Low contrast', ratio: 2, needed: 4.5, fg: '#000', bg: '#111' }], manualReview: [] },
  });
  const clean = makePageResult({ url: 'https://example.com/clean' });
  const { passed } = buildCoverageReport([dirty, clean]);
  const contrastPass = passed.find((p) => p.key === 'contrastFailures');
  assert.deepEqual(contrastPass.pages, ['https://example.com/clean']);
});

test('buildCoverageReport: an errored page is "not verified", not silently counted as passed', () => {
  const ok = makePageResult({ url: 'https://example.com/ok' });
  const broken = { url: 'https://example.com/broken', error: 'Navigation timeout of 30000 ms exceeded' };
  const { passed, notVerified } = buildCoverageReport([ok, broken]);

  assert.deepEqual(notVerified, [{ url: 'https://example.com/broken', reason: 'Navigation timeout of 30000 ms exceeded' }]);
  const contrastPass = passed.find((p) => p.key === 'contrastFailures');
  assert.deepEqual(contrastPass.pages, ['https://example.com/ok']); // the errored page isn't in here either way
});

test('buildCoverageReport: a check that fails on every audited page is omitted from "passed" entirely', () => {
  const page = makePageResult({
    contrast: { failures: [{ id: 'c1', text: 'Low contrast', ratio: 2, needed: 4.5, fg: '#000', bg: '#111' }], manualReview: [] },
  });
  const { passed } = buildCoverageReport([page]);
  assert.equal(passed.find((p) => p.key === 'contrastFailures'), undefined);
});

test('buildCoverageReport: manual-review checks report coverage the same way as automated ones', () => {
  const page = makePageResult(); // no dead clicks found, no seo data set
  const { passed } = buildCoverageReport([page]);
  const deadClicksPass = passed.find((p) => p.key === 'deadClicks');
  assert.ok(deadClicksPass);
  assert.equal(deadClicksPass.manualReview, true);
});

// ---------- buildCoverageReport: site-scoped infrastructure checks ----------

test('buildCoverageReport: a clean infrastructure check passes once for the site (the origin), not once per audited page', () => {
  const pageA = makePageResult({
    url: 'https://example.com/a',
    infrastructure: {
      origin: 'https://example.com',
      environment: 'production',
      robotsTxt: null,
      sitemapXml: null,
      custom404: null,
      httpsRedirect: null,
    },
  });
  const pageB = makePageResult({ url: 'https://example.com/b' }); // no .infrastructure — it only ever attaches to one page result
  const { passed } = buildCoverageReport([pageA, pageB]);

  const robotsPass = passed.find((p) => p.key === 'infraRobotsTxt');
  assert.ok(robotsPass, 'a clean robots.txt check should still be reported as passed');
  assert.deepEqual(robotsPass.pages, ['https://example.com'], 'infra checks run once per site — "passed" must name the origin, not every audited page');
});

test('buildCoverageReport: an infra sub-check whose request failed is "not verified" for the site, never "passed"', () => {
  const page = makePageResult({
    url: 'https://example.com/a',
    infrastructure: {
      origin: 'https://example.com',
      environment: 'production',
      robotsTxt: { checkFailed: true, summary: 'Could not fetch robots.txt to check it: fetch failed' },
      sitemapXml: null,
      custom404: null,
      httpsRedirect: null,
    },
  });
  const { passed, notVerified } = buildCoverageReport([page]);

  assert.equal(passed.find((p) => p.key === 'infraRobotsTxt'), undefined, 'a failed fetch must not count as passed');
  assert.equal(passed.find((p) => p.key === 'infraRobotsTxtReview'), undefined, 'nor as passed for the paired manual-review key');
  assert.deepEqual(notVerified, [{ url: 'https://example.com', reason: '13 · Infrastructure — Could not fetch robots.txt to check it: fetch failed' }]);

  // The other, unrelated sub-checks (sitemap/404) still ran cleanly and still count as passed.
  assert.ok(passed.find((p) => p.key === 'infraSitemapXml'));
  assert.ok(passed.find((p) => p.key === 'infraCustom404'));
});

test('buildCoverageReport: a failed infra sub-check produces exactly one not-verified entry, not one per paired CHECK_DEF', () => {
  const page = makePageResult({
    url: 'https://example.com/a',
    infrastructure: {
      origin: 'https://example.com',
      environment: null,
      robotsTxt: null,
      sitemapXml: null,
      custom404: null,
      httpsRedirect: { checkFailed: true, summary: 'Could not confirm HTTP redirects to HTTPS: fetch failed' },
    },
  });
  const { notVerified } = buildCoverageReport([page]);
  // infraHttps and infraHttpsReview both read httpsRedirect — must not double-report the same outage.
  assert.equal(notVerified.length, 1);
});

test('buildCoverageReport: extractFindings never turns a checkFailed infra result into a finding, automated or manual', () => {
  const page = makePageResult({
    url: 'https://example.com/a',
    infrastructure: {
      origin: 'https://example.com',
      environment: 'production',
      robotsTxt: { checkFailed: true, summary: 'network error' },
      sitemapXml: { checkFailed: true, summary: 'network error' },
      custom404: { checkFailed: true, summary: 'network error' },
      httpsRedirect: { checkFailed: true, summary: 'network error' },
    },
  });
  const findings = extractFindings([page]);
  const infraFindings = findings.filter((f) => f.checkKey.startsWith('infra'));
  assert.deepEqual(infraFindings, [], 'a check that could not complete must never surface as either an automated or a manual-review finding');
});
