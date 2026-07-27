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
  function isShown(el) {
    if (!el || !el.getBoundingClientRect) return false;
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
  const FOCUSABLE_SELECTOR =
    'a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[role=button]';
  const INTERACTIVE_SELECTOR =
    'a,button,input,select,textarea,[role=button],[role=link],[role=tab]';
  return { tag, cleanText, isShown, FOCUSABLE_SELECTOR, INTERACTIVE_SELECTOR };
})();
`;

export async function installDomHelpers(page) {
  await page.addScriptTag({ content: DOM_HELPERS_SOURCE });
}
