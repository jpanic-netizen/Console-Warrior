import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { installDomHelpers } from '../src/engine/domHelpers.js';
import { auditImageResolution } from '../src/engine/checks/imageResolution.js';

// Minimal valid 1x1 PNG — real, decodable image bytes, not a placeholder.
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withImagesPage(t, fn) {
  const external = await startServer((req, res) => {
    if (req.url === '/external-ok.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(VALID_PNG);
    if (req.url === '/external-403.png') return res.writeHead(403).end('forbidden');
    if (req.url === '/external-404.png') return res.writeHead(404).end('not found');
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => external.close(r)));
  const externalOrigin = `http://127.0.0.1:${external.address().port}`;

  const main = await startServer((req, res) => {
    if (req.url === '/good.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(VALID_PNG);
    if (req.url === '/missing.png') return res.writeHead(404).end('not found');
    if (req.url === '/corrupt.png') return res.writeHead(200, { 'Content-Type': 'image/png' }).end('this is not actually png data');
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><body style="margin:0">
        <img src="/good.png" alt="Good">
        <img src="/good.png" alt="Good" class="mobile-copy">
        <img src="/missing.png" alt="Missing">
        <img src="/corrupt.png" alt="Corrupt">
        <img src="/good.png" alt="Hidden duplicate" style="display:none">
        <img src="${externalOrigin}/external-ok.png" alt="External ok">
        <img src="${externalOrigin}/external-403.png" alt="External blocked">
        <img src="${externalOrigin}/external-404.png" alt="External missing">
        <img src="http://169.254.169.254/latest/meta-data/x.png" alt="Cloud metadata">
        <div style="height:3000px"></div>
        <img src="/good.png" alt="Below the fold" loading="lazy" style="margin-top:100px">
      </body></html>`);
    }
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => main.close(r)));
  const mainOrigin = `http://127.0.0.1:${main.address().port}`;

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  await page.goto(`${mainOrigin}/`, { waitUntil: 'networkidle' });
  await installDomHelpers(page);

  await fn(page, { mainOrigin, externalOrigin });
}

test('auditImageResolution: dedupes visible duplicates, skips hidden copies, checks a below-the-fold lazy image', async (t) => {
  await withImagesPage(t, async (page) => {
    const result = await auditImageResolution(page, { allowHosts: ['127.0.0.1'] });
    // good (x2 dedup to 1), missing, corrupt, external-ok, external-403,
    // external-404, metadata, below-the-fold-lazy(good again, but a
    // DIFFERENT element instance so it dedupes by resolved URL with the
    // first "good.png" — same src, so it collapses too) = 7 distinct URLs
    assert.equal(result.checkedCount, 7);
    const belowFold = result.broken.find((b) => b.alt === 'Below the fold');
    assert.equal(belowFold, undefined, 'the lazy image shares a URL already checked and working, so it is not itself a separate broken entry');
  });
});

test('auditImageResolution: internal 404 image is a plain (non-manual-review) candidate', async (t) => {
  await withImagesPage(t, async (page) => {
    const result = await auditImageResolution(page, { allowHosts: ['127.0.0.1'] });
    const missing = result.broken.find((b) => b.href.endsWith('/missing.png'));
    assert.ok(missing);
    assert.equal(missing.status, 404);
    assert.equal(missing.renderedOk, false);
    assert.equal(missing.manualReview, false);
    assert.equal(missing.origin, 'internal');
  });
});

test('auditImageResolution: a 200 response that fails to actually decode is still reported broken', async (t) => {
  await withImagesPage(t, async (page) => {
    const result = await auditImageResolution(page, { allowHosts: ['127.0.0.1'] });
    const corrupt = result.broken.find((b) => b.href.endsWith('/corrupt.png'));
    assert.ok(corrupt, 'a 200 status alone must not be enough to call an image working');
    assert.equal(corrupt.status, 200);
    assert.equal(corrupt.renderedOk, false);
  });
});

test('auditImageResolution: a genuinely working image (including its lazy-loaded, below-the-fold copy) is never reported', async (t) => {
  await withImagesPage(t, async (page) => {
    const result = await auditImageResolution(page, { allowHosts: ['127.0.0.1'] });
    const good = result.broken.find((b) => b.href.endsWith('/good.png'));
    assert.equal(good, undefined, 'a real, decodable, 200 image must never be reported as broken');
  });
});

test('auditImageResolution: external 403 is a manual-review candidate, external 404 is not, and cloud-metadata is never fetched', async (t) => {
  await withImagesPage(t, async (page) => {
    const result = await auditImageResolution(page, { allowHosts: ['127.0.0.1'] });

    const blocked = result.broken.find((b) => b.href.includes('/external-403'));
    assert.equal(blocked.manualReview, true);
    assert.equal(blocked.origin, 'external');

    const genuinelyMissing = result.broken.find((b) => b.href.includes('/external-404'));
    assert.equal(genuinelyMissing.manualReview, false);

    const ok = result.broken.find((b) => b.href.includes('external-ok'));
    assert.equal(ok, undefined);

    const metadata = result.broken.find((b) => b.href.includes('169.254.169.254'));
    assert.ok(metadata);
    assert.equal(metadata.status, null, 'no HTTP request should have been attempted');
    assert.match(metadata.networkError, /private|internal/i);
  });
});
