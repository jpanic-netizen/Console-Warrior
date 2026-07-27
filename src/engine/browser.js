import fs from 'node:fs';
import { chromium } from 'playwright';

// This environment ships a pre-installed Chromium that may not match the
// exact revision the installed `playwright` npm package expects. Prefer it
// explicitly over letting Playwright resolve (and potentially try to
// download) its pinned revision.
const PRE_INSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Launches a clean, extension-free browser (equivalent to the SOW doc's
 * "always run in Incognito" rule — no extensions ever inject markup here).
 */
export async function launchBrowser() {
  const executablePath = fs.existsSync(PRE_INSTALLED_CHROMIUM) ? PRE_INSTALLED_CHROMIUM : undefined;
  return chromium.launch({ headless: true, executablePath, args: ['--force-color-profile=srgb'] });
}

export async function newAuditContext(browser, viewport) {
  return browser.newContext({
    viewport: viewport || { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
}

/** Scrolls the full page height so lazy-loaded content is present in the DOM before checks run. */
export async function primePage(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const height = document.body.scrollHeight;
    for (let y = 0; y < height; y += 700) {
      window.scrollTo(0, y);
      await delay(60);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(150);
}
