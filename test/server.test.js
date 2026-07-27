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
 */

async function withServer(t, fn) {
  const originalCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-server-test-'));
  process.chdir(tmpDir);

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

    const findingsRes = await fetch(`${base}/api/audits/${created.id}/findings`);
    const findings = await findingsRes.json();
    assert.ok(findings.length > 0);
    for (const f of findings) {
      assert.ok(f.checkKey);
      assert.ok(f.page);
      assert.equal(typeof f.manualReview, 'boolean');
      if (f.screenshot) assert.match(f.screenshot, /^\/api\/audits\/.+\/shot\//);
    }

    const manualOnly = await (await fetch(`${base}/api/audits/${created.id}/findings?manualReview=true`)).json();
    assert.ok(manualOnly.length > 0);
    assert.ok(manualOnly.every((f) => f.manualReview));

    const automatedOnly = await (await fetch(`${base}/api/audits/${created.id}/findings?manualReview=false`)).json();
    assert.ok(automatedOnly.every((f) => !f.manualReview));
    assert.equal(manualOnly.length + automatedOnly.length, findings.length);

    const bySeverity = await (await fetch(`${base}/api/audits/${created.id}/findings?severity=critical`)).json();
    assert.ok(bySeverity.every((f) => f.severity === 'critical'));

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

test('GET /api/audits/:id 404s for an unknown job', async (t) => {
  await withServer(t, async ({ base }) => {
    const res = await fetch(`${base}/api/audits/does-not-exist`);
    assert.equal(res.status, 404);
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
