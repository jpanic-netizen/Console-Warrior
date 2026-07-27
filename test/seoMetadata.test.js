import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { auditSeoMetadata } from '../src/engine/checks/seoMetadata.js';
import { annotateCrossPageSeoDuplicates } from '../src/report/findings.js';

async function withPage(t, html, fn) {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  await page.setContent(html);
  await fn(page);
}

test('auditSeoMetadata reads description/canonical/OG/Twitter/robots/lang, and is null-safe when everything is missing', async (t) => {
  await withPage(t, `<html><head><title>x</title></head><body></body></html>`, async (page) => {
    const seo = await auditSeoMetadata(page);
    assert.equal(seo.description, null);
    assert.equal(seo.canonical, null);
    assert.equal(seo.ogTitle, null);
    assert.equal(seo.ogDescription, null);
    assert.equal(seo.ogImage, null);
    assert.equal(seo.twitterCard, null);
    assert.equal(seo.robotsMeta, null);
    assert.equal(seo.lang, '');
  });
});

test('auditSeoMetadata reads a fully-populated page correctly', async (t) => {
  await withPage(
    t,
    `<html lang="en-US"><head>
      <title>Page title</title>
      <meta name="description" content="A real description">
      <link rel="canonical" href="https://example.com/canonical-page">
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG Description">
      <meta property="og:image" content="https://example.com/img.png">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="robots" content="noindex, nofollow">
    </head><body></body></html>`,
    async (page) => {
      const seo = await auditSeoMetadata(page);
      assert.equal(seo.description, 'A real description');
      assert.equal(seo.canonical, 'https://example.com/canonical-page');
      assert.equal(seo.ogTitle, 'OG Title');
      assert.equal(seo.ogDescription, 'OG Description');
      assert.equal(seo.ogImage, 'https://example.com/img.png');
      assert.equal(seo.twitterCard, 'summary_large_image');
      assert.equal(seo.robotsMeta, 'noindex, nofollow');
      assert.equal(seo.lang, 'en-US');
    }
  );
});

// ---------- annotateCrossPageSeoDuplicates (pure, no browser needed) ----------

function page(url, title, description) {
  return { url, error: null, headings: { pageTitle: title }, seo: { description } };
}

test('annotateCrossPageSeoDuplicates flags pages sharing an identical title or description, listing the OTHER affected pages', () => {
  const pages = [
    page('https://example.com/a', 'Same Title', 'Same description'),
    page('https://example.com/b', 'Same Title', 'Different description'),
    page('https://example.com/c', 'Unique Title', 'Same description'),
  ];
  annotateCrossPageSeoDuplicates(pages);

  assert.deepEqual(pages[0].seo.duplicateTitleWith, ['https://example.com/b']);
  assert.deepEqual(pages[0].seo.duplicateDescriptionWith, ['https://example.com/c']);

  assert.deepEqual(pages[1].seo.duplicateTitleWith, ['https://example.com/a']);
  assert.deepEqual(pages[1].seo.duplicateDescriptionWith, []);

  assert.deepEqual(pages[2].seo.duplicateTitleWith, []);
  assert.deepEqual(pages[2].seo.duplicateDescriptionWith, ['https://example.com/a']);
});

test('annotateCrossPageSeoDuplicates treats title/description matching case-insensitively but leaves genuinely unique pages alone', () => {
  const pages = [page('https://example.com/a', 'Home', 'desc'), page('https://example.com/b', 'HOME', 'DESC')];
  annotateCrossPageSeoDuplicates(pages);
  assert.deepEqual(pages[0].seo.duplicateTitleWith, ['https://example.com/b']);
  assert.deepEqual(pages[0].seo.duplicateDescriptionWith, ['https://example.com/b']);
});

test('annotateCrossPageSeoDuplicates never flags empty titles/descriptions as "duplicates" of each other', () => {
  const pages = [page('https://example.com/a', '', ''), page('https://example.com/b', '', '')];
  annotateCrossPageSeoDuplicates(pages);
  assert.deepEqual(pages[0].seo.duplicateTitleWith, []);
  assert.deepEqual(pages[0].seo.duplicateDescriptionWith, []);
});

test('annotateCrossPageSeoDuplicates skips errored pages and pages without a seo field, without throwing', () => {
  const pages = [page('https://example.com/a', 'Home', 'desc'), { url: 'https://example.com/broken', error: 'timeout' }, { url: 'https://example.com/no-seo' }];
  assert.doesNotThrow(() => annotateCrossPageSeoDuplicates(pages));
  assert.deepEqual(pages[0].seo.duplicateTitleWith, []);
});

test('annotateCrossPageSeoDuplicates is idempotent — running it twice produces the same result', () => {
  const pages = [page('https://example.com/a', 'Home', 'desc'), page('https://example.com/b', 'Home', 'desc')];
  annotateCrossPageSeoDuplicates(pages);
  const first = JSON.stringify(pages.map((p) => p.seo));
  annotateCrossPageSeoDuplicates(pages);
  const second = JSON.stringify(pages.map((p) => p.seo));
  assert.equal(first, second);
});
