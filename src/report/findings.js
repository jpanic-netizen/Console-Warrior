/**
 * Flattens the raw per-page results (the same shape auditSite() / auditPage()
 * already produce) into one finding-per-instance list, for UIs that need to
 * filter/browse individual findings rather than read the aggregated counts
 * buildSummary() produces. This is a read-only derived view — it does not
 * change what any check computes.
 *
 * CHECK_DEFS below is the single source of truth for "what checks exist and
 * how to read their raw fields" — both this file's extractFindings() and
 * buildSummary.js's totals/perCheckPages derive from it, so a new check only
 * ever needs to be listed here once. Adding a check here automatically makes
 * it show up in reports and dashboard totals; there is nowhere else to edit.
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
export const CHECK_DEFS = [
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

/**
 * Collapses findings that are effectively the same instance repeated across
 * pages — the common case being a shared header/nav/footer element that
 * trips the same check with the same message on every page. Two findings
 * group together when they share a check, severity, and summary text
 * exactly; genuinely page-specific findings (different text, different
 * ratio, different element) just end up in their own group of one.
 *
 * Sorted by pages-affected descending by default, since that's the useful
 * "what's the shared problem worth fixing once" ordering — a caller that
 * wants a different order can re-sort the returned array.
 */
export function groupFindings(findings) {
  const groups = new Map();
  let seq = 0;
  for (const f of findings) {
    const key = `${f.checkKey}::${f.severity ?? 'none'}::${f.summary}`;
    let g = groups.get(key);
    if (!g) {
      seq += 1;
      g = {
        id: `g${seq}`,
        checkKey: f.checkKey,
        checkLabel: f.checkLabel,
        section: f.section,
        severity: f.severity,
        manualReview: f.manualReview,
        summary: f.summary,
        pageSet: new Set(),
        instances: [],
      };
      groups.set(key, g);
    }
    g.instances.push(f);
    g.pageSet.add(f.page);
  }
  return [...groups.values()]
    .map((g) => ({
      id: g.id,
      checkKey: g.checkKey,
      checkLabel: g.checkLabel,
      section: g.section,
      severity: g.severity,
      manualReview: g.manualReview,
      summary: g.summary,
      pageCount: g.pageSet.size,
      instanceCount: g.instances.length,
      pages: [...g.pageSet].sort(),
      instances: g.instances.map((f) => ({
        id: f.id,
        page: f.page,
        screenshot: f.screenshot,
        fullPageScreenshot: f.fullPageScreenshot,
      })),
    }))
    .sort((a, b) => b.pageCount - a.pageCount || b.instanceCount - a.instanceCount);
}

const SEVERITY_BUCKETS = ['critical', 'serious', 'moderate', 'minor', 'manual'];

/**
 * Aggregate counts for the dashboard's breakdown views: by severity
 * (manual-review kept as its own bucket, never folded into a severity),
 * by check type (with distinct pages affected), and by page (automated vs.
 * manual, plus a severity split) — everything the four headline KPIs don't
 * show on their own.
 */
export function summarizeBreakdown(findings) {
  const bySeverity = Object.fromEntries(SEVERITY_BUCKETS.map((k) => [k, 0]));
  const byCheckMap = new Map();
  const byPageMap = new Map();

  for (const f of findings) {
    const severityBucket = f.manualReview ? 'manual' : f.severity || 'moderate';
    bySeverity[severityBucket] = (bySeverity[severityBucket] || 0) + 1;

    if (!byCheckMap.has(f.checkKey)) {
      byCheckMap.set(f.checkKey, {
        checkKey: f.checkKey,
        checkLabel: f.checkLabel,
        section: f.section,
        manualReview: f.manualReview,
        count: 0,
        pages: new Set(),
      });
    }
    const check = byCheckMap.get(f.checkKey);
    check.count += 1;
    check.pages.add(f.page);

    if (!byPageMap.has(f.page)) {
      byPageMap.set(f.page, { page: f.page, automated: 0, manual: 0, critical: 0, serious: 0, moderate: 0, minor: 0 });
    }
    const page = byPageMap.get(f.page);
    if (f.manualReview) {
      page.manual += 1;
    } else {
      page.automated += 1;
      const bucket = f.severity || 'moderate';
      page[bucket] = (page[bucket] || 0) + 1;
    }
  }

  const byCheck = [...byCheckMap.values()]
    .map((c) => ({ ...c, pages: c.pages.size }))
    .sort((a, b) => b.count - a.count);
  const byPage = [...byPageMap.values()].sort((a, b) => b.automated + b.manual - (a.automated + a.manual));

  return { bySeverity, byCheck, byPage };
}
