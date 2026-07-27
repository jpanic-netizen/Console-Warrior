/**
 * Flattens the raw per-page results (the same shape auditSite() / auditPage()
 * already produce) into one finding-per-instance list, for UIs that need to
 * filter/browse individual findings rather than read the aggregated counts
 * buildSummary() produces. This is a read-only derived view — it does not
 * change what any check computes, and buildSummary()/the HTML/DOCX renderers
 * are unaffected by it.
 */

export const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];

function truncate(s, n = 90) {
  const str = String(s ?? '').trim();
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function normalizeAxeImpact(impact) {
  return SEVERITIES.includes(impact) ? impact : 'moderate';
}

/**
 * Each entry describes one SOW check's findings array (or a page-level
 * boolean condition) and how to turn its raw items into a display summary.
 * `severity` here is a fixed default; `axeViolations` overrides it per-item
 * from axe's own `impact` field since axe already grades that per rule.
 */
const CHECK_DEFS = [
  {
    key: 'axeViolations',
    section: '0 · Axe baseline',
    label: 'Axe-core cross-check violation',
    manualReview: false,
    items: (r) =>
      (r.axe.violations || []).map((v) => ({
        severity: normalizeAxeImpact(v.impact),
        summary: `${v.rule} — ${v.help} (${v.nodesCount} node${v.nodesCount === 1 ? '' : 's'})`,
      })),
  },
  {
    key: 'contrastFailures',
    section: '1 · Contrast',
    label: 'Contrast failure',
    severity: 'serious',
    manualReview: false,
    items: (r) =>
      r.contrast.failures.map((f) => ({
        summary: `"${truncate(f.text)}" — ${f.ratio}:1 (needs ${f.needed}:1)`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'contrastManualReview',
    section: '1 · Contrast',
    label: 'Contrast — text over image/gradient',
    manualReview: true,
    items: (r) =>
      r.contrast.manualReview.map((f) => ({
        summary: `"${truncate(f.text)}" — ${f.reason}`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'keyboardInvisibleFocus',
    section: '2 · Keyboard nav',
    label: 'Invisible tab stop',
    severity: 'critical',
    manualReview: false,
    items: (r) =>
      r.keyboard.tabOrder.invisibleStops.map((o) => ({
        summary: `Stop ${o.stop}: ${o.tag} "${truncate(o.name, 50)}" receives focus but is not visible`,
      })),
  },
  {
    key: 'dropdownFailures',
    section: '2 · Keyboard nav',
    label: 'Dropdown/toggle keyboard-inoperable',
    severity: 'critical',
    manualReview: false,
    items: (r) =>
      r.keyboard.dropdowns.results
        .filter((d) => !d.opensWithEnter || !d.opensWithSpace)
        .map((d) => ({
          summary: `"${truncate(d.toggle, 40)}" (${d.role}) — Enter:${d.opensWithEnter ? 'ok' : 'FAIL'} Escape:${
            d.closesWithEscape ? 'ok' : 'FAIL'
          } Space:${d.opensWithSpace ? 'ok' : 'FAIL'}`,
        })),
  },
  {
    key: 'focusableButHidden',
    section: '2 · Keyboard nav',
    label: 'Focusable but hidden (keyboard trap)',
    severity: 'critical',
    manualReview: false,
    items: (r) =>
      r.keyboard.focusableHidden.focusableButHidden.map((f) => ({
        summary: `${f.tag} "${truncate(f.text, 50)}" is focusable but hidden${f.href ? ` (href: ${f.href})` : ''}`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'focusNoIndicator',
    section: '3 · Focus state',
    label: 'No visible focus indicator',
    severity: 'serious',
    manualReview: false,
    items: (r) =>
      r.focusState.noIndicator.map((f) => ({
        summary: `${f.tag} "${truncate(f.element, 50)}" — no visible change on focus`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'focusWeakIndicator',
    section: '3 · Focus state',
    label: 'Weak focus indicator',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.focusState.weakIndicator.map((f) => ({
        summary: `${f.tag} "${truncate(f.element, 50)}" — changes ${f.indicator} instead of outline/box-shadow`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'altMissingAttr',
    section: '4 · Alt text',
    label: 'Missing alt attribute',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.altText.noAttr.map((f) => ({ summary: `<img src="${truncate(f.src, 60)}"> has no alt attribute`, screenshot: f.screenshot })),
  },
  {
    key: 'altFilenameAsAlt',
    section: '4 · Alt text',
    label: 'Filename used as alt text',
    severity: 'moderate',
    manualReview: false,
    items: (r) => r.altText.filenameAsAlt.map((f) => ({ summary: `alt="${truncate(f.alt, 60)}" looks like a filename`, screenshot: f.screenshot })),
  },
  {
    key: 'altLinkedNoName',
    section: '4 · Alt text',
    label: 'Linked image with no accessible name',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.altText.linkedNoName.map((f) => ({ summary: `Linked image "${truncate(f.src, 60)}" has no accessible name`, screenshot: f.screenshot })),
  },
  {
    key: 'altReviewEmptyAlt',
    section: '4 · Alt text',
    label: 'Alt text — confirm decorative (alt="")',
    manualReview: true,
    items: (r) =>
      r.altText.reviewEmptyAlt.map((f) => ({
        summary: `"${truncate(f.file, 50)}" (${f.widthPx}px) near heading "${truncate(f.nearestHeading, 30)}"${f.inLink ? ', inside a link' : ''} — confirm decorative`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'headingSkips',
    section: '5 · Headings',
    label: 'Heading level skip',
    severity: 'moderate',
    manualReview: false,
    items: (r) => r.headings.skips.map((s) => ({ summary: String(s) })),
  },
  {
    key: 'headingMissingTitle',
    section: '5 · Headings',
    label: 'Missing page title',
    severity: 'serious',
    manualReview: false,
    items: (r) => (r.headings.pageTitle ? [] : [{ summary: 'Page has no <title> element' }]),
  },
  {
    key: 'headingMultipleH1',
    section: '5 · Headings',
    label: 'Multiple visible H1s',
    severity: 'moderate',
    manualReview: false,
    items: (r) => (r.headings.visibleH1Count > 1 ? [{ summary: `${r.headings.visibleH1Count} visible H1 elements found` }] : []),
  },
  {
    key: 'ariaNoName',
    section: '6 · ARIA',
    label: 'Interactive element with no accessible name',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.aria.noName.map((f) => ({ summary: `${f.tag}: ${truncate(f.html, 70)}`, screenshot: f.screenshot })),
  },
  {
    key: 'ariaLabelInName',
    section: '6 · ARIA',
    label: '2.5.3 Label in Name violation',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.aria.labelInName.map((f) => ({
        summary: `Visible text "${truncate(f.visible, 40)}" not contained in aria-label "${truncate(f.ariaLabel, 40)}"`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'ariaInputNoLabel',
    section: '6 · ARIA',
    label: 'Form input with no label',
    severity: 'moderate',
    manualReview: false,
    items: (r) =>
      r.aria.inputNoLabel.map((f) => ({
        summary: `<input type="${f.type}"${f.fieldId ? ` id="${f.fieldId}"` : ''}${f.name ? ` name="${f.name}"` : ''}> has no label${
          f.placeholder ? ` (placeholder: "${truncate(f.placeholder, 30)}")` : ''
        }`,
        screenshot: f.screenshot,
      })),
  },
  {
    key: 'ariaNoAutocomplete',
    section: '6 · ARIA',
    label: '1.3.5 Missing autocomplete',
    severity: 'minor',
    manualReview: false,
    items: (r) => r.aria.noAutocomplete.map((f) => ({ summary: `Field "${truncate(f.field, 40)}" (${f.type}) has no autocomplete attribute` })),
  },
  {
    key: 'ariaExpandedBad',
    section: '6 · ARIA',
    label: 'aria-expanded on non-interactive element',
    severity: 'moderate',
    manualReview: false,
    items: (r) => r.aria.ariaExpandedBad.map((f) => ({ summary: `"${truncate(f.text, 60)}" has aria-expanded but no interactive role`, screenshot: f.screenshot })),
  },
  {
    key: 'ariaDuplicateIds',
    section: '6 · ARIA',
    label: '4.1.1 Duplicate IDs',
    severity: 'serious',
    manualReview: false,
    items: (r) => r.aria.duplicateIds.map((id) => ({ summary: `Duplicate id="${id}"` })),
  },
];

/**
 * @param {Array} pageResults - the array auditSite() resolves with (one entry per URL).
 * @returns {Array} flat list of { id, page, slug, section, checkKey, checkLabel, severity, manualReview, summary, screenshot, fullPageScreenshot }
 */
export function extractFindings(pageResults) {
  const findings = [];
  let seq = 0;
  for (const r of pageResults) {
    if (!r || r.error) continue;
    for (const def of CHECK_DEFS) {
      const items = def.items(r) || [];
      for (const item of items) {
        seq += 1;
        findings.push({
          id: `f${seq}`,
          page: r.url,
          slug: r.slug,
          section: def.section,
          checkKey: def.key,
          checkLabel: def.label,
          severity: item.severity || def.severity || null,
          manualReview: !!def.manualReview,
          summary: item.summary,
          screenshot: item.screenshot || null,
          fullPageScreenshot: r.fullPageScreenshot || null,
        });
      }
    }
  }
  return findings;
}

/** Distinct check-type options for a filter dropdown, in SOW order. */
export function listCheckTypes() {
  return CHECK_DEFS.map((d) => ({ key: d.key, section: d.section, label: d.label, manualReview: !!d.manualReview }));
}
