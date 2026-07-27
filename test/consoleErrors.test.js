import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyConsoleErrors, sourceUrlFromStack } from '../src/engine/checks/consoleErrors.js';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { auditPage } from '../src/engine/pageAudit.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('classifyConsoleErrors dedupes identical messages and drops empty ones', () => {
  const raw = [
    { message: 'TypeError: x is not a function', kind: 'uncaught' },
    { message: 'TypeError: x is not a function', kind: 'uncaught' },
    { message: '', kind: 'console.error' },
    { message: '  ', kind: 'console.error' },
  ];
  const result = classifyConsoleErrors(raw, 'https://example.com');
  assert.equal(result.length, 1);
});

test('classifyConsoleErrors marks a same-origin source as internal and a different origin as external', () => {
  const raw = [
    { message: 'Internal script error', sourceUrl: 'https://example.com/app.js', kind: 'console.error' },
    { message: 'Third-party widget error', sourceUrl: 'https://widget.thirdparty.com/embed.js', kind: 'console.error' },
  ];
  const result = classifyConsoleErrors(raw, 'https://example.com');
  assert.equal(result.find((r) => r.message === 'Internal script error').origin, 'internal');
  assert.equal(result.find((r) => r.message === 'Third-party widget error').origin, 'external');
});

test('classifyConsoleErrors falls back to "unknown" origin rather than guessing when there is no source at all', () => {
  const raw = [{ message: 'Some uncaught error with no parseable source', sourceUrl: null, kind: 'uncaught' }];
  const result = classifyConsoleErrors(raw, 'https://example.com');
  assert.equal(result[0].origin, 'unknown');
});

test('classifyConsoleErrors keeps entries with the same message but preserves kind/source of the first one seen', () => {
  const raw = [
    { message: 'Duplicate error text', sourceUrl: 'https://example.com/a.js', kind: 'uncaught' },
    { message: 'Duplicate error text', sourceUrl: 'https://elsewhere.com/b.js', kind: 'console.error' },
  ];
  const result = classifyConsoleErrors(raw, 'https://example.com');
  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'https://example.com/a.js');
});

test('sourceUrlFromStack extracts the first http(s) URL from a stack trace and strips the trailing line:column', () => {
  const stack = `TypeError: x is not a function
    at foo (https://example.com/app.js:42:17)
    at bar (https://example.com/app.js:10:5)`;
  assert.equal(sourceUrlFromStack(stack), 'https://example.com/app.js');
});

test('sourceUrlFromStack returns null when there is no URL in the stack (or no stack at all)', () => {
  assert.equal(sourceUrlFromStack('Error: something broke'), null);
  assert.equal(sourceUrlFromStack(null), null);
  assert.equal(sourceUrlFromStack(undefined), null);
});

test('auditPage end-to-end: a real console.error(), a real uncaught throw, and a third-party script error are all captured, deduped, and correctly classified', async (t) => {
  const external = await startServer((req, res) => {
    if (req.url === '/widget.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end('console.error("third party widget failure");');
    }
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => external.close(r)));
  const externalOrigin = `http://127.0.0.1:${external.address().port}`;

  const main = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>
      <script src="${externalOrigin}/widget.js"></script>
      <script>
        console.error("first party console error");
        setTimeout(() => { throw new Error("first party uncaught crash"); }, 0);
      </script>
    </body></html>`);
  });
  t.after(() => new Promise((r) => main.close(r)));
  const mainOrigin = `http://127.0.0.1:${main.address().port}`;

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-console-errors-test-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }).catch(() => {}));

  const result = await auditPage(context, `${mainOrigin}/`, { outDir, ssrf: { allowHosts: ['127.0.0.1'] } });

  const byOrigin = Object.fromEntries(result.consoleErrors.map((c) => [c.message, c.origin]));
  assert.equal(byOrigin['first party console error'], 'internal');
  assert.equal(byOrigin['first party uncaught crash'], 'internal');
  assert.equal(byOrigin['third party widget failure'], 'external');

  // No duplicates: exactly one entry per distinct message.
  assert.equal(result.consoleErrors.length, new Set(result.consoleErrors.map((c) => c.message)).size);
});
