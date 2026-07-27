import fs from 'node:fs/promises';
import path from 'node:path';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Screenshots a small padded region around `target` instead of its exact
 * bounding box. A plain element.screenshot() clips precisely to the
 * element's border box, which cuts off the injected highlight outline
 * (drawn with a positive outline-offset so it doesn't distort layout) —
 * padding the crop keeps the highlight visible as evidence.
 */
async function paddedClipScreenshot(page, target, filePath, pad = 14) {
  const box = await target.boundingBox();
  if (!box) {
    await target.screenshot({ path: filePath, timeout: 8000 });
    return;
  }
  const viewport = page.viewportSize() || { width: box.x + box.width, height: box.y + box.height };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const width = Math.min(viewport.width - x, box.width + pad * 2);
  const height = Math.min(viewport.height - y, box.height + pad * 2);
  await page.screenshot({ path: filePath, clip: { x, y, width, height }, timeout: 8000 });
}

export async function captureFullPage(page, shotDir, slug) {
  await ensureDir(shotDir);
  const filePath = path.join(shotDir, `${slug}__full-page.png`);
  await page.screenshot({ path: filePath, fullPage: true, timeout: 15000 }).catch(() => null);
  return filePath;
}

/**
 * Captures one cropped screenshot per finding, identified by the element's
 * `data-cw-id` tag set during the check pass. A temporary red outline is
 * drawn so the offending element is unambiguous in the crop, then removed —
 * this is purely an evidence aid and never affects the underlying check.
 */
export async function captureHighlightedFindings(page, findings, shotDir, slug) {
  await ensureDir(shotDir);
  for (const finding of findings) {
    if (!finding.id) continue;
    const locator = page.locator(`[data-cw-id~="${finding.id}"]`);
    // eslint-disable-next-line no-await-in-loop
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const target = locator.first();
    try {
      // eslint-disable-next-line no-await-in-loop
      await target.scrollIntoViewIfNeeded({ timeout: 3000 });
      // eslint-disable-next-line no-await-in-loop
      await target.evaluate((el) => {
        el.dataset.cwPrevOutline = el.style.outline;
        el.dataset.cwPrevOutlineOffset = el.style.outlineOffset;
        el.style.outline = '3px solid #ff2d55';
        el.style.outlineOffset = '2px';
      });
      const filePath = path.join(shotDir, `${slug}__${finding.id}.png`);
      // eslint-disable-next-line no-await-in-loop
      await paddedClipScreenshot(page, target, filePath);
      finding.screenshot = filePath;
    } catch (e) {
      // Element may be off-screen/unreachable (e.g. inside a closed dropdown) — skip evidence, keep the finding.
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await target
        .evaluate((el) => {
          el.style.outline = el.dataset.cwPrevOutline || '';
          el.style.outlineOffset = el.dataset.cwPrevOutlineOffset || '';
          delete el.dataset.cwPrevOutline;
          delete el.dataset.cwPrevOutlineOffset;
        })
        .catch(() => {});
    }
  }
}

/**
 * For focus-state findings specifically: captures the *actual* rendered
 * focus state (real .focus(), no injected outline) — that genuine rendering
 * (or lack of change) IS the evidence for this check.
 */
export async function captureFocusStateFindings(page, findings, shotDir, slug) {
  await ensureDir(shotDir);
  for (const finding of findings) {
    if (!finding.id) continue;
    const locator = page.locator(`[data-cw-id~="${finding.id}"]`);
    // eslint-disable-next-line no-await-in-loop
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const target = locator.first();
    try {
      // eslint-disable-next-line no-await-in-loop
      await target.scrollIntoViewIfNeeded({ timeout: 3000 });
      // eslint-disable-next-line no-await-in-loop
      await target.focus({ timeout: 3000 });
      const filePath = path.join(shotDir, `${slug}__${finding.id}.png`);
      // eslint-disable-next-line no-await-in-loop
      await paddedClipScreenshot(page, target, filePath);
      finding.screenshot = filePath;
    } catch (e) {
      // ignore — keep the finding without evidence rather than failing the run
    }
  }
}
