import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TextRun,
  ImageRun,
  WidthType,
  ShadingType,
} from 'docx';

const FAIL_SHADE = 'F8D7DA';
const WARN_SHADE = 'FFF3CD';
const PASS_SHADE = 'D4EDDA';

function heading(text, level) {
  return new Paragraph({ text, heading: level });
}

function para(text, opts = {}) {
  return new Paragraph({ children: [new TextRun({ text, ...opts })] });
}

function cell(text, shade) {
  return new TableCell({
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? '') })] })],
  });
}

function dataTable(headers, rows) {
  if (!rows.length) return para('None found.', { italics: true });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((h) => cell(h)) , tableHeader: true}),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
    ],
  });
}

async function imageParagraph(imgPath, maxWidth = 420) {
  try {
    const buffer = await fs.readFile(imgPath);
    // Word needs explicit pixel dims; use a fixed reasonable box (docx v9 auto-scales via width/height only, not aspect-aware),
    // so we cap width and pick a conservative height to avoid distortion complaints on very wide/tall crops.
    return new Paragraph({
      children: [new ImageRun({ data: buffer, transformation: { width: maxWidth, height: Math.round(maxWidth * 0.6) } })],
    });
  } catch (e) {
    return para('(screenshot unavailable)', { italics: true });
  }
}

function countChip(count, warn = false) {
  const shade = count === 0 ? PASS_SHADE : warn ? WARN_SHADE : FAIL_SHADE;
  return { count, shade };
}

async function findingBlock(title, count, rows, headers, warn = false) {
  const { shade } = countChip(count, warn);
  const children = [
    new Paragraph({
      shading: { type: ShadingType.CLEAR, fill: shade },
      children: [new TextRun({ text: `${title} — ${count}`, bold: true })],
    }),
  ];
  children.push(dataTable(headers, rows));
  return children;
}

export async function renderDocxReport(report, outPath) {
  const sections = [];
  const children = [];

  children.push(
    new Paragraph({ text: `${report.siteName} — WCAG 2.1 AA Structured Accessibility Review`, heading: HeadingLevel.TITLE }),
    para(`Generated ${report.generatedAt} · Scope: SOW S2.3.F (contrast, keyboard navigation, focus states, alt text, heading hierarchy, ARIA labels) · ${report.urls.length} page(s)`),
    heading('Executive summary', HeadingLevel.HEADING_1),
    para(`Pages audited: ${report.summary.pagesAudited} · Pages errored: ${report.summary.pagesErrored} · Manual-review items (never counted as failures): ${report.summary.manualReviewCount}`),
    dataTable(
      ['Check', 'Total findings', 'Pages affected'],
      Object.entries(report.summary.totals).map(([k, v]) => [k, String(v), String(report.summary.perCheckPages[k].length)])
    )
  );

  for (const r of report.results) {
    children.push(heading(r.url, HeadingLevel.HEADING_1));
    if (r.error) {
      children.push(para('Audit failed to complete for this URL.', { italics: true }));
      children.push(para(r.error));
      continue;
    }

    if (r.fullPageScreenshot) {
      children.push(await imageParagraph(r.fullPageScreenshot, 500));
    }

    children.push(heading('0 · Axe-core baseline cross-check', HeadingLevel.HEADING_2));
    children.push(
      ...(await findingBlock(
        'Axe violations',
        (r.axe.violations || []).length,
        (r.axe.violations || []).map((v) => [v.rule, v.impact || '', v.help, String(v.nodesCount)]),
        ['Rule', 'Impact', 'Help', 'Nodes']
      ))
    );

    children.push(heading('1 · Contrast ratios', HeadingLevel.HEADING_2));
    children.push(
      ...(await findingBlock(
        'Contrast failures',
        r.contrast.failures.length,
        r.contrast.failures.map((f) => [f.text, `${f.ratio}:1 (needs ${f.needed}:1)`, f.fg, f.bg]),
        ['Text', 'Ratio', 'Foreground', 'Background']
      ))
    );
    for (const f of r.contrast.failures) if (f.screenshot) children.push(await imageParagraph(f.screenshot));
    children.push(
      ...(await findingBlock(
        'Manual review — text over image/gradient',
        r.contrast.manualReview.length,
        r.contrast.manualReview.map((f) => [f.text, f.reason]),
        ['Text', 'Reason'],
        true
      ))
    );

    children.push(heading('2 · Keyboard navigation', HeadingLevel.HEADING_2));
    children.push(para(`Focusable elements found: ${r.keyboard.tabOrder.expectedFocusableCount} · Tab presses run: ${r.keyboard.tabOrder.tabPressesRun}`));
    children.push(
      ...(await findingBlock(
        'Tab order — invisible focus stops',
        r.keyboard.tabOrder.invisibleStops.length,
        r.keyboard.tabOrder.invisibleStops.map((o) => [String(o.stop), o.tag, o.name]),
        ['Stop', 'Tag', 'Name']
      ))
    );
    children.push(
      ...(await findingBlock(
        'Dropdown/toggle keyboard operability',
        r.keyboard.dropdowns.failingCount,
        r.keyboard.dropdowns.results.map((d) => [d.toggle, d.role, d.opensWithEnter ? 'yes' : 'NO', d.closesWithEscape ? 'yes' : 'NO', d.opensWithSpace ? 'yes' : 'NO']),
        ['Toggle', 'Role', 'Opens (Enter)', 'Closes (Escape)', 'Opens (Space)']
      ))
    );
    children.push(
      ...(await findingBlock(
        'Focusable but hidden (real keyboard traps)',
        r.keyboard.focusableHidden.focusableButHidden.length,
        r.keyboard.focusableHidden.focusableButHidden.map((f) => [f.tag, f.text, f.href || '']),
        ['Tag', 'Text', 'Href']
      ))
    );

    children.push(heading('3 · Focus state verification', HeadingLevel.HEADING_2));
    children.push(
      ...(await findingBlock(
        'No visible focus indicator at all',
        r.focusState.noIndicator.length,
        r.focusState.noIndicator.map((f) => [f.tag, f.element]),
        ['Tag', 'Element']
      ))
    );
    for (const f of r.focusState.noIndicator) if (f.screenshot) children.push(await imageParagraph(f.screenshot, 300));
    children.push(
      ...(await findingBlock(
        'Weak indicator (no outline/box-shadow ring)',
        r.focusState.weakIndicator.length,
        r.focusState.weakIndicator.map((f) => [f.tag, f.element, f.indicator]),
        ['Tag', 'Element', 'What changes instead'],
        true
      ))
    );
    for (const f of r.focusState.weakIndicator) if (f.screenshot) children.push(await imageParagraph(f.screenshot, 300));

    children.push(heading('4 · Alt text audit', HeadingLevel.HEADING_2));
    children.push(para(`Total images on page: ${r.altText.totalImages}`));
    children.push(
      ...(await findingBlock('Missing alt attribute', r.altText.noAttr.length, r.altText.noAttr.map((f) => [f.src]), ['Src']))
    );
    children.push(
      ...(await findingBlock('Filename used as alt text', r.altText.filenameAsAlt.length, r.altText.filenameAsAlt.map((f) => [f.alt]), ['Alt']))
    );
    children.push(
      ...(await findingBlock('Linked image with no accessible name', r.altText.linkedNoName.length, r.altText.linkedNoName.map((f) => [f.src]), ['Src']))
    );
    children.push(
      ...(await findingBlock(
        'Manual review — empty alt (confirm decorative)',
        r.altText.reviewEmptyAlt.length,
        r.altText.reviewEmptyAlt.map((f) => [f.file, String(f.widthPx), f.nearestHeading, f.inLink ? 'yes' : 'no']),
        ['File', 'Width', 'Nearest heading', 'In link'],
        true
      ))
    );

    children.push(heading('5 · Heading hierarchy', HeadingLevel.HEADING_2));
    children.push(
      para(
        `Empty visible headings: ${r.headings.emptyHeadingsCount} · Visible H1s: ${r.headings.visibleH1Count} · H1 in DOM (incl. hidden): ${r.headings.h1InDomCount} · Page title: ${r.headings.pageTitle || 'MISSING'}`
      )
    );
    children.push(
      ...(await findingBlock(
        'Level skips',
        r.headings.skips.length,
        r.headings.skips.map((s) => [s]),
        ['Skip']
      ))
    );

    children.push(heading('6 · ARIA labels on interactive elements', HeadingLevel.HEADING_2));
    children.push(
      ...(await findingBlock(
        'Interactive element with no accessible name',
        r.aria.noName.length,
        r.aria.noName.map((f) => [f.tag, f.html]),
        ['Tag', 'HTML']
      ))
    );
    children.push(
      ...(await findingBlock(
        '2.5.3 Label in Name violations',
        r.aria.labelInName.length,
        r.aria.labelInName.map((f) => [f.visible, f.ariaLabel]),
        ['Visible text', 'aria-label']
      ))
    );
    children.push(
      ...(await findingBlock(
        'Form input with no label',
        r.aria.inputNoLabel.length,
        r.aria.inputNoLabel.map((f) => [f.type, f.fieldId, f.name, f.placeholder || '']),
        ['Type', 'Id', 'Name', 'Placeholder']
      ))
    );
    children.push(
      ...(await findingBlock(
        '1.3.5 Missing autocomplete',
        r.aria.noAutocomplete.length,
        r.aria.noAutocomplete.map((f) => [f.field, f.type]),
        ['Field', 'Type'],
        true
      ))
    );
    children.push(
      ...(await findingBlock(
        '4.1.1 Duplicate IDs',
        r.aria.duplicateIds.length,
        r.aria.duplicateIds.map((d) => [d]),
        ['Id']
      ))
    );
    children.push(
      para(
        `Roles in use: ${r.aria.rolesInUse.join(', ') || 'none'} · Landmarks — main: ${r.aria.mainLandmarkCount} · lang: ${r.aria.htmlLang || 'MISSING'}`
      )
    );
  }

  sections.push({ children });
  const doc = new Document({ sections });
  const buffer = await Packer.toBuffer(doc);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buffer);
  return outPath;
}
