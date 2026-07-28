import fs from 'node:fs/promises';
import path from 'node:path';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relShot(reportDir, absPath) {
  if (!absPath) return null;
  return path.relative(reportDir, absPath).split(path.sep).join('/');
}

function statusChip(count, opts = {}) {
  const { warn = false } = opts;
  if (count === 0) return `<span class="chip pass">0 pass</span>`;
  return `<span class="chip ${warn ? 'warn' : 'fail'}">${count}</span>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="empty">None found.</p>';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function shotThumb(reportDir, finding) {
  const rel = relShot(reportDir, finding.screenshot);
  if (!rel) return '<em class="noshot">no capture</em>';
  return `<a href="${esc(rel)}" target="_blank"><img class="thumb" src="${esc(rel)}" alt="Screenshot of finding" loading="lazy"></a>`;
}

function findingsSection(title, count, bodyHtml, opts = {}) {
  return `
    <details class="finding-block" ${count > 0 ? 'open' : ''}>
      <summary>${esc(title)} ${statusChip(count, opts)}</summary>
      <div class="finding-body">${bodyHtml}</div>
    </details>`;
}

function renderPage(reportDir, r) {
  if (r.error) {
    return `<section class="page-report error">
      <h2>${esc(r.url)}</h2>
      <p class="empty">Audit failed to complete for this URL.</p>
      <pre>${esc(r.error)}</pre>
    </section>`;
  }

  const fullShotRel = relShot(reportDir, r.fullPageScreenshot);

  const axeRows = (r.axe.violations || []).map((v) => [
    esc(v.rule), esc(v.impact || ''), esc(v.help), String(v.nodesCount),
  ]);

  const contrastRows = r.contrast.failures.map((f) => [
    shotThumb(reportDir, f), esc(f.text), `${f.ratio}:1 (needs ${f.needed}:1)`, esc(f.fg), esc(f.bg), `${f.fontSizePx}px / ${f.fontWeight}`,
  ]);
  const contrastManualRows = r.contrast.manualReview.map((f) => [shotThumb(reportDir, f), esc(f.text), esc(f.reason)]);

  const tabOrderRows = r.keyboard.tabOrder.order.map((o) => [
    String(o.stop), esc(o.tag), esc(o.name), o.visible ? 'yes' : '<strong class="fail-text">NO</strong>', String(o.y),
  ]);
  const dropdownRows = r.keyboard.dropdowns.results.map((d) => [
    esc(d.toggle), esc(d.role), d.opensWithEnter ? 'yes' : 'NO', d.closesWithEscape ? 'yes' : 'NO', d.opensWithSpace ? 'yes' : 'NO',
  ]);
  const focusableHiddenRows = r.keyboard.focusableHidden.focusableButHidden.map((f) => [
    shotThumb(reportDir, f), esc(f.tag), esc(f.text), esc(f.href || ''),
  ]);

  const focusNoneRows = r.focusState.noIndicator.map((f) => [shotThumb(reportDir, f), esc(f.tag), esc(f.element)]);
  const focusWeakRows = r.focusState.weakIndicator.map((f) => [shotThumb(reportDir, f), esc(f.tag), esc(f.element), esc(f.indicator)]);

  const altNoAttrRows = r.altText.noAttr.map((f) => [shotThumb(reportDir, f), esc(f.src)]);
  const altFilenameRows = r.altText.filenameAsAlt.map((f) => [shotThumb(reportDir, f), esc(f.alt)]);
  const altLinkedRows = r.altText.linkedNoName.map((f) => [shotThumb(reportDir, f), esc(f.src)]);
  const altReviewRows = r.altText.reviewEmptyAlt.map((f) => [
    shotThumb(reportDir, f), esc(f.file), String(f.widthPx), esc(f.nearestHeading), f.inLink ? 'yes' : 'no',
  ]);

  const headingRows = r.headings.visibleHeadings.map((h) => [`H${h.level}`, esc(h.text)]);

  const ariaNoNameRows = r.aria.noName.map((f) => [shotThumb(reportDir, f), esc(f.tag), `<code>${esc(f.html)}</code>`]);
  const ariaLabelInNameRows = r.aria.labelInName.map((f) => [shotThumb(reportDir, f), esc(f.visible), esc(f.ariaLabel)]);
  const ariaInputNoLabelRows = r.aria.inputNoLabel.map((f) => [shotThumb(reportDir, f), esc(f.type), esc(f.fieldId), esc(f.name), esc(f.placeholder || '')]);
  const ariaNoAutoRows = r.aria.noAutocomplete.map((f) => [esc(f.field), esc(f.type)]);
  const ariaExpandedBadRows = r.aria.ariaExpandedBad.map((f) => [shotThumb(reportDir, f), esc(f.text)]);
  const ariaDupRows = r.aria.duplicateIds.map((d) => [esc(d)]);

  return `
  <section class="page-report">
    <h2><a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a></h2>
    ${fullShotRel ? `<a href="${esc(fullShotRel)}" target="_blank"><img class="full-shot" src="${esc(fullShotRel)}" alt="Full page screenshot" loading="lazy"></a>` : ''}

    <h3>0 · Axe-core baseline cross-check</h3>
    ${findingsSection('Axe violations', axeRows.length, table(['Rule', 'Impact', 'Help', 'Nodes'], axeRows))}

    <h3>1 · Contrast ratios</h3>
    ${findingsSection('Contrast failures', r.contrast.failures.length,
      table(['Evidence', 'Text', 'Ratio', 'Foreground', 'Background', 'Size / Weight'], contrastRows))}
    ${findingsSection('Manual review — text over image/gradient', r.contrast.manualReview.length,
      table(['Evidence', 'Text', 'Reason'], contrastManualRows), { warn: true })}

    <h3>2 · Keyboard navigation</h3>
    ${findingsSection('Tab order — invisible focus stops', r.keyboard.tabOrder.invisibleStops.length,
      `<p class="meta">Focusable elements found: ${r.keyboard.tabOrder.expectedFocusableCount} · Tab presses run: ${r.keyboard.tabOrder.tabPressesRun}</p>${table(['Stop', 'Tag', 'Name', 'Visible', 'Y'], tabOrderRows)}`)}
    ${findingsSection('Dropdown/toggle keyboard operability', r.keyboard.dropdowns.failingCount,
      table(['Toggle', 'Role', 'Opens (Enter)', 'Closes (Escape)', 'Opens (Space)'], dropdownRows))}
    ${findingsSection('Focusable but hidden (real keyboard traps)', r.keyboard.focusableHidden.focusableButHidden.length,
      table(['Evidence', 'Tag', 'Text', 'Href'], focusableHiddenRows))}
    <p class="meta">Positive tabindex elements (should be 0): ${r.keyboard.focusableHidden.positiveTabindexCount}</p>

    <h3>3 · Focus state verification</h3>
    ${findingsSection('No visible focus indicator at all', r.focusState.noIndicator.length,
      table(['Evidence', 'Tag', 'Element'], focusNoneRows))}
    ${findingsSection('Weak indicator (no outline/box-shadow ring)', r.focusState.weakIndicator.length,
      table(['Evidence', 'Tag', 'Element', 'What changes instead'], focusWeakRows), { warn: true })}

    <h3>4 · Alt text audit</h3>
    ${findingsSection('Missing alt attribute', r.altText.noAttr.length, table(['Evidence', 'Src'], altNoAttrRows))}
    ${findingsSection('Filename used as alt text', r.altText.filenameAsAlt.length, table(['Evidence', 'Alt'], altFilenameRows))}
    ${findingsSection('Linked image with no accessible name', r.altText.linkedNoName.length, table(['Evidence', 'Src'], altLinkedRows))}
    ${findingsSection('Manual review — empty alt (confirm decorative)', r.altText.reviewEmptyAlt.length,
      table(['Evidence', 'File', 'Width', 'Nearest heading', 'In link'], altReviewRows), { warn: true })}
    <p class="meta">Total images on page: ${r.altText.totalImages}</p>

    <h3>5 · Heading hierarchy</h3>
    ${findingsSection('Level skips (e.g. h2 → h4)', r.headings.skips.length,
      `<ul>${r.headings.skips.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)}
    <p class="meta">Empty visible headings: ${r.headings.emptyHeadingsCount} · Visible H1s: ${r.headings.visibleH1Count} · H1 in DOM (incl. hidden): ${r.headings.h1InDomCount} · Page title: ${r.headings.pageTitle ? esc(r.headings.pageTitle) : '<strong class="fail-text">MISSING</strong>'}</p>
    <details class="finding-block"><summary>Visible heading outline</summary><div class="finding-body">${table(['Level', 'Text'], headingRows)}</div></details>

    <h3>6 · ARIA labels on interactive elements</h3>
    ${findingsSection('Interactive element with no accessible name', r.aria.noName.length, table(['Evidence', 'Tag', 'HTML'], ariaNoNameRows))}
    ${findingsSection('2.5.3 Label in Name violations', r.aria.labelInName.length, table(['Evidence', 'Visible text', 'aria-label'], ariaLabelInNameRows))}
    ${findingsSection('Form input with no label', r.aria.inputNoLabel.length, table(['Evidence', 'Type', 'Id', 'Name', 'Placeholder'], ariaInputNoLabelRows))}
    ${findingsSection('1.3.5 Missing autocomplete', r.aria.noAutocomplete.length, table(['Field', 'Type'], ariaNoAutoRows), { warn: true })}
    ${findingsSection('aria-expanded on non-interactive element', r.aria.ariaExpandedBad.length, table(['Evidence', 'Text'], ariaExpandedBadRows))}
    ${findingsSection('4.1.1 Duplicate IDs', r.aria.duplicateIds.length, table(['Id'], ariaDupRows))}
    <p class="meta">Roles in use: ${esc(r.aria.rolesInUse.join(', ') || 'none')} · Landmarks — main: ${r.aria.mainLandmarkCount} · lang: ${r.aria.htmlLang ? esc(r.aria.htmlLang) : '<strong class="fail-text">MISSING</strong>'}</p>
  </section>`;
}

function renderSummary(summary) {
  const rows = Object.entries(summary.totals).map(([key, total]) => [
    esc(key),
    String(total),
    String(summary.perCheckPages[key].length),
  ]);
  return `
  <section class="summary">
    <h2>Executive summary</h2>
    <p class="meta">Pages audited: ${summary.pagesAudited} · Pages errored: ${summary.pagesErrored} · Manual-review items (never counted as failures): ${summary.manualReviewCount}</p>
    ${summary.erroredUrls.length ? `<p class="empty">Errored URLs: ${summary.erroredUrls.map(esc).join(', ')}</p>` : ''}
    ${table(['Check', 'Total findings', 'Pages affected'], rows)}
  </section>`;
}

const STYLE = `
:root { color-scheme: light dark; --fail:#c00; --warn:#a60; --pass:#080; --bg:#fff; --fg:#111; --border:#ddd; }
@media (prefers-color-scheme: dark) { :root { --bg:#14161a; --fg:#eee; --border:#333; } }
body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--fg); margin:0; padding:2rem; line-height:1.45; }
h1 { margin-top:0; }
h2 { border-bottom:2px solid var(--border); padding-bottom:.3rem; margin-top:2.5rem; word-break:break-all; }
h3 { margin-top:1.5rem; }
table { border-collapse: collapse; width:100%; margin:.5rem 0 1rem; font-size:.9rem; }
th, td { border:1px solid var(--border); padding:.4rem .6rem; text-align:left; vertical-align:top; }
th { background: rgba(128,128,128,.12); }
.chip { display:inline-block; padding:.05rem .5rem; border-radius:1rem; font-weight:600; font-size:.85rem; }
.chip.fail { background:var(--fail); color:#fff; }
.chip.warn { background:var(--warn); color:#fff; }
.chip.pass { background:var(--pass); color:#fff; }
.fail-text { color:var(--fail); }
.empty { color:#888; font-style:italic; }
.meta { color:#888; font-size:.9rem; }
.thumb { max-width:220px; max-height:120px; border:1px solid var(--border); border-radius:4px; }
.full-shot { max-width:100%; border:1px solid var(--border); border-radius:6px; margin:.5rem 0 1rem; }
.noshot { color:#888; }
details.finding-block { border:1px solid var(--border); border-radius:6px; margin:.6rem 0; padding:.4rem .8rem; }
details.finding-block summary { cursor:pointer; font-weight:600; }
code { font-size:.85em; }
.page-report.error pre { background:rgba(200,0,0,.08); padding:1rem; overflow:auto; }
nav.toc { margin:1.5rem 0; }
nav.toc a { display:inline-block; margin:.15rem .6rem .15rem 0; }
`;

export async function renderHtmlReport(report, outPath) {
  const reportDir = path.dirname(outPath);
  const toc = report.results
    .map((r, i) => `<a href="#page-${i}">${esc(new URL(r.url).pathname || '/')}</a>`)
    .join('');
  const pages = report.results.map((r, i) => `<div id="page-${i}">${renderPage(reportDir, r)}</div>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(report.siteName)} — Accessibility Audit</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
</head>
<body>
<h1>${esc(report.siteName)} — WCAG 2.1 AA Structured Accessibility Review</h1>
<p class="meta">Generated ${esc(report.generatedAt)} · Scope: SOW S2.3.F (contrast, keyboard navigation, focus states, alt text, heading hierarchy, ARIA labels) · ${report.urls.length} page(s)${report.deviceProfile ? ` · Device: ${esc(report.deviceProfile.label)} ${report.deviceProfile.viewport.width}×${report.deviceProfile.viewport.height} (${esc(report.deviceProfile.emulationLabel)})` : ''}</p>
${renderSummary(report.summary)}
<nav class="toc"><strong>Pages:</strong> ${toc}</nav>
${pages}
</body>
</html>`;

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(outPath, html);
  return outPath;
}
