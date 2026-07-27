/**
 * Injected once per page via page.addScriptTag before any check runs.
 * Centralizes the shared DOM primitives so every check applies the exact
 * same "is this actually visible / interactive" rules — the single biggest
 * source of false positives in ad-hoc accessibility scripts is each check
 * reinventing (and subtly disagreeing on) visibility logic.
 */
export const DOM_HELPERS_SOURCE = `
window.__cw = (function () {
  let counter = 0;
  function nextId(prefix) {
    counter += 1;
    return prefix + '-' + counter;
  }
  // Appends rather than overwrites: a single element can legitimately trip
  // more than one check (e.g. an input can be both "no label" and "missing
  // autocomplete"). Overwriting would silently lose the earlier tag's id.
  function tag(el, prefix) {
    const id = nextId(prefix);
    const existing = el.getAttribute('data-cw-id');
    el.setAttribute('data-cw-id', existing ? existing + ' ' + id : id);
    return id;
  }
  function cleanText(t) {
    return (t || '').replace(/\\s+/g, ' ').trim();
  }
  // Visible in the sense that matters for a11y: not display:none (offsetParent),
  // not visibility:hidden, not zero-opacity, and actually occupies space.
  //
  // Collapsed <details> content (and content-visibility:hidden subtrees more
  // generally) are hidden by Blink at a level offsetParent/getBoundingClientRect
  // don't reflect — a closed <details>'s non-summary children report a normal
  // getBoundingClientRect and a non-null offsetParent even though nothing is
  // painted, which used to make every collapsed-by-default disclosure widget
  // look "shown" to every check. checkVisibility() is the one API that actually
  // accounts for this, so prefer it and only fall back to the manual heuristic
  // where it's unavailable.
  function isShown(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      el.offsetParent !== null &&
      r.width > 1 &&
      r.height > 1 &&
      s.visibility !== 'hidden' &&
      parseFloat(s.opacity) > 0
    );
  }
  // :disabled elements are excluded: browsers remove them from the tab order
  // entirely and refuse to focus them programmatically, so a disabled button
  // trivially (and falsely) "has no focus indicator" — before/after snapshots
  // are identical because focus() never took effect, not because a real focus
  // ring is missing.
  const FOCUSABLE_SELECTOR =
    'a[href],button:not(:disabled),input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"]),[role=button]';
  const INTERACTIVE_SELECTOR =
    'a,button,input,select,textarea,[role=button],[role=link],[role=tab]';
  return { tag, cleanText, isShown, FOCUSABLE_SELECTOR, INTERACTIVE_SELECTOR };
})();
`;

export async function installDomHelpers(page) {
  await page.addScriptTag({ content: DOM_HELPERS_SOURCE });
}
