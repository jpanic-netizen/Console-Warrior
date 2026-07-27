/**
 * SOW item 3 — focus state verification.
 *
 * Detects both "no visible change at all on focus" (hard fail) and "changes
 * something, but not via an outline/box-shadow ring" (weak — often just a
 * border/background tint that's easy to miss). Screenshots of the *actual*
 * rendered focus state (not a synthetic highlight) are captured afterward
 * by the orchestrator, since that is the only real evidence for this check.
 */
export async function auditFocusState(page) {
  return page.evaluate(() => {
    const { isShown, tag, FOCUSABLE_SELECTOR } = window.__cw;

    const snapshot = (el) => {
      const s = getComputedStyle(el);
      return [
        s.outlineStyle,
        s.outlineWidth,
        s.outlineColor,
        s.boxShadow,
        s.borderColor,
        s.backgroundColor,
        s.textDecorationLine,
      ].join('|');
    };

    const elements = [...document.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isShown);
    const previouslyFocused = document.activeElement;
    const noIndicator = [];
    const weakIndicator = [];

    elements.forEach((el) => {
      const before = snapshot(el);
      try {
        el.focus({ preventScroll: true });
      } catch (e) {
        /* some elements refuse programmatic focus; skip */
      }
      const after = snapshot(el);
      const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) || el.tagName;
      const s = getComputedStyle(el);

      if (before === after) {
        const id = tag(el, 'focus-none');
        noIndicator.push({ id, element: name, tag: el.tagName });
      } else if ((s.outlineStyle === 'none' || parseFloat(s.outlineWidth) === 0) && s.boxShadow === 'none') {
        const id = tag(el, 'focus-weak');
        weakIndicator.push({ id, element: name, tag: el.tagName, indicator: 'border/background change only — no ring' });
      }
    });

    try {
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      else document.activeElement && document.activeElement.blur();
    } catch (e) {
      /* ignore */
    }

    return { checkedCount: elements.length, noIndicator, weakIndicator };
  });
}
