/**
 * SOP check catalogue — "Dead clicks" (automating Appendix A's "visible
 * dead links only" console snippet).
 *
 * Deliberately never clicks anything, real or synthetic. "Do not activate
 * destructive controls" rules out testing behavior by actually triggering
 * it, and a synthetic (untrusted) dispatchEvent click is not a safe
 * substitute either — most plain onclick/addEventListener handlers fire on
 * synthetic events just as readily as real ones (isTrusted-based filtering
 * is an uncommon opt-in a handler has to deliberately add, not a default),
 * so it carries the same real-world-side-effect risk as a genuine click.
 * This is therefore a purely static, read-only heuristic, and every
 * result is manualReview:true — a *candidate* for a human to confirm in a
 * real browser (this is exactly SOP §6's "empty/# anchors with working JS
 * behaviour" trap), never an automated failure.
 *
 * Scoped to anchors only, not buttons: a button with no href at all is far
 * more likely to be wired to something consequential (submit, delete,
 * purchase) than a plain anchor, and — per the above — this check cannot
 * safely tell the difference without clicking. Buttons are a documented
 * gap, not silently covered.
 *
 * Excludes anything with a visible static signal of real behavior — an
 * inline onclick attribute or a common framework click-binding attribute —
 * since those are cheap, safe (no execution), same-DOM-pass ways to rule
 * out the most common "looks dead, isn't" pattern. A handler attached
 * purely via external-JS addEventListener() with no DOM trace at all
 * cannot be detected this way; that's an acknowledged limit of any static
 * check, not something this one claims to solve.
 */
export async function auditDeadClicks(page) {
  return page.evaluate(() => {
    const { isShown, cleanText, tag } = window.__cw;
    const CLICK_SIGNAL_ATTRS = ['onclick', '@click', 'v-on:click', '(click)', 'ng-click', 'data-action', 'data-toggle'];
    const NO_DESTINATION = new Set(['', '#', 'javascript:void(0)', 'javascript:void(0);', 'javascript:;']);

    const seen = new Set();
    const dead = [];
    let checkedCount = 0;

    document.querySelectorAll('a').forEach((a) => {
      if (!isShown(a)) return;
      const href = (a.getAttribute('href') || '').trim().toLowerCase();
      if (!NO_DESTINATION.has(href)) return;
      checkedCount += 1;

      if (CLICK_SIGNAL_ATTRS.some((attr) => a.hasAttribute(attr))) return;

      const text = cleanText(a.textContent) || '(icon or empty text)';
      const dedupeKey = `${text}::${a.className || ''}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      dead.push({ id: tag(a, 'deadclick'), text: text.slice(0, 60) });
    });

    return { checkedCount, dead };
  });
}
