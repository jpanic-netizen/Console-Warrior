/**
 * SOW item 6 — ARIA labels on interactive elements, plus the adjacent
 * WCAG checks that ride along with accessible-name computation
 * (2.5.3 Label in Name, 1.3.5 Autocomplete, 4.1.1 duplicate IDs, landmarks/lang).
 *
 * Critically, the "Label in Name" check runs in the WCAG-correct direction:
 * the *visible* text must be contained within the accessible name, not the
 * other way around. Testing it backwards flags good practice — e.g.
 * aria-label="Learn more about how OutSail works" on a button whose visible
 * text is "Learn More" is COMPLIANT and must not be reported as a failure.
 */
export async function auditAriaLabels(page) {
  return page.evaluate(() => {
    const { isShown, cleanText, tag, INTERACTIVE_SELECTOR } = window.__cw;

    const accessibleName = (el) => {
      const al = el.getAttribute('aria-label');
      if (al && al.trim()) return al.trim();

      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb
          .split(/\s+/)
          .map((id) => {
            const e = document.getElementById(id);
            return e ? cleanText(e.textContent) : '';
          })
          .join(' ')
          .trim();
        if (t) return t;
      }

      const t = cleanText(el.textContent);
      if (t) return t;

      const im = el.querySelector('img[alt]');
      if (im && im.alt.trim()) return im.alt.trim();

      const st = el.querySelector('svg title');
      if (st && cleanText(st.textContent)) return cleanText(st.textContent);

      const ti = el.getAttribute('title');
      if (ti && ti.trim()) return ti.trim();

      if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) && el.value) {
        return el.value.trim();
      }
      return '';
    };

    const normalize = (t) =>
      cleanText(t)
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const interactive = [...document.querySelectorAll(INTERACTIVE_SELECTOR)].filter(isShown);

    // SELECT/TEXTAREA and non-button/submit/reset INPUTs are form fields whose
    // labeling (including <label for>, which accessibleName() deliberately
    // doesn't chase) is already checked properly below by inputNoLabel —
    // counting them here too would flag a correctly-<label>-associated field
    // as nameless just because it has no aria-label/text content of its own.
    const coveredByInputNoLabel = (el) =>
      el.tagName === 'SELECT' ||
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && !['submit', 'button', 'reset'].includes(el.type));

    const noName = interactive.filter((el) => !accessibleName(el) && !coveredByInputNoLabel(el));

    const labelInNameViolations = interactive.filter((el) => {
      const al = el.getAttribute('aria-label');
      if (!al) return false;
      const visible = normalize(el.textContent);
      return visible ? !normalize(al).includes(visible) : false;
    });

    const formInputs = [...document.querySelectorAll('input,select,textarea')]
      .filter(isShown)
      .filter((i) => !['hidden', 'submit', 'button', 'reset'].includes(i.type));

    const inputNoLabel = formInputs.filter(
      (i) =>
        !(
          i.getAttribute('aria-label') ||
          i.getAttribute('aria-labelledby') ||
          (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) ||
          i.closest('label')
        )
    );

    const noAutocomplete = formInputs.filter(
      (i) => ['email', 'tel', 'text'].includes(i.type) && !i.getAttribute('autocomplete')
    );

    const ariaExpandedBad = [...document.querySelectorAll('[aria-expanded]')]
      .filter(isShown)
      .filter((e) => !['A', 'BUTTON', 'INPUT', 'SELECT', 'SUMMARY'].includes(e.tagName) && !e.getAttribute('role'));

    const idCounts = {};
    document.querySelectorAll('[id]').forEach((e) => {
      if (e.id) idCounts[e.id] = (idCounts[e.id] || 0) + 1;
    });
    const duplicateIds = Object.entries(idCounts)
      .filter(([, n]) => n > 1)
      .map(([id, n]) => `${id} x${n}`);

    return {
      interactiveChecked: interactive.length,
      noName: noName.map((el) => {
        const html = el.outerHTML.slice(0, 120);
        return { id: tag(el, 'aria-noname'), tag: el.tagName, html };
      }),
      labelInName: labelInNameViolations.map((el) => ({
        id: tag(el, 'aria-labelinname'),
        visible: cleanText(el.textContent).slice(0, 60),
        ariaLabel: el.getAttribute('aria-label'),
      })),
      inputNoLabel: inputNoLabel.map((i) => ({ id: tag(i, 'aria-inputnolabel'), type: i.type, fieldId: i.id, name: i.name, placeholder: i.placeholder })),
      noAutocomplete: noAutocomplete.map((i) => ({ id: tag(i, 'aria-noautocomplete'), field: i.name || i.id, type: i.type })),
      ariaExpandedBad: ariaExpandedBad.map((el) => ({ id: tag(el, 'aria-expandedbad'), text: cleanText(el.textContent).slice(0, 60) })),
      duplicateIds,
      rolesInUse: [...new Set([...document.querySelectorAll('[role]')].map((e) => e.getAttribute('role')))],
      mainLandmarkCount: document.querySelectorAll('main,[role=main]').length,
      htmlLang: document.documentElement.lang || '',
    };
  });
}
