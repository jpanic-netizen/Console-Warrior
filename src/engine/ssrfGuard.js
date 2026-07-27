/**
 * Blocks the audit engine from being used as an SSRF proxy: a hosted
 * dashboard that lets anyone type a URL and makes a real server-side
 * browser fetch it is exactly the shape of vulnerability that reaches
 * cloud metadata endpoints (169.254.169.254), internal admin panels, or
 * other hosts on the deploying network that were never meant to be public.
 *
 * Two layers, both real (not just cosmetic):
 *  - `assertSafeTarget` — checked once per submitted URL, before a job is
 *    even created. Cheap early rejection for the common case.
 *  - `installSsrfGuard` — a Playwright `context.route()` handler, checked
 *    on every single request the browser makes for the lifetime of the
 *    context: the initial navigation, every subresource, and — critically —
 *    every hop of a redirect chain. A URL that passes the submission-time
 *    check but redirects to an internal address is still caught here.
 *
 * Residual risk (documented, not solved): DNS rebinding. Both layers
 * resolve the hostname fresh via Node's resolver and check the result, but
 * there is an unavoidable small window between that check and the moment
 * Chromium's own network stack actually opens the TCP connection, during
 * which a very-low-TTL DNS record could theoretically flip from a public
 * IP to a private one. Fully closing that gap needs a custom DNS-pinning
 * resolver/proxy in front of Chromium, which is out of scope here. This
 * guard defeats the straightforward attack (submit a private URL directly,
 * or redirect to one) but is not a hard guarantee against an adversary who
 * controls DNS timing.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// RFC 1918 / loopback / link-local / CGNAT / "this network" / multicast+reserved / cloud metadata.
const PRIVATE_V4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function isPrivateIPv4(ip) {
  return PRIVATE_V4_CIDRS.some((cidr) => inCidr4(ip, cidr));
}

function isPrivateIPv6(ip) {
  const norm = ip.toLowerCase();
  if (norm === '::1' || norm === '::') return true;
  if (norm.startsWith('::ffff:')) {
    const v4 = norm.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  // Unique local (fc00::/7) and link-local (fe80::/10).
  return /^(fc|fd)/.test(norm) || /^fe[89ab]/.test(norm);
}

function isPrivateIP(ip) {
  return net.isIPv4(ip) ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

/**
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkTargetSafety(urlString, { allowHosts = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${urlString}` };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `Only http/https URLs are allowed (got "${parsed.protocol}"): ${urlString}` };
  }
  // WHATWG URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]"),
  // but net.isIP()/our range checks expect the bare address.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (allowHosts.includes(hostname)) return { ok: true };

  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      return { ok: false, reason: `${urlString} resolves to a private/internal address (${hostname}) and cannot be audited.` };
    }
    return { ok: true };
  }

  if (hostname === 'localhost') {
    return { ok: false, reason: `${urlString} targets localhost, which is blocked.` };
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    return { ok: false, reason: `Could not resolve hostname "${hostname}": ${e.message}` };
  }
  const privateHit = addresses.find((a) => isPrivateIP(a.address));
  if (privateHit) {
    return { ok: false, reason: `${urlString} (${hostname}) resolves to a private/internal address (${privateHit.address}) and cannot be audited.` };
  }
  return { ok: true };
}

export async function assertSafeTarget(urlString, opts) {
  const result = await checkTargetSafety(urlString, opts);
  if (!result.ok) throw new Error(result.reason);
}

/**
 * Installs a per-request guard on a Playwright BrowserContext. Blocks the
 * request (and therefore the navigation/redirect/subresource load it backs)
 * if the URL fails the same safety check — checked fresh on every request,
 * so redirect chains can't launder an unsafe destination through an
 * initially-safe one.
 */
export function installSsrfGuard(context, opts) {
  return context.route('**/*', async (route) => {
    const result = await checkTargetSafety(route.request().url(), opts).catch((e) => ({ ok: false, reason: String(e) }));
    if (!result.ok) {
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}
