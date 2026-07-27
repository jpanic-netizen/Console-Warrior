/**
 * SOW item 5 — heading hierarchy review.
 * Only visible headings count toward level-skip / empty-heading failures —
 * a hidden responsive-duplicate H1 (common in Webflow nav patterns) is
 * reported as informational DOM count, not folded into the visible outline.
 */
export async function auditHeadings(page) {
  return page.evaluate(() => {
    const { isShown, tag } = window.__cw;
    const all = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const visible = all.filter(isShown).map((h) => {
      const id = tag(h, 'heading');
      return {
        id,
        level: +h.tagName[1],
        text: (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      };
    });

    const skips = [];
    let prevLevel = 0;
    visible.forEach((h) => {
      if (prevLevel && h.level > prevLevel + 1) {
        skips.push(`h${prevLevel} -> h${h.level} at "${h.text.slice(0, 40)}"`);
      }
      prevLevel = h.level;
    });

    const emptyHeadings = all.filter((h) => isShown(h) && !(h.textContent || '').trim());

    const visibleH1 = visible.filter((h) => h.level === 1);
    const h1InDom = all.filter((h) => h.tagName === 'H1').length;

    return {
      visibleHeadings: visible,
      skips,
      emptyHeadingsCount: emptyHeadings.length,
      visibleH1Count: visibleH1.length,
      h1InDomCount: h1InDom,
      pageTitle: document.title || '',
    };
  });
}
