import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { auditInfrastructure } from '../src/engine/checks/infrastructure.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- robots.txt ----------

test('infrastructure: a blanket "Disallow: /" is a real finding on production, silently correct on staging, and a manual-review candidate with no known environment', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /\n');
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const prod = await auditInfrastructure(origin, { environment: 'production' });
  assert.ok(prod.robotsTxt);
  assert.equal(prod.robotsTxt.manualReview, false);

  const staging = await auditInfrastructure(origin, { environment: 'staging' });
  assert.equal(staging.robotsTxt, null, 'Disallow: / is correct and expected on staging');

  const unknown = await auditInfrastructure(origin, {});
  assert.ok(unknown.robotsTxt);
  assert.equal(unknown.robotsTxt.manualReview, true, 'with no known environment, this must be a candidate, not an automatic pass or fail');
});

test('infrastructure: a normal robots.txt (no blanket disallow), or none at all, produces no finding regardless of environment', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /admin/\n');
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await auditInfrastructure(origin, { environment: 'production' });
  assert.equal(result.robotsTxt, null);
});

test('infrastructure: a missing robots.txt is not itself a finding', async (t) => {
  const server = await startServer((req, res) => res.writeHead(404).end());
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await auditInfrastructure(origin, { environment: 'production' });
  assert.equal(result.robotsTxt, null);
});

// ---------- sitemap.xml ----------

test('infrastructure: a missing sitemap.xml is a finding on production but not on staging', async (t) => {
  const server = await startServer((req, res) => res.writeHead(404).end());
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const prod = await auditInfrastructure(origin, { environment: 'production' });
  assert.ok(prod.sitemapXml);

  const staging = await auditInfrastructure(origin, { environment: 'staging' });
  assert.equal(staging.sitemapXml, null);
});

test('infrastructure: a present, valid sitemap.xml produces no finding; malformed content is flagged regardless of environment', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/sitemap.xml') return res.writeHead(200, { 'Content-Type': 'application/xml' }).end('<?xml version="1.0"?><urlset></urlset>');
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await auditInfrastructure(origin, { environment: 'staging' });
  assert.equal(result.sitemapXml, null);
});

test('infrastructure: malformed sitemap.xml content is flagged', async (t) => {
  const server = await startServer((req, res) => {
    if (req.url === '/sitemap.xml') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>not a sitemap</html>');
    res.writeHead(404).end();
  });
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await auditInfrastructure(origin, { environment: 'staging' });
  assert.ok(result.sitemapXml, 'malformed content must be flagged even on staging');
});

// ---------- custom 404 ----------

test('infrastructure: a genuine 404 response to an invalid URL produces no finding', async (t) => {
  const server = await startServer((req, res) => res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>Not Found</h1>'));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await auditInfrastructure(origin, {});
  assert.equal(result.custom404, null);
});

test('infrastructure: a soft-404 (200 for an invalid URL) is flagged', async (t) => {
  const server = await startServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Home</h1>'));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await auditInfrastructure(origin, {});
  assert.ok(result.custom404);
  assert.match(result.custom404.summary, /200/);
});

// ---------- HTTPS ----------

test('infrastructure: a plain-HTTP origin is a real finding on production, a manual-review candidate on staging or with no known environment', async (t) => {
  const server = await startServer((req, res) => res.writeHead(404).end());
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const prod = await auditInfrastructure(origin, { environment: 'production' });
  assert.ok(prod.httpsRedirect);
  assert.equal(prod.httpsRedirect.manualReview, false);

  const staging = await auditInfrastructure(origin, { environment: 'staging' });
  assert.ok(staging.httpsRedirect);
  assert.equal(staging.httpsRedirect.manualReview, true);

  const unknown = await auditInfrastructure(origin, {});
  assert.equal(unknown.httpsRedirect.manualReview, true);
});
