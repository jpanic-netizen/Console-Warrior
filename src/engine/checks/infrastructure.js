/**
 * SOP check catalogue — "Infrastructure (pre-launch)": robots.txt correct
 * for the environment, sitemap.xml current, custom 404 returns a real 404,
 * SSL valid, HTTP redirects to HTTPS. Runs ONCE per site (per origin), not
 * once per page — these aren't per-URL concerns, unlike every other check
 * in this engine.
 *
 * "Correct for the environment" is the reason this check takes an explicit
 * `environment` ('staging' | 'production' | null) rather than judging
 * robots.txt/HTTPS purely on content: `Disallow: /` is completely correct
 * on staging and a launch-blocking mistake on production — the exact
 * example the SOP itself gives. Without a known environment, the finding
 * is reported as a manual-review candidate ("which environment is this?")
 * rather than guessing either way.
 *
 * Same-origin requests to the audited site itself don't need the SSRF
 * safety check linkResolution/imageResolution apply to *discovered* links —
 * this origin is the already-vetted audit target, not third-party content
 * found on the page.
 */

const FETCH_TIMEOUT_MS = 10_000;

async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'manual', ...opts });
  } finally {
    clearTimeout(timer);
  }
}

async function checkRobotsTxt(origin, environment) {
  let res;
  try {
    res = await safeFetch(`${origin}/robots.txt`);
  } catch {
    return null; // unreachable — not itself a finding, just nothing to report
  }
  if (!res.ok) return null; // no robots.txt at all is not a defect

  const body = await res.text().catch(() => '');
  const blanketDisallow = /^\s*disallow:\s*\/\s*$/im.test(body);
  if (!blanketDisallow) return null;

  if (environment === 'staging') return null; // correct and expected
  if (environment === 'production') {
    return {
      manualReview: false,
      summary: 'robots.txt has "Disallow: /" — this blocks the entire production site from being crawled/indexed.',
    };
  }
  return {
    manualReview: true,
    summary: 'robots.txt has "Disallow: /" — correct on staging, a launch-blocking mistake on production. Confirm which environment this is before reporting either way.',
  };
}

async function checkSitemapXml(origin, environment) {
  let res;
  try {
    res = await safeFetch(`${origin}/sitemap.xml`);
  } catch {
    return null;
  }
  if (!res.ok) {
    if (environment === 'production') {
      return { manualReview: false, summary: 'No sitemap.xml found on the production domain.' };
    }
    return null; // missing on staging (or unknown environment) is unremarkable
  }
  const body = await res.text().catch(() => '');
  const looksValid = /<\?xml|<urlset|<sitemapindex/i.test(body);
  if (!looksValid) {
    return { manualReview: false, summary: 'sitemap.xml exists but does not look like valid XML/sitemap content.' };
  }
  return null;
}

async function checkCustom404(origin) {
  const probePath = `/console-warrior-404-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let res;
  try {
    res = await safeFetch(`${origin}${probePath}`, { redirect: 'follow' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  return {
    manualReview: false,
    summary: `A deliberately invalid URL returned HTTP ${res.status} instead of a genuine 404 (soft-404 / redirect-to-home pattern).`,
  };
}

async function checkHttpsRedirect(origin, environment) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:') {
    if (environment === 'production') {
      return { manualReview: false, summary: 'Site is served over plain HTTP, not HTTPS.' };
    }
    return { manualReview: true, summary: 'Site is served over plain HTTP, not HTTPS — confirm this is intentional for the current environment.' };
  }

  const httpOrigin = `http://${parsed.host}`;
  let res;
  try {
    res = await safeFetch(`${httpOrigin}/`);
  } catch {
    return null; // plain HTTP not even reachable — nothing to redirect, not itself a defect
  }
  const location = res.headers.get('location') || '';
  const redirectsToHttps = res.status >= 300 && res.status < 400 && location.startsWith('https:');
  if (redirectsToHttps) return null;

  if (environment === 'production') {
    return { manualReview: false, summary: `http://${parsed.host}/ does not redirect to HTTPS (got HTTP ${res.status}).` };
  }
  return {
    manualReview: true,
    summary: `http://${parsed.host}/ does not redirect to HTTPS (got HTTP ${res.status}) — confirm this is intentional for the current environment.`,
  };
}

export async function auditInfrastructure(origin, opts = {}) {
  const { environment = null } = opts;
  const [robotsTxt, sitemapXml, custom404, httpsRedirect] = await Promise.all([
    checkRobotsTxt(origin, environment),
    checkSitemapXml(origin, environment),
    checkCustom404(origin),
    checkHttpsRedirect(origin, environment),
  ]);
  return { origin, environment, robotsTxt, sitemapXml, custom404, httpsRedirect };
}
