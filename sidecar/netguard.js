// Outbound URL guard (safety review H1, docs/SECURITY_REVIEW_2026-10-10.md): a Ranger's
// network tools (web.fetch, web.read, browser.open, browser.download, and every page the
// browser lands on) may only reach the public internet. Loopback, link-local, the private
// ranges, the unspecified and multicast ranges, `localhost` / `.local` / `.internal`
// names and every address of this machine's own interfaces are refused, after DNS
// resolution, so a public name that resolves to 127.0.0.1 is refused like the literal.
// Without this a Ranger could drive Maka's own routes (approve its own Gate items, edit
// leashes) through its research tools or its browser.
//
//   createNetGuard({ lookup, interfaces, allowLocal })
//     -> { check(url) -> { ok: true, host, addresses } | { ok: false, code, reason },
//          assert(url) (throws NET_GUARD), allowLocal }
//   guardedFetch(url, init, { fetch, guard, maxRedirects }) follows redirects by hand and
//     checks every hop, so a public page cannot bounce a fetch onto the sidecar.
//   isPrivateAddress(ip), isBlockedHostname(host): the pure rules.
//
// `allowLocal: true` turns the guard off. It exists for the test suites, the demo and
// the park check, whose fakes listen on 127.0.0.1; the sidecar never sets it.

import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';

export const DEFAULT_MAX_REDIRECTS = 5;
export const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);

const BLOCKED_NAMES = /^(localhost|ip6-localhost|ip6-loopback|broadcasthost)$/i;
const BLOCKED_SUFFIXES = /\.(localhost|local|internal|intranet|home\.arpa|lan|corp|home)$/i;

function fail(code, reason) {
  const err = new Error(reason);
  err.code = code;
  return err;
}

// Parses an IPv4 dotted quad into its four octets, or null.
function v4Octets(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.some((n) => !Number.isInteger(n) || n > 255) ? null : out;
}

function isPrivateV4(ip) {
  const o = v4Octets(ip);
  if (!o) return true; // unparsable: cannot prove it is public
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (and the cloud metadata address)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 0 && o[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && o[2] === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

// Expands an IPv6 address into eight 16-bit groups; null when it is not one.
function v6Groups(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two groups.
  const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const o = v4Octets(tail[1]);
    if (!o) return null;
    s = `${s.slice(0, tail.index)}:${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? new Array(fill).fill('0') : []), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

function isPrivateV6(ip) {
  const g = v6Groups(ip);
  if (!g) return true;
  const all = g.every((n) => n === 0);
  if (all) return true; // :: unspecified
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1 loopback
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    // IPv4-mapped ::ffff:a.b.c.d: judge the IPv4
    return isPrivateV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  if (g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`); // ::ffff:0:a.b.c.d (SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateV4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`); // 64:ff9b::/96 NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return isPrivateV4(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`); // 6to4 carries an IPv4
  return false;
}

// True for every address that is not plainly on the public internet.
export function isPrivateAddress(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (!s) return true;
  if (net.isIPv4(s)) return isPrivateV4(s);
  if (net.isIPv6(s)) return isPrivateV6(s);
  return true;
}

// True for names that mean "this machine" or "this network" without asking DNS.
export function isBlockedHostname(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_NAMES.test(h)) return true;
  if (BLOCKED_SUFFIXES.test(h)) return true;
  if (!h.includes('.') && !net.isIP(h)) return true; // a bare name resolves through the LAN search list
  return false;
}

// Every address this machine answers on (any port), as a set.
export function localAddresses(interfaces = os.networkInterfaces) {
  const out = new Set();
  let table = {};
  try {
    table = interfaces() || {};
  } catch {
    table = {};
  }
  for (const list of Object.values(table)) for (const entry of list || []) if (entry && entry.address) out.add(String(entry.address).split('%')[0].toLowerCase());
  return out;
}

export function createNetGuard({ lookup = (host, opts) => dns.promises.lookup(host, opts), interfaces = os.networkInterfaces, allowLocal = false } = {}) {
  const guard = {
    allowLocal,
    async check(input) {
      let url;
      try {
        url = input instanceof URL ? input : new URL(String(input));
      } catch {
        return { ok: false, code: 'BAD_URL', reason: `not a valid URL: ${input}` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, code: 'BAD_SCHEME', reason: `only http and https are allowed, got ${url.protocol}` };
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (allowLocal) return { ok: true, host, addresses: [] };
      if (isBlockedHostname(host)) return { ok: false, code: 'NET_GUARD', reason: `${host} is a local name; Rangers may only reach the public internet` };
      let addresses;
      if (net.isIP(host)) addresses = [host];
      else {
        try {
          const found = await lookup(host, { all: true, verbatim: true });
          addresses = (Array.isArray(found) ? found : [found]).map((r) => (typeof r === 'string' ? r : r && r.address)).filter(Boolean);
        } catch (err) {
          return { ok: false, code: 'NET_GUARD', reason: `${host} does not resolve (${err && err.code ? err.code : err && err.message ? err.message : err}); refused` };
        }
        if (!addresses.length) return { ok: false, code: 'NET_GUARD', reason: `${host} resolves to no address; refused` };
      }
      const own = localAddresses(interfaces);
      for (const a of addresses) {
        if (isPrivateAddress(a)) return { ok: false, code: 'NET_GUARD', reason: `${host} resolves to ${a}, a loopback, link-local or private address; Rangers may only reach the public internet` };
        if (own.has(String(a).toLowerCase())) return { ok: false, code: 'NET_GUARD', reason: `${host} resolves to ${a}, one of this machine's own addresses; Rangers may not reach the sidecar's host` };
      }
      return { ok: true, host, addresses };
    },
    async assert(input) {
      const v = await guard.check(input);
      if (!v.ok) throw fail(v.code, v.reason);
      return v;
    },
  };
  return guard;
}

let fallback = null;
// The strict guard a tool uses when its context names none (the sidecar always names one).
export function defaultNetGuard() {
  if (!fallback) fallback = createNetGuard();
  return fallback;
}

// GET with every redirect hop checked by the guard. Resolves with the final Response
// (a 3xx without a Location is returned as is). Throws NET_GUARD / TOO_MANY_REDIRECTS.
// Headers that are a credential or a session for the host they were meant for; a redirect
// onto another host does not get them (safety 2026-10-11 L1: a cross-host redirect from an
// MCP server or a Bot API host would otherwise carry the bearer along).
export const CREDENTIAL_HEADERS = Object.freeze(['authorization', 'proxy-authorization', 'cookie', 'mcp-session-id', 'x-api-key', 'api-key', 'x-auth-token', 'x-goog-api-key', 'x-amz-security-token']);

function plainHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = v;
  else for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = v;
  return out;
}

// The request init for a hop on another host: the credential headers dropped.
export function initWithoutCredentials(init = {}) {
  const headers = plainHeaders(init.headers);
  for (const k of CREDENTIAL_HEADERS) delete headers[k];
  return { ...init, headers };
}

const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
};

export async function guardedFetch(url, init = {}, { fetch: fetchImpl = globalThis.fetch, guard = defaultNetGuard(), maxRedirects = DEFAULT_MAX_REDIRECTS } = {}) {
  let current = url instanceof URL ? url.toString() : String(url);
  const firstHost = hostOf(current);
  for (let hop = 0; ; hop++) {
    await guard.assert(current);
    // The credentials travel to the host they were given for and to no other (L1).
    const hopInit = hostOf(current) === firstHost ? init : initWithoutCredentials(init);
    const res = await fetchImpl(current, { ...hopInit, redirect: 'manual' });
    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    if (!REDIRECT_STATUSES.includes(res.status) || !location) return res;
    if (hop >= maxRedirects) throw fail('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects from ${url}`);
    let next;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw fail('BAD_REDIRECT', `redirect to an invalid location from ${current}`);
    }
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    } catch {
      /* nothing to drain */
    }
    current = next;
  }
}
