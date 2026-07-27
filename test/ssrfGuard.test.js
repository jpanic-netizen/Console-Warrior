import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTargetSafety, assertSafeTarget } from '../src/engine/ssrfGuard.js';

test('blocks private, loopback, link-local, and cloud-metadata IPv4 targets', async () => {
  const blocked = [
    'http://127.0.0.1:8973/',
    'http://127.0.0.53/',
    'http://10.0.0.5/',
    'http://172.16.5.5/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    'http://0.0.0.0/',
    'http://100.64.0.1/', // CGNAT
  ];
  for (const u of blocked) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkTargetSafety(u);
    assert.equal(result.ok, false, `expected ${u} to be blocked`);
  }
});

test('blocks localhost and IPv6 loopback/link-local targets', async () => {
  const blocked = ['http://localhost:3000/', 'http://[::1]/', 'http://[fe80::1]/', 'http://[fc00::1]/'];
  for (const u of blocked) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkTargetSafety(u);
    assert.equal(result.ok, false, `expected ${u} to be blocked`);
  }
});

test('blocks non-http(s) schemes regardless of host', async () => {
  const blocked = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/', 'data:text/html,hi'];
  for (const u of blocked) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkTargetSafety(u);
    assert.equal(result.ok, false, `expected ${u} to be blocked`);
  }
});

test('allows public IP literals and real public hostnames', async () => {
  const allowed = ['https://8.8.8.8/', 'https://outsail-staging.webflow.io/', 'https://example.com/'];
  for (const u of allowed) {
    // eslint-disable-next-line no-await-in-loop
    const result = await checkTargetSafety(u);
    assert.equal(result.ok, true, `expected ${u} to be allowed, got: ${result.ok ? '' : result.reason}`);
  }
});

test('rejects malformed URLs with a clear reason instead of throwing', async () => {
  const result = await checkTargetSafety('not a url at all');
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a valid url/i);
});

test('allowHosts opts a specific hostname back in (for local test fixtures)', async () => {
  const blocked = await checkTargetSafety('http://127.0.0.1:8973/');
  assert.equal(blocked.ok, false);
  const allowed = await checkTargetSafety('http://127.0.0.1:8973/', { allowHosts: ['127.0.0.1'] });
  assert.equal(allowed.ok, true);
});

test('assertSafeTarget throws for unsafe targets and resolves for safe ones', async () => {
  await assert.rejects(() => assertSafeTarget('http://192.168.1.1/'));
  await assert.doesNotReject(() => assertSafeTarget('https://example.com/'));
});
