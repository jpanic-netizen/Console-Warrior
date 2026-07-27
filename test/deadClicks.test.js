import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { installDomHelpers } from '../src/engine/domHelpers.js';
import { auditDeadClicks } from '../src/engine/checks/deadClicks.js';

async function withPage(t, html, fn) {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  await page.setContent(html);
  await installDomHelpers(page);
  await fn(page);
}

test('auditDeadClicks flags a visible anchor with no destination and no click-signal attribute — always as a manual-review candidate, never an automated failure', async (t) => {
  await withPage(t, `<a href="#">Learn more</a>`, async (page) => {
    const result = await auditDeadClicks(page);
    assert.equal(result.checkedCount, 1);
    assert.equal(result.dead.length, 1);
    assert.equal(result.dead[0].text, 'Learn more');
  });
});

test('auditDeadClicks does not flag an anchor with a real destination, or one that is hidden', async (t) => {
  await withPage(
    t,
    `<a href="/pricing">Pricing</a>
     <a href="#" hidden>Hidden dead link</a>
     <a href="#" style="display:none">Also hidden</a>`,
    async (page) => {
      const result = await auditDeadClicks(page);
      assert.equal(result.checkedCount, 0);
      assert.equal(result.dead.length, 0);
    }
  );
});

test('auditDeadClicks excludes an empty/# anchor that carries a static click-binding signal (onclick or a common framework attribute)', async (t) => {
  await withPage(
    t,
    `<a href="#" onclick="doSomething()">Has onclick</a>
     <a href="#" data-action="open-modal">Has data-action</a>
     <a href="javascript:void(0)" v-on:click="openModal">Vue-style binding</a>`,
    async (page) => {
      const result = await auditDeadClicks(page);
      assert.equal(result.checkedCount, 3, 'all three are still candidates that were examined');
      assert.equal(result.dead.length, 0, 'none should be flagged — each has a static signal of real behavior');
    }
  );
});

test('auditDeadClicks never clicks anything — a real onclick handler never runs', async (t) => {
  await withPage(
    t,
    `<a href="#" id="dangerous" onclick="window.__cwTestFired = true">Delete my account</a>`,
    async (page) => {
      await auditDeadClicks(page);
      const fired = await page.evaluate(() => window.__cwTestFired);
      assert.equal(fired, undefined, 'the check must never actually invoke a click handler');
    }
  );
});

test('auditDeadClicks dedupes responsive-duplicate copies of the same dead link (same text/class, both visible)', async (t) => {
  await withPage(
    t,
    `<a href="#" class="cta">Learn more</a>
     <a href="#" class="cta">Learn more</a>`,
    async (page) => {
      const result = await auditDeadClicks(page);
      assert.equal(result.checkedCount, 2);
      assert.equal(result.dead.length, 1, 'two identical visible copies must not double-count as two separate findings');
    }
  );
});

test('auditDeadClicks keeps genuinely different dead links (different visible text) as separate findings', async (t) => {
  await withPage(
    t,
    `<a href="#">Learn more</a>
     <a href="#">Get started</a>`,
    async (page) => {
      const result = await auditDeadClicks(page);
      assert.equal(result.dead.length, 2);
    }
  );
});
