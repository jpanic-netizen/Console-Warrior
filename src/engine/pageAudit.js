import path from 'node:path';
import { installDomHelpers } from './domHelpers.js';
import { primePage } from './browser.js';
import { auditAxeBaseline } from './checks/axeBaseline.js';
import { auditContrast } from './checks/contrast.js';
import { auditAltText } from './checks/altText.js';
import { auditHeadings } from './checks/headings.js';
import { auditAriaLabels } from './checks/ariaLabels.js';
import { auditTabOrder, auditDropdownOperability, auditFocusableHidden } from './checks/keyboardNav.js';
import { auditFocusState } from './checks/focusState.js';
import { auditLinkResolution } from './checks/linkResolution.js';
import { auditImageResolution } from './checks/imageResolution.js';
import { auditDeadClicks } from './checks/deadClicks.js';
import { auditSeoMetadata } from './checks/seoMetadata.js';
import { auditPlaceholderText } from './checks/placeholderText.js';
import { classifyConsoleErrors, sourceUrlFromStack } from './checks/consoleErrors.js';
import { captureFullPage, captureHighlightedFindings, captureFocusStateFindings } from './screenshot.js';

function slugForUrl(url) {
  const u = new URL(url);
  const raw = `${u.pathname}`.replace(/\/$/, '') || 'home';
  return raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home';
}

/**
 * Runs the full SOW S2.3.F check set against a single URL in its own page/tab.
 * Read-only checks run first; checks that transiently mutate focus or
 * expanded state run afterward so they never contaminate each other.
 */
export async function auditPage(context, url, opts) {
  const page = await context.newPage();
  const pageOrigin = new URL(url).origin;
  const pageErrors = [];
  const rawConsoleErrors = [];
  page.on('pageerror', (e) => {
    pageErrors.push(String(e));
    rawConsoleErrors.push({ message: String((e && e.message) || e), sourceUrl: sourceUrlFromStack(e && e.stack), kind: 'uncaught' });
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    rawConsoleErrors.push({ message: msg.text(), sourceUrl: loc && loc.url ? loc.url : null, kind: 'console.error' });
  });

  const slug = slugForUrl(url);
  const shotDir = path.join(opts.outDir, 'screenshots');

  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await primePage(page);
  await installDomHelpers(page);

  const axe = await auditAxeBaseline(page)
    .then((violations) => ({ violations }))
    .catch((e) => ({ error: String(e), violations: [] }));
  const contrast = await auditContrast(page);
  const altText = await auditAltText(page);
  const headings = await auditHeadings(page);
  const aria = await auditAriaLabels(page);
  const deadClicks = await auditDeadClicks(page);
  const seo = await auditSeoMetadata(page);
  const placeholderText = await auditPlaceholderText(page);

  // Tab order MUST be recorded before anything else touches real focus.
  // Chromium's sequential focus navigation resumes from wherever focus was
  // last placed even after blur() — it does not reset to the top of the
  // document — so running the dropdown/focus-state checks first would
  // silently corrupt the "Tab from page load" sequence this test relies on.
  const tabOrder = await auditTabOrder(page);
  const dropdowns = await auditDropdownOperability(page);
  const focusableHidden = await auditFocusableHidden(page);
  const focusState = await auditFocusState(page);

  // Issue their own HTTP requests (page.request), independent of DOM/focus
  // state — safe to run anywhere in this read-only phase. Image resolution
  // also scrolls lazy-loaded images into view, which is still a read-only
  // interaction (no clicks, no state mutation), so it's fine alongside the
  // rest of this phase too.
  const linkResolution = await auditLinkResolution(page, { allowHosts: opts.ssrf?.allowHosts });
  const imageResolution = await auditImageResolution(page, { allowHosts: opts.ssrf?.allowHosts });

  await captureFullPage(page, shotDir, slug);
  await captureHighlightedFindings(
    page,
    [
      ...contrast.failures,
      ...contrast.manualReview,
      ...altText.noAttr,
      ...altText.filenameAsAlt,
      ...altText.linkedNoName,
      ...altText.reviewEmptyAlt,
      ...aria.noName,
      ...aria.labelInName,
      ...aria.inputNoLabel,
      ...aria.ariaExpandedBad,
      ...focusableHidden.focusableButHidden,
      ...linkResolution.broken,
      ...imageResolution.broken,
      ...deadClicks.dead,
      ...placeholderText.found,
    ],
    shotDir,
    slug
  );
  await captureFocusStateFindings(page, [...focusState.noIndicator, ...focusState.weakIndicator], shotDir, slug);

  const consoleErrors = classifyConsoleErrors(rawConsoleErrors, pageOrigin);

  await page.close();

  return {
    url,
    slug,
    fullPageScreenshot: path.join(shotDir, `${slug}__full-page.png`),
    pageErrors,
    consoleErrors,
    axe,
    contrast,
    altText,
    headings,
    aria,
    keyboard: { tabOrder, dropdowns, focusableHidden },
    focusState,
    linkResolution,
    imageResolution,
    deadClicks,
    seo,
    placeholderText,
  };
}
