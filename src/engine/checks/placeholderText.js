/**
 * SOP check catalogue — "HTML validity": unreplaced placeholder text
 * ("lorem ipsum", "Test", "heading 2", "TBD"). Every pattern matches the
 * ENTIRE trimmed text of a leaf element, never a substring found anywhere
 * in a longer sentence — a substring search for "test" would false-positive
 * on "Testimonials", "attestation", "contest", exactly the "avoid legitimate
 * words such as a real page intentionally named 'Test'" trap this exists to
 * dodge. A page whose whole heading/paragraph/button text IS, verbatim,
 * "Test" or "TBD" or "Heading 2" is a very different, much stronger signal
 * than the word merely appearing somewhere.
 */
const PLACEHOLDER_PATTERNS = [
  { name: 'Lorem ipsum filler text', re: /^lorem ipsum\b/i },
  { name: 'Generic numbered heading placeholder', re: /^heading\s*\d+$/i },
  { name: '"TBD" placeholder', re: /^tbd$/i },
  { name: '"Test" placeholder', re: /^test$/i },
  { name: 'Bracketed placeholder text', re: /^\[[^\]]+\]$/ },
  { name: '"Placeholder" literal text', re: /^placeholder(\s+text)?$/i },
  { name: '"Click here" placeholder', re: /^click here(\s+to\s+edit)?$/i },
  { name: '"Insert ... here" placeholder', re: /^insert\s+(text|content|copy|image)\s+here$/i },
  { name: '"Your ... here" placeholder', re: /^your\s+(text|content|headline|title)\s+here$/i },
  { name: 'Sample/dummy text placeholder', re: /^(sample|dummy)\s+text$/i },
  { name: 'Generic body/paragraph text placeholder', re: /^(body|paragraph)\s+text\s*\d*$/i },
];

export async function auditPlaceholderText(page) {
  const patterns = PLACEHOLDER_PATTERNS.map((p) => ({ name: p.name, source: p.re.source, flags: p.re.flags }));
  return page.evaluate((patternSpecs) => {
    const { isShown, cleanText, tag } = window.__cw;
    const patterns = patternSpecs.map((p) => ({ name: p.name, re: new RegExp(p.source, p.flags) }));
    const SELECTOR = 'h1,h2,h3,h4,h5,h6,p,button,a,span,li';

    const seen = new Set();
    const found = [];
    let checkedCount = 0;

    document.querySelectorAll(SELECTOR).forEach((el) => {
      // Leaf elements only — skip anything with element children so a
      // wrapping <li>/<p> and the <a>/<span> inside it don't both get
      // scanned (and potentially both flagged) for the same text.
      if (el.children.length > 0) return;
      if (!isShown(el)) return;
      const text = cleanText(el.textContent);
      if (!text) return;
      checkedCount += 1;

      for (const p of patterns) {
        if (!p.re.test(text)) continue;
        const dedupeKey = text.toLowerCase();
        if (seen.has(dedupeKey)) break;
        seen.add(dedupeKey);
        found.push({ id: tag(el, 'placeholder'), tag: el.tagName, text: text.slice(0, 80), pattern: p.name });
        break;
      }
    });

    return { checkedCount, found };
  }, patterns);
}
