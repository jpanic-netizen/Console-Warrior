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

test('auditFocusableHidden flags a visibility:hidden focusable element but not one hidden via display:none or off-screen skip-link positioning', async (t) => {
  await withPage(
    t,
    `<button style="visibility:hidden" tabindex="0">Ghost button</button>
     <button hidden tabindex="0">Properly hidden button</button>
     <a href="#main" class="skip-link" style="position:absolute;top:-40px;left:0">Skip to main content</a>`,
    async (page) => {
      const result = await auditFocusableHidden(page);
      const texts = result.focusableButHidden.map((f) => f.text);
      assert.ok(texts.includes('Ghost button'));
      assert.ok(!texts.includes('Properly hidden button'));
      assert.ok(!texts.includes('Skip to main content'));
    }
  );
});

test('auditFocusState does not report a disabled button as having no focus indicator', async (t) => {
  await withPage(
    t,
    `<button disabled>Can't focus me</button>
     <button id="live" style="outline: 2px solid red">Focus me</button>`,
    async (page) => {
      const result = await auditFocusState(page);
      const names = result.noIndicator.map((f) => f.element);
      assert.ok(!names.includes("Can't focus me"));
    }
  );
});

test('auditTabOrder excludes disabled controls from the expected focusable count', async (t) => {
  await withPage(
    t,
    `<button disabled>Nope</button><button>Yep</button>`,
    async (page) => {
      const result = await auditTabOrder(page);
      assert.equal(result.expectedFocusableCount, 1);
    }
  );
});

test('auditAriaLabels does not flag a <textarea>/<select> as nameless when properly associated via <label for> (already covered by inputNoLabel)', async (t) => {
  await withPage(
    t,
    `<label for="notes">Notes</label><textarea id="notes"></textarea>
     <label for="opt">Option</label><select id="opt"><option>A</option></select>
     <textarea id="orphan"></textarea>`,
    async (page) => {
      const result = await auditAriaLabels(page);
      const noNameTags = result.noName.map((f) => f.tag);
      assert.equal(noNameTags.length, 0, `expected labeled textarea/select to be excluded from noName, got: ${JSON.stringify(result.noName)}`);

      const orphanFlagged = result.inputNoLabel.some((f) => f.fieldId === 'orphan');
      assert.ok(orphanFlagged, 'an unlabeled textarea should still be caught by inputNoLabel');
    }
  );
});
