import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, pagePath, displayPagePath, findingCard, findingGroupCard } from '../web/render.js';

function group(overrides = {}) {
  return {
    id: 'g1',
    checkKey: 'ariaDuplicateIds',
    checkLabel: 'Duplicate IDs',
    section: '6 · ARIA',
    severity: 'serious',
    manualReview: false,
    summary: 'Duplicate id="nav-social"',
    pageCount: 1,
    instanceCount: 1,
    pages: ['https://example.com/'],
    instances: [{ id: 'f1', page: 'https://example.com/', screenshot: '/shots/f1.png', fullPageScreenshot: '/shots/full.png' }],
    ...overrides,
  };
}

// ---------- displayPagePath ----------

test('displayPagePath: the site root reads as "Homepage (/)", not a bare "/"', () => {
  assert.equal(displayPagePath('https://example.com/'), 'Homepage (/)');
  assert.equal(displayPagePath('https://example.com'), 'Homepage (/)');
});

test('displayPagePath: any non-root path is unchanged from pagePath()', () => {
  assert.equal(displayPagePath('https://example.com/about'), '/about');
  assert.equal(pagePath('https://example.com/about'), '/about');
  assert.equal(displayPagePath('https://example.com/blog/post-1'), '/blog/post-1');
});

// ---------- findingGroupCard: single-instance groups (the reported bug) ----------

test('findingGroupCard: a single-instance group has no <details>/expansion control at all', () => {
  const html = findingGroupCard(group());
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
  assert.doesNotMatch(html, /Show \d+ page occurrence/);
});

test('findingGroupCard: a single-instance group renders exactly one screenshot element, not two', () => {
  const html = findingGroupCard(group());
  const thumbCount = (html.match(/class="finding-thumb(?:\s|")/g) || []).length;
  assert.equal(thumbCount, 1, 'a 1-page group must show its evidence exactly once, never a summary copy plus a duplicate underneath');
  // and definitely no second, decorative "preview" copy of the same shot either
  assert.doesNotMatch(html, /finding-thumb-preview/);
});

test('findingGroupCard: a single-instance group\'s screenshot is a real clickable .finding-thumb (opens the lightbox), not a decorative preview', () => {
  const html = findingGroupCard(group());
  assert.match(html, /<img class="finding-thumb"[^>]*data-full="\/shots\/f1\.png"/);
});

test('findingGroupCard: a single-instance group on the site root displays "Homepage (/)", not "/"', () => {
  const html = findingGroupCard(group());
  assert.match(html, />Homepage \(\/\)</);
  assert.doesNotMatch(html, />\/</, 'a bare "/" must never appear as the visible page label');
});

test('findingGroupCard: a single-instance group still shows severity, check label, and summary', () => {
  const html = findingGroupCard(group());
  assert.match(html, /Duplicate IDs/);
  assert.match(html, /Duplicate id=&quot;nav-social&quot;/);
  assert.match(html, /chip serious/);
});

// ---------- findingGroupCard: multi-instance groups ----------

function multiGroup(pageCount = 12) {
  const pages = Array.from({ length: pageCount }, (_, i) => `https://example.com/page-${i}`);
  return group({
    pageCount,
    instanceCount: pageCount,
    pages,
    instances: pages.map((page, i) => ({ id: `f${i}`, page, screenshot: `/shots/${i}.png`, fullPageScreenshot: '/shots/full.png' })),
  });
}

test('findingGroupCard: a multi-instance group uses an accessible, explicitly labeled control, not a bare arrow', () => {
  const html = findingGroupCard(multiGroup(12));
  assert.match(html, /<details class="finding-group">/);
  assert.match(html, /<summary class="finding-group-summary">/);
  assert.match(html, /Show 12 page occurrences/);
});

test('findingGroupCard: a multi-instance group lists every page with its own evidence when expanded', () => {
  const html = findingGroupCard(multiGroup(3));
  for (let i = 0; i < 3; i++) {
    assert.match(html, new RegExp(`data-full="/shots/${i}\\.png"`));
    assert.match(html, new RegExp(`/page-${i}`));
  }
});

test('findingGroupCard: a multi-instance group\'s summary preview thumbnail is decorative only (not a second clickable evidence copy)', () => {
  const html = findingGroupCard(multiGroup(3));
  // exactly one decorative preview (in the summary), and it must not be a
  // "real", lightbox-clickable .finding-thumb — only the per-page list rows are.
  const previewCount = (html.match(/finding-thumb-preview/g) || []).length;
  assert.equal(previewCount, 1);
  const realThumbCount = (html.match(/class="finding-thumb"/g) || []).length;
  assert.equal(realThumbCount, 3, 'one real clickable thumb per page, no extra');
});

test('findingGroupCard: multi-instance pages also get the "Homepage (/)" treatment when one of them is the root', () => {
  const g = group({
    pageCount: 2,
    instanceCount: 2,
    pages: ['https://example.com/', 'https://example.com/about'],
    instances: [
      { id: 'f1', page: 'https://example.com/', screenshot: '/shots/root.png' },
      { id: 'f2', page: 'https://example.com/about', screenshot: '/shots/about.png' },
    ],
  });
  const html = findingGroupCard(g);
  assert.match(html, />Homepage \(\/\)</);
  assert.match(html, />\/about</);
});

// ---------- findingCard (raw view) ----------

test('findingCard: the raw (ungrouped) view also renders "Homepage (/)" for the site root', () => {
  const html = findingCard({
    page: 'https://example.com/',
    checkLabel: 'Contrast failure',
    severity: 'serious',
    manualReview: false,
    summary: 'Low contrast',
    screenshot: '/shots/c1.png',
  });
  assert.match(html, />Homepage \(\/\)</);
  assert.match(html, /class="finding-thumb"/);
});

// ---------- escapeHtml sanity (used throughout render.js) ----------

test('escapeHtml neutralizes markup in untrusted summary/label text', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});
