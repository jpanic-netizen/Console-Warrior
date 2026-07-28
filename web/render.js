/**
 * Pure, DOM-free presentation helpers shared by app.js (the browser) and the
 * test suite (Node). Every export here takes plain data and returns a plain
 * string — no `document` access, no event wiring — so it can be unit tested
 * with plain string assertions and imported unmodified into the browser via
 * a relative ESM import.
 */

export const SEVERITY_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function pagePath(u) {
  try {
    return new URL(u).pathname || '/';
  } catch {
    return u;
  }
}

/** Same as pagePath(), but names the site root explicitly — a bare "/" reads
 * as truncated/broken in a findings list; nobody would recognize it as "the
 * homepage" out of context. */
export function displayPagePath(u) {
  const p = pagePath(u);
  return p === '/' ? 'Homepage (/)' : p;
}

export function severityChip(f) {
  if (f.manualReview) return '<span class="chip manual">Manual</span>';
  if (f.severity) return `<span class="chip ${f.severity}">${SEVERITY_LABEL[f.severity] || f.severity}</span>`;
  return '';
}

export function thumbHtml(screenshot, fullPageScreenshot, altLabel) {
  const src = screenshot || fullPageScreenshot;
  if (!src) return '<div class="finding-thumb empty">no capture</div>';
  return `<img class="finding-thumb" src="${escapeHtml(src)}" alt="${escapeHtml(altLabel)}" aria-label="${escapeHtml(altLabel)}" loading="lazy" data-full="${escapeHtml(src)}" tabindex="0" role="button" aria-haspopup="dialog">`;
}

// Decorative-only variant for the sample thumbnail shown inside a group
// summary — a <summary> is itself an interactive disclosure control, so
// nesting another focusable/interactive element inside it violates the
// nested-interactive rule.
export function thumbPreviewHtml(screenshot, fullPageScreenshot) {
  const src = screenshot || fullPageScreenshot;
  if (!src) return '<div class="finding-thumb-preview empty">no capture</div>';
  return `<img class="finding-thumb-preview" src="${escapeHtml(src)}" alt="" loading="lazy">`;
}

export function findingCard(f) {
  const path = displayPagePath(f.page);
  return `
    <div class="finding-card">
      ${thumbHtml(f.screenshot, f.fullPageScreenshot, `Evidence for ${f.checkLabel} on ${path}`)}
      <div class="finding-body">
        <div class="finding-top">${severityChip(f)}<span class="finding-page" title="${escapeHtml(f.page)}">${escapeHtml(path)}</span><strong>${escapeHtml(f.checkLabel)}</strong></div>
        <div class="finding-summary">${escapeHtml(f.summary)}</div>
      </div>
    </div>`;
}

/**
 * A group with exactly one instance/page is rendered exactly like a plain
 * finding card (no disclosure control, one screenshot) — there's nothing to
 * expand into, so a toggle here would only ever reveal a second copy of the
 * same evidence already on screen. Groups with 2+ pages get a <details> with
 * an explicit "Show N page occurrences" label (never a bare, unlabeled arrow)
 * and a per-page list, each row carrying that page's own evidence.
 */
export function findingGroupCard(g) {
  if (g.pageCount <= 1) {
    const page = g.pages[0];
    const inst = g.instances.find((i) => i.page === page) || g.instances[0] || {};
    const path = displayPagePath(page);
    return `
      <div class="finding-card">
        ${thumbHtml(inst.screenshot, inst.fullPageScreenshot, `Evidence for ${g.checkLabel} on ${path}`)}
        <div class="finding-body">
          <div class="finding-top">${severityChip(g)}<span class="finding-page" title="${escapeHtml(page)}">${escapeHtml(path)}</span><strong>${escapeHtml(g.checkLabel)}</strong></div>
          <div class="finding-summary">${escapeHtml(g.summary)}</div>
        </div>
      </div>`;
  }

  const sample = g.instances.find((i) => i.screenshot) || g.instances[0] || {};
  const pageListHtml = g.pages
    .map((page) => {
      const inst = g.instances.find((i) => i.page === page) || {};
      const path = displayPagePath(page);
      return `
        <li class="finding-page-row">
          ${thumbHtml(inst.screenshot, inst.fullPageScreenshot, `Evidence for ${g.checkLabel} on ${path}`)}
          <span class="finding-page-row-label" title="${escapeHtml(page)}">${escapeHtml(path)}</span>
        </li>`;
    })
    .join('');
  return `
    <details class="finding-group">
      <summary class="finding-group-summary">
        <span class="finding-thumb-wrap">${thumbPreviewHtml(sample.screenshot, sample.fullPageScreenshot)}</span>
        <span class="finding-group-meta">
          <span class="finding-top">${severityChip(g)}<strong>${escapeHtml(g.checkLabel)}</strong></span>
          <span class="finding-summary">${escapeHtml(g.summary)}</span>
        </span>
        <span class="finding-page-count">Show ${g.pageCount} page occurrences</span>
      </summary>
      <ul class="finding-page-list">${pageListHtml}</ul>
    </details>`;
}
