import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { installDomHelpers } from '../src/engine/domHelpers.js';
import { auditLinkResolution } from '../src/engine/checks/linkResolution.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withLinksPage(t, fn) {
  const external = await startServer((req, res) => {
    if (req.url === '/external-ok') return res.writeHead(200).end('ok');
    if (req.url === '/external-403') return res.writeHead(403).end('forbidden');
    if (req.url === '/external-404') return res.writeHead(404).end('not found');
    if (req.url === '/external-503') return res.writeHead(503).end('unavailable');
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => external.close(r)));
  const externalOrigin = `http://127.0.0.1:${external.address().port}`;

  const main = await startServer((req, res) => {
    if (req.url === '/ok') return res.writeHead(200).end('ok');
    if (req.url === '/missing') return res.writeHead(404).end('not found');
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><body>
        <a href="/ok">Working internal link</a>
        <a href="/missing">Broken internal link</a>
        <a href="#">No destination</a>
        <a href="">Empty href</a>
        <a href="javascript:void(0)">JS pseudo-link</a>
        <a href="/ok" style="display:none">Hidden duplicate</a>
        <div>
          <a href="/ok" class="mobile-copy">Working internal link</a>
        </div>
        <a href="${externalOrigin}/external-ok">External OK</a>
        <a href="${externalOrigin}/external-403">External blocked (403)</a>
        <a href="${externalOrigin}/external-404">External genuinely missing (404)</a>
        <a href="${externalOrigin}/external-503">External unavailable (503)</a>
        <a href="http://169.254.169.254/latest/meta-data/">Cloud metadata (should never be fetched)</a>
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

test('auditLinkResolution: dedupes visible duplicates, skips hidden copies and no-destination anchors', async (t) => {
  await withLinksPage(t, async (page) => {
    const result = await auditLinkResolution(page, { allowHosts: ['127.0.0.1'] });
    // 2 visible "Working internal link" copies (desktop + ".mobile-copy") dedupe
    // to 1 checked link; the display:none duplicate and the two no-destination
    // anchors (#, empty, javascript:) never even reach the checked-link list.
    // checkedCount counts every distinct link found, including the
    // cloud-metadata one — it's still "checked" (visible, has a real
    // destination), just never actually fetched (see the dedicated test below).
    assert.equal(result.checkedCount, 7); // ok, missing, external-ok, external-403, external-404, external-503, metadata
  });
});

test('auditLinkResolution: internal broken link is a plain (non-manual-review) candidate', async (t) => {
  await withLinksPage(t, async (page) => {
    const result = await auditLinkResolution(page, { allowHosts: ['127.0.0.1'] });
    const missing = result.broken.find((b) => b.href.endsWith('/missing'));
    assert.ok(missing, 'expected the internal 404 to be reported');
    assert.equal(missing.status, 404);
    assert.equal(missing.isExternal, false);
    assert.equal(missing.manualReview, false, 'an internal 404 is a real, actionable candidate, not a manual-review-only bucket item');
    assert.equal(missing.origin, 'internal');
  });
});

test('auditLinkResolution: internal (same-origin) links never need an allowHosts escape hatch, even on a private/loopback audit target', async (t) => {
  await withLinksPage(t, async (page) => {
    // No allowHosts at all — the audited page's own origin (127.0.0.1) is
    // exempt from the safety check for its own links, since we're already
    // navigated there; only genuinely external origins get re-checked.
    const result = await auditLinkResolution(page, {});
    const missing = result.broken.find((b) => b.href.endsWith('/missing'));
    assert.ok(missing, 'internal link resolution must work without allowHosts');
    assert.equal(missing.status, 404);

    const metadata = result.broken.find((b) => b.href.includes('169.254.169.254'));
    assert.equal(metadata.status, null, 'external links still get the safety check even with no allowHosts');
  });
});

test('auditLinkResolution: external 403/503 land in manual-review (automation-blocked), external 404 does not', async (t) => {
  await withLinksPage(t, async (page) => {
    const result = await auditLinkResolution(page, { allowHosts: ['127.0.0.1'] });

    const blocked403 = result.broken.find((b) => b.href.includes('/external-403'));
    assert.equal(blocked403.status, 403);
    assert.equal(blocked403.manualReview, true, '403 from an external origin must not be auto-called broken — verify in a real browser first');
    assert.equal(blocked403.origin, 'external');

    const blocked503 = result.broken.find((b) => b.href.includes('/external-503'));
    assert.equal(blocked503.manualReview, true);

    const genuinelyMissing = result.broken.find((b) => b.href.includes('/external-404'));
    assert.equal(genuinelyMissing.status, 404);
    assert.equal(genuinelyMissing.manualReview, false, 'a plain external 404 is not in the automation-blocked bucket');

    const ok = result.broken.find((b) => b.href.includes('/external-ok'));
    assert.equal(ok, undefined, 'a 200 response must not be reported as broken at all');
  });
});

test('auditLinkResolution: a link resolving to a blocked address (cloud metadata) is never fetched, only flagged', async (t) => {
  await withLinksPage(t, async (page) => {
    const result = await auditLinkResolution(page, { allowHosts: ['127.0.0.1'] });
    const metadata = result.broken.find((b) => b.href.includes('169.254.169.254'));
    assert.ok(metadata, 'expected the cloud-metadata link to be flagged rather than silently skipped');
    assert.equal(metadata.status, null, 'no HTTP request should have been attempted');
    assert.match(metadata.networkError, /private|internal/i);
    assert.equal(metadata.manualReview, true);
  });
});
