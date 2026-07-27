/**
 * SOW item 2 — keyboard navigation.
 *
 * This drives REAL keyboard input through Playwright/CDP (trusted OS-level
 * key events), not synthetic dispatchEvent() calls from inside the page.
 * That matters: many frameworks correctly ignore untrusted script-dispatched
 * KeyboardEvents, which is how a hand-rolled console script can produce a
 * false pass on a dropdown that is actually keyboard-inoperable.
 *
 * Tab order is recorded for as many presses as there are focusable elements
 * on the page (plus headroom), rather than an arbitrary fixed count, so
 * nothing past the Nth stop goes unchecked.
 */

const FOCUSABLE_SELECTOR =
  'a[href],button:not(:disabled),input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"]),[role=button]';

export async function auditTabOrder(page) {
  const expectedFocusableCount = await page.locator(FOCUSABLE_SELECTOR).count();
  const maxPresses = Math.min(Math.max(expectedFocusableCount + 10, 20), 200);

  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.scrollTo(0, 0);
  });

  const order = [];
  let stuckCount = 0;
  let lastSignature = null;

  for (let i = 0; i < maxPresses; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const name =
        el.getAttribute('aria-label') ||
        (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) ||
        el.tagName;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        name,
        visible: el.offsetParent !== null,
        y: Math.round(rect.top + window.scrollY),
      };
    });
    if (!info) break;
    const signature = `${info.tag}|${info.name}|${info.y}`;
    if (signature === lastSignature) {
      stuckCount += 1;
      if (stuckCount >= 3) break; // focus is stuck / cycling — stop rather than spin
    } else {
      stuckCount = 0;
    }
    lastSignature = signature;
    order.push({ stop: i + 1, ...info });
  }

  const invisibleStops = order.filter((o) => !o.visible);

  return { order, invisibleStops, expectedFocusableCount, tabPressesRun: order.length };
}

export async function auditDropdownOperability(page) {
  const toggles = page.locator('[aria-expanded]');
  const count = await toggles.count();
  const results = [];

  for (let i = 0; i < count; i += 1) {
    const toggle = toggles.nth(i);
    // eslint-disable-next-line no-await-in-loop
    if (!(await toggle.isVisible())) continue;
    // eslint-disable-next-line no-await-in-loop
    const name = ((await toggle.textContent()) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    // eslint-disable-next-line no-await-in-loop
    const explicitRole = await toggle.getAttribute('role');
    // eslint-disable-next-line no-await-in-loop
    const tagName = await toggle.evaluate((el) => el.tagName);
    const impliedRole = { BUTTON: 'button', SUMMARY: 'button', A: 'link' }[tagName] || null;
    const role = explicitRole || (impliedRole ? `(implicit: ${impliedRole})` : '(none — fail)');

    // eslint-disable-next-line no-await-in-loop
    if ((await toggle.getAttribute('aria-expanded')) === 'true') {
      // eslint-disable-next-line no-await-in-loop
      await toggle.click({ trial: false }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(250);
    }

    // eslint-disable-next-line no-await-in-loop
    await toggle.focus();
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Enter');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(300);
    // eslint-disable-next-line no-await-in-loop
    const opensWithEnter = (await toggle.getAttribute('aria-expanded')) === 'true';

    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(300);
    // eslint-disable-next-line no-await-in-loop
    const closesWithEscape = (await toggle.getAttribute('aria-expanded')) === 'false';

    // eslint-disable-next-line no-await-in-loop
    await toggle.focus();
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Space');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(300);
    // eslint-disable-next-line no-await-in-loop
    const opensWithSpace = (await toggle.getAttribute('aria-expanded')) === 'true';

    // eslint-disable-next-line no-await-in-loop
    if ((await toggle.getAttribute('aria-expanded')) === 'true') {
      // eslint-disable-next-line no-await-in-loop
      await toggle.click().catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(250);
    }

    results.push({
      toggle: name,
      role: role || '(none — fail)',
      opensWithEnter,
      closesWithEscape,
      opensWithSpace,
    });
  }

  const failing = results.filter((r) => !r.opensWithEnter || !r.opensWithSpace);
  return { results, failingCount: failing.length };
}

export async function auditFocusableHidden(page) {
  return page.evaluate((selector) => {
    const { tag } = window.__cw;
    // The bug this looks for is an element that's invisible yet still
    // reachable by Tab — visibility:hidden or opacity:0 without also being
    // removed from the render tree. Geometry (getBoundingClientRect) is
    // deliberately NOT used to detect "off-screen": it's viewport-relative,
    // so a page scrolled by an earlier check (e.g. auditTabOrder following
    // focus) makes ordinary above-the-fold elements read as negative-offset
    // — and off-screen positioning is also the standard, correct technique
    // for skip links, which must not be flagged. An element hidden via
    // display:none (directly, or a `[hidden]`/collapsed <details> ancestor)
    // isn't this bug either: browsers drop it from the tab order entirely,
    // so checkVisibility()'s default (display/content-visibility only) check
    // is exactly the right filter to exclude those first.
    const found = [...document.querySelectorAll(selector)].filter((el) => {
      if (el.tabIndex < 0) return false;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
      const style = getComputedStyle(el);
      return style.visibility === 'hidden' || parseFloat(style.opacity) === 0;
    });

    const positiveTabindex = [...document.querySelectorAll('[tabindex]')].filter(
      (el) => +el.getAttribute('tabindex') > 0
    ).length;

    return {
      focusableButHidden: found.map((el) => ({
        id: tag(el, 'kb-focusablehidden'),
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
        href: el.getAttribute('href'),
      })),
      positiveTabindexCount: positiveTabindex,
    };
  }, FOCUSABLE_SELECTOR);
}
