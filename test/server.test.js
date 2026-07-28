import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server/app.js';
import { startFixtureServer } from './fixtures/serve.js';

/**
 * End-to-end against the real engine (real Playwright, real checks) but
 * pointed at the local static fixture page instead of the network — same
 * approach as the existing `npm run smoke` CLI test, just through the HTTP
 * API instead of the CLI. A generous timeout accommodates a real browser run.
 *
 * The fixture server is on 127.0.0.1, which the dashboard's SSRF guard
 * blocks by default (see src/engine/ssrfGuard.js) — DASHBOARD_ALLOW_PRIVATE_TARGETS
 * opts this test process back in. That's a testing-only escape hatch;
 * production deployments must never set it. withServer scopes the env var
 * to each test via t.after so tests that deliberately want the real,
 * unbypassed SSRF behavior (see below) aren't affected by test order.
 */
async function withServer(t, fn) {
  const originalCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-server-test-'));
  process.chdir(tmpDir);

  const prevAllowPrivate = process.env.DASHBOARD_ALLOW_PRIVATE_TARGETS;
  process.env.DASHBOARD_ALLOW_PRIVATE_TARGETS = 'true';

  const fixture = await startFixtureServer(0); // port 0 = OS-assigned free port
  const fixturePort = fixture.address().port;

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => fixture.close(resolve));
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (prevAllowPrivate === undefined) delete process.env.DASHBOARD_ALLOW_PRIVATE_TARGETS;
    else process.env.DASHBOARD_ALLOW_PRIVATE_TARGETS = prevAllowPrivate;
  });

  await fn({ base, fixturePort });
}

async function pollUntilDone(base, id, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/audits/${id}`);
    const job = await res.json();
    if (['completed', 'cancelled', 'error'].includes(job.status)) return job;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Job ${id} did not finish within ${timeoutMs}ms`);
}

test('POST /api/audits runs a real audit against the fixture page and produces all downloads', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Server Test', urls: [`http://127.0.0.1:${fixturePort}/`], concurrency: 1 }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.status, 'running');
    assert.ok(created.id);

    const job = await pollUntilDone(base, created.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.progress.done, 1);
    assert.equal(job.summary.pagesAudited, 1);
    assert.equal(job.summary.pagesErrored, 0);
    // fixture page deliberately has at least one of every finding type
    assert.ok(job.summary.manualReviewCount > 0);
    assert.ok(Object.values(job.summary.totals).some((n) => n > 0));

    const listRes = await fetch(`${base}/api/audits`);
    const list = await listRes.json();
    assert.ok(list.some((j) => j.id === created.id));

    const findingsBody = await (await fetch(`${base}/api/audits/${created.id}/findings`)).json();
    assert.equal(findingsBody.grouped, false);
    assert.ok(findingsBody.total > 0);
    assert.equal(findingsBody.items.length, findingsBody.total); // default limit (50) covers the fixture's small finding count
    const findings = findingsBody.items;
    for (const f of findings) {
      assert.ok(f.checkKey);
      assert.ok(f.page);
      assert.equal(typeof f.manualReview, 'boolean');
      if (f.screenshot) assert.match(f.screenshot, /^\/api\/audits\/.+\/shot\//);
    }

    const manualOnly = (await (await fetch(`${base}/api/audits/${created.id}/findings?manualReview=true`)).json()).items;
    assert.ok(manualOnly.length > 0);
    assert.ok(manualOnly.every((f) => f.manualReview));

    const automatedOnly = (await (await fetch(`${base}/api/audits/${created.id}/findings?manualReview=false`)).json()).items;
    assert.ok(automatedOnly.every((f) => !f.manualReview));
    assert.equal(manualOnly.length + automatedOnly.length, findings.length);

    const bySeverity = (await (await fetch(`${base}/api/audits/${created.id}/findings?severity=critical`)).json()).items;
    assert.ok(bySeverity.every((f) => f.severity === 'critical'));

    const searched = (await (await fetch(`${base}/api/audits/${created.id}/findings?q=contrast`)).json()).items;
    assert.ok(searched.length > 0);
    assert.ok(searched.every((f) => `${f.summary} ${f.checkLabel}`.toLowerCase().includes('contrast')));

    const breakdown = await (await fetch(`${base}/api/audits/${created.id}/breakdown`)).json();
    assert.ok(breakdown.bySeverity);
    assert.ok(Array.isArray(breakdown.byCheck) && breakdown.byCheck.length > 0);
    assert.ok(Array.isArray(breakdown.byPage) && breakdown.byPage.length === 1);
    const totalFromBreakdown = Object.values(breakdown.bySeverity).reduce((a, b) => a + b, 0);
    assert.equal(totalFromBreakdown, findingsBody.total);

    for (const format of ['html', 'docx', 'json', 'summary']) {
      const dlRes = await fetch(`${base}/api/audits/${created.id}/download/${format}`);
      assert.equal(dlRes.status, 200, `download/${format} should succeed`);
      const buf = await dlRes.arrayBuffer();
      assert.ok(buf.byteLength > 0);
    }

    const zipRes = await fetch(`${base}/api/audits/${created.id}/download/screenshots`);
    assert.equal(zipRes.status, 200);
    assert.equal(zipRes.headers.get('content-type'), 'application/zip');
    const zipBuf = new Uint8Array(await zipRes.arrayBuffer());
    // ZIP local-file-header magic bytes ("PK\x03\x04")
    assert.equal(zipBuf[0], 0x50);
    assert.equal(zipBuf[1], 0x4b);

    if (findings.some((f) => f.screenshot)) {
      const shotUrl = base + findings.find((f) => f.screenshot).screenshot;
      const shotRes = await fetch(shotUrl);
      assert.equal(shotRes.status, 200);
      assert.equal(shotRes.headers.get('content-type'), 'image/png');
    }

    const traversalRes = await fetch(`${base}/api/audits/${created.id}/shot/${encodeURIComponent('../../package.json')}`);
    assert.equal(traversalRes.status, 404);
  });
});

test('grouped findings collapse an identical issue repeated across pages, with the raw view still available', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    // Two distinct URLs, same underlying static page — the fixture server
    // ignores the path — so every finding on it is a genuine duplicate
    // across two pages, exactly the "shared header/nav/footer" scenario.
    const urlA = `http://127.0.0.1:${fixturePort}/`;
    const urlB = `http://127.0.0.1:${fixturePort}/second-page`;
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Grouping Test', urls: [urlA, urlB], concurrency: 2 }),
    });
    const created = await createRes.json();
    const job = await pollUntilDone(base, created.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.summary.pagesAudited, 2);

    const raw = await (await fetch(`${base}/api/audits/${created.id}/findings`)).json();
    assert.equal(raw.grouped, false);
    // Every finding type on the fixture page should appear on both pages, so raw count is ~2x a single page's.
    assert.ok(raw.total > 0);

    const grouped = await (await fetch(`${base}/api/audits/${created.id}/findings?grouped=true`)).json();
    assert.equal(grouped.grouped, true);
    assert.ok(grouped.total > 0);
    assert.ok(grouped.total < raw.total, 'grouping should collapse the duplicate-across-pages findings into fewer rows');
    const sharedGroup = grouped.items.find((g) => g.pageCount === 2);
    assert.ok(sharedGroup, 'expected at least one group affecting both pages');
    assert.equal(sharedGroup.pages.length, 2);
    assert.ok(sharedGroup.instances.length >= 2);
    assert.ok(sharedGroup.instances.every((i) => i.page));
  });
});

test('findings pagination (limit/offset) covers the full result set with no gaps or overlaps', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Pagination Test', urls: [`http://127.0.0.1:${fixturePort}/`], concurrency: 1 }),
    });
    const created = await createRes.json();
    await pollUntilDone(base, created.id);

    const all = await (await fetch(`${base}/api/audits/${created.id}/findings?limit=500`)).json();
    assert.ok(all.total >= 5, 'fixture page should produce a handful of findings to paginate over');

    const pageSize = 2;
    const seen = [];
    for (let offset = 0; offset < all.total; offset += pageSize) {
      // eslint-disable-next-line no-await-in-loop
      const pageBody = await (await fetch(`${base}/api/audits/${created.id}/findings?limit=${pageSize}&offset=${offset}`)).json();
      assert.equal(pageBody.total, all.total);
      seen.push(...pageBody.items.map((f) => f.id));
    }
    assert.equal(seen.length, all.total);
    assert.equal(new Set(seen).size, all.total, 'pagination must not repeat or skip items');
    assert.deepEqual(seen, all.items.map((f) => f.id), 'paginated order must match the unpaginated order');
  });
});

test('findings sortBy severity/check/page reorders both flat and grouped results', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Sort Test', urls: [`http://127.0.0.1:${fixturePort}/`], concurrency: 1 }),
    });
    const created = await createRes.json();
    await pollUntilDone(base, created.id);

    const bySeverity = (await (await fetch(`${base}/api/audits/${created.id}/findings?sortBy=severity`)).json()).items;
    const rank = (f) => (f.manualReview ? 4 : { critical: 0, serious: 1, moderate: 2, minor: 3 }[f.severity] ?? 5);
    for (let i = 1; i < bySeverity.length; i += 1) assert.ok(rank(bySeverity[i - 1]) <= rank(bySeverity[i]));

    const byPage = (await (await fetch(`${base}/api/audits/${created.id}/findings?sortBy=page`)).json()).items;
    const pages = byPage.map((f) => f.page);
    assert.deepEqual(pages, [...pages].sort());

    const groupedByCount = (await (await fetch(`${base}/api/audits/${created.id}/findings?grouped=true&sortBy=pageCount`)).json()).items;
    for (let i = 1; i < groupedByCount.length; i += 1) assert.ok(groupedByCount[i - 1].pageCount >= groupedByCount[i].pageCount);
  });
});

test('cancelling a running job stops it and still yields partial results', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const url = `http://127.0.0.1:${fixturePort}/`;
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Cancel Test', urls: [url, url, url, url], concurrency: 1 }),
    });
    const created = await createRes.json();

    // Wait for genuine progress (not a fixed sleep) before cancelling, so the
    // test isn't racing the browser: cancel only once at least one page has
    // actually finished, then confirm the remaining ones never ran.
    const deadline = Date.now() + 30000;
    let progressed;
    do {
      // eslint-disable-next-line no-await-in-loop
      progressed = await (await fetch(`${base}/api/audits/${created.id}`)).json();
      if (progressed.progress.done >= 1) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200));
    } while (Date.now() < deadline);
    assert.ok(progressed.progress.done >= 1, 'expected at least one page to finish before cancelling');

    const cancelRes = await fetch(`${base}/api/audits/${created.id}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);

    const job = await pollUntilDone(base, created.id);
    assert.equal(job.status, 'cancelled');
    assert.ok(job.progress.done < 4, 'cancellation should stop before all pages complete');
    assert.ok(job.summary.pagesAudited >= 1, 'partial results should still be summarized');

    // cancelling an already-finished job is a no-op, reported as a conflict, not a crash
    const secondCancel = await fetch(`${base}/api/audits/${created.id}/cancel`, { method: 'POST' });
    assert.equal(secondCancel.status, 409);
  });
});

test('a second audit is refused while one is already active', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const url = `http://127.0.0.1:${fixturePort}/`;
    const first = await (
      await fetch(`${base}/api/audits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteName: 'First', urls: [url, url], concurrency: 1 }),
      })
    ).json();
    assert.equal(first.status, 'running');

    const secondRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Second', urls: [url], concurrency: 1 }),
    });
    assert.equal(secondRes.status, 409);

    // Clean up: cancel the first so it doesn't keep running past the test.
    await fetch(`${base}/api/audits/${first.id}/cancel`, { method: 'POST' });
    await pollUntilDone(base, first.id);

    // Once the first has actually finished, a new audit is allowed again.
    const thirdRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Third', urls: [url], concurrency: 1 }),
    });
    assert.equal(thirdRes.status, 201);
    const third = await thirdRes.json();
    await fetch(`${base}/api/audits/${third.id}/cancel`, { method: 'POST' });
    await pollUntilDone(base, third.id);
  });
});

test('rejects more pages or concurrency than the configured limits, before starting anything', async (t) => {
  await withServer(t, async ({ base }) => {
    const before = (await (await fetch(`${base}/api/audits`)).json()).length;
    const tooManyPages = Array.from({ length: 61 }, (_, i) => `https://example.com/page-${i}`);
    const pagesRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Too Many Pages', urls: tooManyPages }),
    });
    assert.equal(pagesRes.status, 400);
    const pagesBody = await pagesRes.json();
    assert.match(pagesBody.error, /too many pages/i);

    const concurrencyRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Too Concurrent', urls: ['https://example.com/'], concurrency: 9 }),
    });
    assert.equal(concurrencyRes.status, 400);
    const concurrencyBody = await concurrencyRes.json();
    assert.match(concurrencyBody.error, /concurrency/i);

    // Neither rejection should have started a job.
    const after = (await (await fetch(`${base}/api/audits`)).json()).length;
    assert.equal(after, before);
  });
});

test('validation rejects audits with no URLs or malformed URLs', async (t) => {
  await withServer(t, async ({ base }) => {
    const noUrls = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Empty', urls: [] }),
    });
    assert.equal(noUrls.status, 400);

    const badUrl = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Bad', urls: ['not a url'] }),
    });
    assert.equal(badUrl.status, 400);
  });
});

test('rejects a private-network audit target when SSRF protection is not bypassed', async (t) => {
  // Deliberately does NOT use withServer — this is the one test that needs
  // DASHBOARD_ALLOW_PRIVATE_TARGETS to be unset, to prove the real guard works.
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = (await (await fetch(`${base}/api/audits`)).json()).length;

  const cases = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:9999/',
    'http://192.168.1.1/',
    'http://localhost/',
    'file:///etc/passwd',
  ];
  for (const target of cases) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'SSRF probe', urls: [target] }),
    });
    assert.equal(res.status, 400, `expected ${target} to be rejected`);
  }

  const after = (await (await fetch(`${base}/api/audits`)).json()).length;
  assert.equal(after, before, 'no job should have been created for any rejected target');
});

test('requires HTTP Basic Auth when DASHBOARD_USERNAME/PASSWORD are configured', async (t) => {
  const prevUser = process.env.DASHBOARD_USERNAME;
  const prevPass = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_USERNAME = 'admin';
  process.env.DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
  t.after(() => {
    if (prevUser === undefined) delete process.env.DASHBOARD_USERNAME;
    else process.env.DASHBOARD_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = prevPass;
  });

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const noAuth = await fetch(`${base}/api/checks`);
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') || '', /Basic/);

  const wrongCreds = await fetch(`${base}/api/checks`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:wrong-password').toString('base64')}` },
  });
  assert.equal(wrongCreds.status, 401);

  const correctCreds = await fetch(`${base}/api/checks`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:correct-horse-battery-staple').toString('base64')}` },
  });
  assert.equal(correctCreds.status, 200);

  // Static assets are protected too, not just the API.
  const staticNoAuth = await fetch(`${base}/index.html`);
  assert.equal(staticNoAuth.status, 401);
});

test('a half-configured auth secret (only one of username/password) fails closed, not open', async (t) => {
  const prevUser = process.env.DASHBOARD_USERNAME;
  const prevPass = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_USERNAME = 'admin';
  delete process.env.DASHBOARD_PASSWORD;
  t.after(() => {
    if (prevUser === undefined) delete process.env.DASHBOARD_USERNAME;
    else process.env.DASHBOARD_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = prevPass;
  });

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/checks`);
  assert.equal(res.status, 500);
});

test('GET /api/audits/:id 404s for an unknown job', async (t) => {
  await withServer(t, async ({ base }) => {
    const res = await fetch(`${base}/api/audits/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/limits reports the configured deployment limits', async (t) => {
  await withServer(t, async ({ base }) => {
    const res = await fetch(`${base}/api/limits`);
    assert.equal(res.status, 200);
    const limits = await res.json();
    assert.ok(limits.maxPages > 0);
    assert.ok(limits.maxConcurrency > 0);
    assert.ok(limits.jobTimeoutMs > 0);
  });
});

test('GET /api/presets is empty when run outside the repo (no config/sites)', async (t) => {
  await withServer(t, async ({ base }) => {
    // withServer chdir's into a throwaway tmp dir with no config/, so presets should be empty there
    const res = await fetch(`${base}/api/presets`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test('GET /api/device-profiles lists the required built-in profiles plus Custom', async (t) => {
  await withServer(t, async ({ base }) => {
    const res = await fetch(`${base}/api/device-profiles`);
    assert.equal(res.status, 200);
    const profiles = await res.json();
    assert.deepEqual(
      profiles.map((p) => p.key),
      ['desktop', 'iphone-17e', 'iphone-air', 'iphone-17-pro-max', 'custom']
    );
    const iphone17e = profiles.find((p) => p.key === 'iphone-17e');
    assert.deepEqual(iphone17e.viewport, { width: 390, height: 844 });
  });
});

test('POST /api/audits: an iPhone device profile actually emulates a mobile Chromium context, and the resolved profile is saved on the job/results/reports', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Device Test', urls: [`http://127.0.0.1:${fixturePort}/`], concurrency: 1, device: 'iphone-17e' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.deepEqual(created.deviceProfile.viewport, { width: 390, height: 844 });
    assert.equal(created.deviceProfile.isMobile, true);
    assert.equal(created.deviceProfile.deviceScaleFactor, 3);
    assert.equal(created.deviceProfile.emulationLabel, 'Chromium mobile emulation');

    const job = await pollUntilDone(base, created.id);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.deviceProfile.viewport, { width: 390, height: 844 });

    // Saved onto every page result, not just the job manifest.
    const resultsRes = await fetch(`${base}/api/audits/${created.id}/results`);
    const results = await resultsRes.json();
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].deviceProfile.viewport, { width: 390, height: 844 });
    assert.equal(results[0].deviceProfile.isMobile, true);
    assert.equal(results[0].engine, 'chromium');

    // Surfaced in the generated reports too.
    const htmlRes = await fetch(`${base}/api/audits/${created.id}/download/html`);
    const html = await htmlRes.text();
    assert.match(html, /iPhone 17e/);
    assert.match(html, /390.{0,3}844/); // "390×844" (allow for the × entity/character)
    assert.match(html, /Chromium mobile emulation/);
  });
});

test('POST /api/audits: an unrecognized device key is rejected before anything starts', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const before = (await (await fetch(`${base}/api/audits`)).json()).length;
    const res = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Bad Device', urls: [`http://127.0.0.1:${fixturePort}/`], device: 'pixel-9-pro' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /device must be one of/);
    const after = (await (await fetch(`${base}/api/audits`)).json()).length;
    assert.equal(after, before);
  });
});

test('POST /api/audits: custom device profile without width/height is rejected', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const res = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Bad Custom', urls: [`http://127.0.0.1:${fixturePort}/`], device: 'custom' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /width and height/);
  });
});

test('POST /api/audits: custom width/height resolves to a custom device profile with desktop-like (non-mobile) emulation', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Custom Device Test', urls: [`http://127.0.0.1:${fixturePort}/`], concurrency: 1, device: 'custom', width: 1024, height: 768 }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.deviceProfile.deviceKey, 'custom');
    assert.deepEqual(created.deviceProfile.viewport, { width: 1024, height: 768 });
    assert.equal(created.deviceProfile.isMobile, false);
    await fetch(`${base}/api/audits/${created.id}/cancel`, { method: 'POST' });
    await pollUntilDone(base, created.id);
  });
});

test('POST /api/audits: omitting device defaults to the Desktop profile', async (t) => {
  await withServer(t, async ({ base, fixturePort }) => {
    const createRes = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: 'Default Device Test', urls: [`http://127.0.0.1:${fixturePort}/`], concurrency: 1 }),
    });
    const created = await createRes.json();
    assert.equal(created.deviceProfile.deviceKey, 'desktop');
    assert.deepEqual(created.deviceProfile.viewport, { width: 1440, height: 900 });
    await fetch(`${base}/api/audits/${created.id}/cancel`, { method: 'POST' });
    await pollUntilDone(base, created.id);
  });
});

test('GET /api/presets surfaces the checked-in site configs, including OutSail', async (t) => {
  // Deliberately runs with the real repo cwd (no chdir) so config/sites/*.json is visible.
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/presets`);
  assert.equal(res.status, 200);
  const presets = await res.json();
  assert.ok(presets.length > 0);
  const outsail = presets.find((p) => p.id === 'outsail-staging.example.json');
  assert.ok(outsail, 'expected the OutSail staging preset to be discoverable');
  assert.ok(outsail.urls.length > 20);
});
