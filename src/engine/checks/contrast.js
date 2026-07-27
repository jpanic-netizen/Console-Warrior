/**
 * SOW item 1 — contrast ratio check on major text elements.
 *
 * False-positive guards preserved from the source review methodology:
 *  - Alpha-composites semi-transparent text/background colors instead of
 *    reading them at face value (a translucent highlight span over a solid
 *    background is NOT 1:1 just because its own background-color is transparent).
 *  - Text rendered over an image or gradient is reported separately as
 *    "manual review" — it is never counted as a pass or a fail, because it
 *    cannot be computed from computed styles alone.
 *  - Large-text threshold (3:1) is only applied at >=24px, or >=18.66px when
 *    font-weight >= 700 — otherwise the stricter 4.5:1 applies.
 *  - Reads `-webkit-text-fill-color` first, since gradient/clip-text effects
 *    override `color` visually.
 */
export async function auditContrast(page) {
  return page.evaluate(() => {
    const { isShown, tag } = window.__cw;

    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parseColor = (s) => {
      const m = (s || '').match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    const composite = (top, bottomRgb) =>
      [0, 1, 2].map((k) => Math.round(top.rgb[k] * top.a + bottomRgb[k] * (1 - top.a)));
    const contrastRatio = (fgRgb, bgRgb) => {
      const a = luminance(fgRgb);
      const b = luminance(bgRgb);
      return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
    };

    function effectiveBackground(el) {
      const layers = [];
      let node = el;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return { image: true };
        const parsed = parseColor(cs.backgroundColor);
        if (parsed && parsed.a > 0) {
          layers.push(parsed);
          if (parsed.a >= 1) break;
        }
        node = node.parentElement;
      }
      let base = [255, 255, 255];
      let rest = layers;
      if (layers.length && layers[layers.length - 1].a >= 1) {
        base = layers[layers.length - 1].rgb;
        rest = layers.slice(0, -1);
      }
      for (let i = rest.length - 1; i >= 0; i -= 1) base = composite(rest[i], base);
      return { rgb: base };
    }

    const failures = [];
    const manualReview = [];
    const seenFail = new Set();
    const seenManual = new Set();

    document.querySelectorAll('body *').forEach((el) => {
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
      if (!ownText || ownText.length < 2 || !isShown(el)) return;

      const style = getComputedStyle(el);
      let fg = parseColor(style.webkitTextFillColor || style.color) || parseColor(style.color);
      if (!fg || fg.a === 0) return;

      const bg = effectiveBackground(el);
      if (bg.image) {
        const key = ownText.slice(0, 80);
        if (seenManual.has(key)) return;
        seenManual.add(key);
        const id = tag(el, 'contrast-manual');
        manualReview.push({
          id,
          text: ownText.slice(0, 80),
          color: style.color,
          reason: 'Text sits over an image/gradient background — contrast cannot be computed from styles alone; needs a human eye.',
        });
        return;
      }

      if (fg.a < 1) fg = { rgb: composite(fg, bg.rgb), a: 1 };

      const px = parseFloat(style.fontSize);
      const weight = parseInt(style.fontWeight, 10) || 400;
      const needed = px >= 24 || (px >= 18.66 && weight >= 700) ? 3 : 4.5;
      const ratio = contrastRatio(fg.rgb, bg.rgb);

      if (ratio < needed) {
        const key = ownText.slice(0, 80) + ratio;
        if (seenFail.has(key)) return;
        seenFail.add(key);
        const id = tag(el, 'contrast-fail');
        failures.push({
          id,
          text: ownText.slice(0, 80),
          ratio,
          needed,
          fg: `rgb(${fg.rgb.join(',')})`,
          bg: `rgb(${bg.rgb.join(',')})`,
          fontSizePx: px,
          fontWeight: weight,
        });
      }
    });

    return { failures, manualReview };
  });
}
