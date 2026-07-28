import fs from 'node:fs';
import { chromium, webkit } from 'playwright';

// This environment ships a pre-installed Chromium that may not match the
// exact revision the installed `playwright` npm package expects. Prefer it
// explicitly over letting Playwright resolve (and potentially try to
// download) its pinned revision.
const PRE_INSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export const SUPPORTED_ENGINES = ['chromium', 'webkit'];

/**
 * Launches a clean, extension-free browser (equivalent to the SOW doc's
 * "always run in Incognito" rule — no extensions ever inject markup here).
 *
 * @param {'chromium'|'webkit'} [engine] - defaults to chromium. WebKit here
 * is Playwright's own bundled WebKit build, not real Safari — it is real
 * WebKit-engine automation (genuine rendering/JS engine differences show
 * up), but nothing in this codebase may describe it as "Safari" or "a real
 * iPhone" — see deviceProfiles.js's describeEmulation().
 */
export async function launchBrowser(engine = 'chromium') {
  // This environment routes all outbound HTTPS through a local egress proxy
  // (HTTPS_PROXY); neither engine reads that env var on its own, so it must
  // be passed explicitly or every navigation gets reset by the network policy.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const proxy = proxyServer ? { server: proxyServer, bypass: 'localhost,127.0.0.1' } : undefined;

  if (engine === 'webkit') {
    return webkit.launch({ headless: true, proxy });
  }

  const executablePath = fs.existsSync(PRE_INSTALLED_CHROMIUM) ? PRE_INSTALLED_CHROMIUM : undefined;
  const args = ['--force-color-profile=srgb'];
  if (proxyServer) {
    // This sandbox's egress proxy resets connections on Chromium's TLS 1.3
    // ClientHello (the post-quantum Kyber/MLKEM key share extension makes it
    // too large for the proxy's TLS parser). Capping at TLS 1.2 avoids that
    // extension entirely; it's a client-side setting only, not a change to
    // any site being audited.
    args.push('--ssl-version-max=tls1.2');
  }
  return chromium.launch({
    headless: true,
    executablePath,
    proxy,
    args,
  });
}

/**
 * @param {import('./deviceProfiles.js').ResolvedDeviceProfile} [deviceProfile] -
 *   the object resolveDeviceProfile() returns. Passing a bare {width,height}
 *   also works (isMobile/hasTouch/deviceScaleFactor default to desktop-like
 *   values) for callers that only care about viewport size.
 */
export async function newAuditContext(browser, deviceProfile) {
  const viewport = deviceProfile?.viewport || deviceProfile || { width: 1440, height: 900 };
  return browser.newContext({
    viewport,
    deviceScaleFactor: deviceProfile?.deviceScaleFactor ?? 1,
    isMobile: deviceProfile?.isMobile ?? false,
    hasTouch: deviceProfile?.hasTouch ?? false,
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
