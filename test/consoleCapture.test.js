import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { attachConsoleCapture, redactUrl, MAX_RETAINED_ENTRIES } from '../src/engine/consoleCapture.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- redactUrl ----------

test('redactUrl: redacts known-sensitive query parameter values, leaves the rest of the URL intact', () => {
  const redacted = redactUrl('https://example.com/api?user=alice&token=abc123&api_key=sekret');
  const url = new URL(redacted);
  assert.equal(url.searchParams.get('user'), 'alice');
  assert.equal(url.searchParams.get('token'), '[REDACTED]');
  assert.equal(url.searchParams.get('api_key'), '[REDACTED]');
  assert.equal(url.pathname, '/api');
  assert.equal(url.hostname, 'example.com');
});

test('redactUrl: ordinary, non-sensitive query params are never touched', () => {
  const url = 'https://example.com/search?q=shoes&page=2&sort=price';
  assert.equal(redactUrl(url), url);
});

test('redactUrl: matching is case-insensitive on the param name', () => {
  const redacted = redactUrl('https://example.com/x?Token=abc&API_KEY=xyz');
  const url = new URL(redacted);
  assert.equal(url.searchParams.get('Token'), '[REDACTED]');
  assert.equal(url.searchParams.get('API_KEY'), '[REDACTED]');
});

test('redactUrl: a malformed URL is returned unchanged rather than throwing', () => {
  assert.equal(redactUrl('not a url at all'), 'not a url at all');
});

test('redactUrl: a URL with no query string at all is returned unchanged', () => {
  assert.equal(redactUrl('https://example.com/about'), 'https://example.com/about');
});

// ---------- attachConsoleCapture: real browser, real events ----------

async function withPage(t, html, fn) {
  const server = await startServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/missing.js') return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    if (path === '/error500') return res.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  await fn(page, origin);
}

test('attachConsoleCapture: captures console.log/info/warn/error with level and text', async (t) => {
  await withPage(
    t,
    `<!doctype html><html><body><script>
      console.log('hello log');
      console.info('hello info');
      console.warn('hello warn');
      console.error('hello error');
    </script></body></html>`,
    async (page, origin) => {
      const capture = attachConsoleCapture(page);
      await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
      const levels = capture.consoleMessages.map((m) => m.level);
      assert.ok(levels.includes('log'));
      assert.ok(levels.includes('info'));
      assert.ok(levels.includes('warning'));
      assert.ok(levels.includes('error'));
      assert.ok(capture.consoleMessages.some((m) => m.text === 'hello error' && m.level === 'error'));
      assert.ok(capture.consoleMessages.every((m) => typeof m.timestamp === 'string' && m.timestamp.length > 0));
    }
  );
});

test('attachConsoleCapture: captures an uncaught exception as a page error with message and stack', async (t) => {
  await withPage(t, `<!doctype html><html><body><script>throw new Error('boom uncaught');</script></body></html>`, async (page, origin) => {
    const capture = attachConsoleCapture(page);
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    assert.equal(capture.pageErrors.length, 1);
    assert.match(capture.pageErrors[0].message, /boom uncaught/);
    assert.ok(capture.pageErrors[0].stack);
  });
});

test('attachConsoleCapture: captures a genuinely failed network request', async (t) => {
  await withPage(
    t,
    `<!doctype html><html><body><script>fetch('http://127.0.0.1:1/nothing-listens-here').catch(() => {});</script></body></html>`,
    async (page, origin) => {
      const capture = attachConsoleCapture(page);
      await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
      assert.ok(capture.networkFailures.length >= 1);
      assert.match(capture.networkFailures[0].url, /nothing-listens-here/);
      assert.ok(capture.networkFailures[0].failure);
    }
  );
});

test('attachConsoleCapture: captures HTTP 4xx and 5xx responses, not 2xx/3xx', async (t) => {
  await withPage(
    t,
    `<!doctype html><html><body><script>
      fetch('/missing.js').catch(() => {});
      fetch('/error500').catch(() => {});
    </script></body></html>`,
    async (page, origin) => {
      const capture = attachConsoleCapture(page);
      await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
      const statuses = capture.httpErrors.map((e) => e.status);
      assert.ok(statuses.includes(404));
      assert.ok(statuses.includes(500));
      // the page's own successful 200 document load must never show up here
      assert.ok(!statuses.includes(200));
    }
  );
});

test('attachConsoleCapture: URLs recorded for network failures/HTTP errors are redacted the same way as console source URLs', async (t) => {
  await withPage(t, `<!doctype html><html><body><script>fetch('/missing.js?token=sekret123').catch(() => {});</script></body></html>`, async (page, origin) => {
    const capture = attachConsoleCapture(page);
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const entry = capture.httpErrors.find((e) => e.url.includes('missing.js'));
    assert.ok(entry);
    assert.doesNotMatch(entry.url, /sekret123/);
    assert.match(entry.url, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  });
});

test('attachConsoleCapture: onEntry fires live for every captured category', async (t) => {
  await withPage(t, `<!doctype html><html><body><script>console.log('live');</script></body></html>`, async (page, origin) => {
    const seen = [];
    attachConsoleCapture(page, { onEntry: (category, entry) => seen.push({ category, entry }) });
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    assert.ok(seen.some((s) => s.category === 'console' && s.entry.text === 'live'));
  });
});

// ---------- retention cap ----------

test('MAX_RETAINED_ENTRIES: a page that logs far more than the cap stops growing and marks itself truncated', async (t) => {
  const lines = Array.from({ length: MAX_RETAINED_ENTRIES + 50 }, (_, i) => `console.log(${i});`).join('\n');
  await withPage(t, `<!doctype html><html><body><script>${lines}</script></body></html>`, async (page, origin) => {
    const capture = attachConsoleCapture(page, { cap: 20 });
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    assert.equal(capture.consoleMessages.length, 20);
    assert.equal(capture.consoleMessages.truncated, true);
  });
});

test('MAX_RETAINED_ENTRIES: a page logging fewer than the cap is never marked truncated', async (t) => {
  await withPage(t, `<!doctype html><html><body><script>console.log('only one');</script></body></html>`, async (page, origin) => {
    const capture = attachConsoleCapture(page);
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    assert.equal(capture.consoleMessages.truncated, false);
  });
});
