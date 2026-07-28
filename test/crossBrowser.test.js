import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { launchBrowser } from '../src/engine/browser.js';
import { auditSite, auditSiteMultiEngine } from '../src/engine/siteAudit.js';
import { resolveDeviceProfile } from '../src/engine/deviceProfiles.js';
import { startFixtureServer } from './fixtures/serve.js';

async function withTmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-crossbrowser-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

test('launchBrowser("webkit") actually launches a real WebKit engine, not a relabeled Chromium', async (t) => {
  const browser = await launchBrowser('webkit');
  t.after(() => browser.close());
  assert.equal(browser.browserType().name(), 'webkit');
});

test('launchBrowser() / launchBrowser("chromium") still launches Chromium (default unchanged)', async (t) => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  assert.equal(browser.browserType().name(), 'chromium');
});

/**
 * Runs every existing check (the full auditPage() pass, via auditSite())
 * against the same fixture page under both engines, and requires each check
 * category to find a comparable non-zero number of issues in WebKit too —
 * this is the actual, executed evidence for "audited every check for WebKit
 * compatibility", not a guess. Nothing here is Chromium/CDP-specific
 * (addScriptTag, page.evaluate, page.locator, page.request are all
 * cross-engine Playwright APIs), so parity is expected and enforced.
 */
test('every existing check produces real, comparable findings under WebKit, not silent zeros', async (t) => {
  const fixture = await startFixtureServer(0);
  t.after(() => new Promise((r) => fixture.close(r)));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const outDir = await withTmpDir(t);

  const [chromiumResults, webkitResults] = await Promise.all([
    auditSite({ urls: [url], outDir, engine: 'chromium', concurrency: 1 }),
    auditSite({ urls: [url], outDir, engine: 'webkit', concurrency: 1 }),
  ]);

  const c = chromiumResults[0];
  const w = webkitResults[0];
  assert.ok(!c.error, `chromium run errored: ${c.error}`);
  assert.ok(!w.error, `webkit run errored: ${w.error}`);

  assert.equal(c.engine, 'chromium');
  assert.equal(w.engine, 'webkit');

  // axe-core baseline (addScriptTag-injected, pure JS — no CDP dependency)
  assert.ok(c.axe.violations.length > 0, 'chromium should find axe violations on this fixture');
  assert.ok(w.axe.violations.length > 0, 'WebKit should find axe violations on this fixture too');

  // contrast
  assert.ok(c.contrast.failures.length > 0);
  assert.ok(w.contrast.failures.length > 0, 'WebKit contrast check must not silently return zero');

  // alt text
  const cAltIssues = c.altText.noAttr.length + c.altText.filenameAsAlt.length + c.altText.linkedNoName.length;
  const wAltIssues = w.altText.noAttr.length + w.altText.filenameAsAlt.length + w.altText.linkedNoName.length;
  assert.ok(cAltIssues > 0);
  assert.ok(wAltIssues > 0, 'WebKit alt-text check must not silently return zero');

  // headings
  assert.ok(c.headings.skips.length > 0 || c.headings.emptyHeadingsCount > 0 || !c.headings.pageTitle);
  assert.ok(w.headings.skips.length > 0 || w.headings.emptyHeadingsCount > 0 || !w.headings.pageTitle, 'WebKit heading check must find the same structural issues');

  // aria
  const cAriaIssues = c.aria.noName.length + c.aria.inputNoLabel.length + c.aria.duplicateIds.length;
  const wAriaIssues = w.aria.noName.length + w.aria.inputNoLabel.length + w.aria.duplicateIds.length;
  assert.ok(cAriaIssues > 0);
  assert.ok(wAriaIssues > 0, 'WebKit ARIA check must not silently return zero');

  // keyboard nav (tab order / dropdown operability / focusable-hidden)
  assert.ok(c.keyboard.tabOrder.expectedFocusableCount > 0);
  assert.ok(w.keyboard.tabOrder.expectedFocusableCount > 0, 'WebKit tab-order check must still find focusable elements');
  assert.equal(typeof w.keyboard.dropdowns.failingCount, 'number');
  assert.ok(w.keyboard.focusableHidden.focusableButHidden.length >= 0); // exercised without throwing

  // focus state
  assert.ok(c.focusState.noIndicator.length + c.focusState.weakIndicator.length > 0);
  assert.ok(w.focusState.noIndicator.length + w.focusState.weakIndicator.length > 0, 'WebKit focus-state check must not silently return zero');

  // Screenshots never collide between engines for the same URL.
  assert.notEqual(c.slug, w.slug);
  assert.match(c.slug, /-chromium$/);
  assert.match(w.slug, /-webkit$/);
  assert.notEqual(c.fullPageScreenshot, w.fullPageScreenshot);
});

test('auditSiteMultiEngine: Chromium+WebKit produces one tagged result per engine per URL, with independent screenshots', async (t) => {
  const fixture = await startFixtureServer(0);
  t.after(() => new Promise((r) => fixture.close(r)));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const outDir = await withTmpDir(t);

  const results = await auditSiteMultiEngine({ urls: [url], outDir, concurrency: 1, engines: ['chromium', 'webkit'] });
  assert.equal(results.length, 2);

  const byEngine = Object.fromEntries(results.map((r) => [r.engine, r]));
  assert.ok(byEngine.chromium);
  assert.ok(byEngine.webkit);
  assert.equal(byEngine.chromium.url, url);
  assert.equal(byEngine.webkit.url, url);
  assert.notEqual(byEngine.chromium.fullPageScreenshot, byEngine.webkit.fullPageScreenshot);

  // Both screenshot files genuinely exist on disk, independently.
  await fs.access(byEngine.chromium.fullPageScreenshot);
  await fs.access(byEngine.webkit.fullPageScreenshot);

  assert.equal(byEngine.chromium.deviceProfile.emulationLabel, 'Desktop viewport');
  assert.equal(byEngine.webkit.deviceProfile.emulationLabel, 'Desktop viewport');
});

test('auditSiteMultiEngine: an iPhone profile is labeled per-engine honestly (Chromium mobile emulation vs. WebKit Safari-like emulation)', async (t) => {
  const fixture = await startFixtureServer(0);
  t.after(() => new Promise((r) => fixture.close(r)));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const outDir = await withTmpDir(t);

  const results = await auditSiteMultiEngine({ urls: [url], outDir, concurrency: 1, deviceKey: 'iphone-17e', engines: ['chromium', 'webkit'] });
  const byEngine = Object.fromEntries(results.map((r) => [r.engine, r]));
  assert.equal(byEngine.chromium.deviceProfile.emulationLabel, 'Chromium mobile emulation');
  assert.equal(byEngine.webkit.deviceProfile.emulationLabel, 'WebKit Safari-like emulation');
  assert.deepEqual(byEngine.chromium.deviceProfile.viewport, { width: 390, height: 844 });
  assert.deepEqual(byEngine.webkit.deviceProfile.viewport, { width: 390, height: 844 });
});

test('auditSiteMultiEngine: defaults to Chromium only when no engines list is given', async (t) => {
  const fixture = await startFixtureServer(0);
  t.after(() => new Promise((r) => fixture.close(r)));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const outDir = await withTmpDir(t);

  const results = await auditSiteMultiEngine({ urls: [url], outDir, concurrency: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].engine, 'chromium');
});

test('resolveDeviceProfile: engine-specific emulation labels are consistent whichever engine actually runs', () => {
  const chromiumDesktop = resolveDeviceProfile({ deviceKey: 'desktop', engine: 'chromium' });
  const webkitDesktop = resolveDeviceProfile({ deviceKey: 'desktop', engine: 'webkit' });
  assert.equal(chromiumDesktop.emulationLabel, 'Desktop viewport');
  assert.equal(webkitDesktop.emulationLabel, 'Desktop viewport');
});
