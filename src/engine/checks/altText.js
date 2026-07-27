/**
 * SOW item 4 — alt text audit.
 *
 * alt="" is valid for decorative images, so an empty alt is never reported
 * as a failure — it lands in a separate "review" bucket (is this actually
 * decorative?) instead of inflating the fail count with correct markup.
 */
export async function auditAltText(page) {
  return page.evaluate(() => {
    const { isShown, tag } = window.__cw;
    const describeSrc = (i) => {
      const s = i.currentSrc || i.src || '';
      if (s.startsWith('data:')) return '(inline data URI)';
      return s.split('/').pop().split('?')[0].slice(0, 60);
    };
    const imgs = [...document.querySelectorAll('img')];

    const noAttr = imgs.filter((i) => !i.hasAttribute('alt'));
    const filenameAsAlt = imgs.filter(
      (i) => i.hasAttribute('alt') && /\.(png|jpe?g|svg|webp|avif|gif)$/i.test(i.alt.trim())
    );
    const linkedNoName = imgs.filter((i) => {
      const a = i.closest('a');
      if (!a) return false;
      const has = (i.alt && i.alt.trim()) || (a.textContent || '').trim() || a.getAttribute('aria-label');
      return !has;
    });
    const reviewEmptyAlt = imgs
      .filter((i) => i.hasAttribute('alt') && !i.alt.trim() && isShown(i))
      .map((i) => {
        let section = '';
        let n = i;
        for (let k = 0; k < 7 && n; k += 1) {
          n = n.parentElement;
          if (n) {
            const h = n.querySelector('h1,h2,h3,h4');
            if (h && h.textContent.trim()) {
              section = h.textContent.trim().slice(0, 60);
              break;
            }
          }
        }
        const id = tag(i, 'alt-review');
        return {
          id,
          file: describeSrc(i),
          widthPx: Math.round(i.getBoundingClientRect().width),
          nearestHeading: section,
          inLink: !!i.closest('a'),
        };
      });

    return {
      totalImages: imgs.length,
      noAttr: noAttr.map((i) => ({ id: tag(i, 'alt-noattr'), src: describeSrc(i) })),
      filenameAsAlt: filenameAsAlt.map((i) => ({ id: tag(i, 'alt-filename'), alt: i.alt })),
      linkedNoName: linkedNoName.map((i) => ({ id: tag(i, 'alt-linked'), src: describeSrc(i) })),
      reviewEmptyAlt,
    };
  });
}
