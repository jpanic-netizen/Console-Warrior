import test from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, newAuditContext } from '../src/engine/browser.js';
import { installDomHelpers } from '../src/engine/domHelpers.js';
import { auditFocusableHidden, auditTabOrder } from '../src/engine/checks/keyboardNav.js';
import { auditFocusState } from '../src/engine/checks/focusState.js';
import { auditAriaLabels } from '../src/engine/checks/ariaLabels.js';

async function withPage(t, html, fn) {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await newAuditContext(browser);
  const page = await context.newPage();
  await page.setContent(html);
  await installDomHelpers(page);
  await fn(page);
}

// --- Collapsed <details> content: negative (never a false positive, closed
// or open) + positive (a genuinely broken element inside an OPEN details is
// still caught — the exclusion is "unreachable while collapsed", not "inside
// a details wrapper, ever"). ---

test('auditFocusableHidden does not flag focusable content inside a closed <details> (regression: collapsed disclosure content is hidden via a rendering mechanism getBoundingClientRect/offsetParent cannot see, not display:none)', async (t) => {
  await withPage(
    t,
    `<details class="grp"><summary>Toggle</summary>
       <ul><li><button tabindex="0">Inside collapsed group</button></li></ul>
     </details>`,
    async (page) => {
      const result = await auditFocusableHidden(page);
      assert.equal(result.focusableButHidden.length, 0);

      await page.locator('summary').click();
      const afterOpen = await auditFocusableHidden(page);
      assert.equal(afterOpen.focusableButHidden.length, 0);
    }
  );
});

test('auditFocusableHidden still catches a genuinely broken (visibility:hidden) element once its <details> ancestor is open (positive case: the details exclusion is about collapsed-ness, not the wrapper itself)', async (t) => {
  await withPage(
    t,
    `<details open><summary>Toggle</summary>
       <button style="visibility:hidden" tabindex="0">Ghost inside open details</button>
     </details>`,
    async (page) => {
      const result = await auditFocusableHidden(page);
      const texts = result.focusableButHidden.map((f) => f.text);
      assert.ok(texts.includes('Ghost inside open details'));
    }
  );
});

// --- Genuinely hidden focusable elements: positive (visibility:hidden,
// opacity:0) + negative (display:none via [hidden], off-screen skip-link
// positioning — both correctly reachable-by-design or already unreachable). ---

test('auditFocusableHidden flags visibility:hidden and opacity:0 focusable elements but not one hidden via display:none or off-screen skip-link positioning', async (t) => {
  await withPage(
    t,
    `<button style="visibility:hidden" tabindex="0">Ghost button</button>
     <button style="opacity:0" tabindex="0">Invisible button</button>
     <button hidden tabindex="0">Properly hidden button</button>
     <a href="#main" class="skip-link" style="position:absolute;top:-40px;left:0">Skip to main content</a>`,
    async (page) => {
      const result = await auditFocusableHidden(page);
      const texts = result.focusableButHidden.map((f) => f.text);
      assert.ok(texts.includes('Ghost button'));
      assert.ok(texts.includes('Invisible button'));
      assert.ok(!texts.includes('Properly hidden button'));
      assert.ok(!texts.includes('Skip to main content'));
    }
  );
});

// --- Disabled controls: negative (disabled is excluded from both checks) +
// positive (an enabled control with a genuinely broken focus style, or any
// other enabled control, is still counted/flagged as normal). ---

test('auditFocusState does not report a disabled button as having no focus indicator, but still flags an enabled one with no real focus style', async (t) => {
  await withPage(
    t,
    `<style>#live:focus { outline: 2px solid red; }</style>
     <button disabled>Can't focus me</button>
     <button id="live">Focus me</button>
     <button id="broken" style="outline:none;box-shadow:none">No indicator at all</button>`,
    async (page) => {
      const result = await auditFocusState(page);
      const names = result.noIndicator.map((f) => f.element);
      assert.ok(!names.includes("Can't focus me"), 'a disabled button cannot be focused, so it cannot be missing a focus indicator');
      assert.ok(!names.includes('Focus me'), 'a button with a real focus style should not be flagged');
      assert.ok(names.includes('No indicator at all'), 'an enabled button with no focus style change at all should still be flagged');
    }
  );
});

test('auditTabOrder excludes disabled controls from the expected focusable count but still counts enabled ones', async (t) => {
  await withPage(
    t,
    `<button disabled>Nope</button><button>Yep</button><a href="#x">Also yep</a>`,
    async (page) => {
      const result = await auditTabOrder(page);
      assert.equal(result.expectedFocusableCount, 2);
    }
  );
});

// --- Labeled textarea/select: negative (properly <label for>-associated
// fields aren't double-flagged as nameless) + positive (the same field types
// are still caught by inputNoLabel when they truly have no label). ---

test('auditAriaLabels does not flag a <textarea>/<select> as nameless when properly associated via <label for>, but still catches unlabeled ones via inputNoLabel', async (t) => {
  await withPage(
    t,
    `<label for="notes">Notes</label><textarea id="notes"></textarea>
     <label for="opt">Option</label><select id="opt"><option>A</option></select>
     <textarea id="orphan"></textarea>
     <select id="orphan-select"><option>A</option></select>`,
    async (page) => {
      const result = await auditAriaLabels(page);
      const noNameTags = result.noName.map((f) => f.tag);
      assert.equal(noNameTags.length, 0, `expected labeled textarea/select to be excluded from noName, got: ${JSON.stringify(result.noName)}`);

      const flaggedIds = result.inputNoLabel.map((f) => f.fieldId);
      assert.ok(flaggedIds.includes('orphan'), 'an unlabeled textarea should still be caught by inputNoLabel');
      assert.ok(flaggedIds.includes('orphan-select'), 'an unlabeled select should still be caught by inputNoLabel');
      assert.ok(!flaggedIds.includes('notes'), 'the properly labeled textarea should not appear in inputNoLabel either');
      assert.ok(!flaggedIds.includes('opt'), 'the properly labeled select should not appear in inputNoLabel either');
    }
  );
});
