// Cloudflare DNS for the mail domain (phase 2 step 9).
//
// Resend both receives and sends for makapark.com (docs/KICKOFF_BRIEF.md, Email). The
// records the domain needs come from Resend's own domain API (SPF, DKIM, MX, return-path),
// never from a table here; this module adds the DMARC record Resend does not provide, diffs
// the desired set against the Cloudflare zone and writes the difference. Apply only ever
// runs as an Entrance Gate item (account_settings), see sidecar/mail/setup.js.
//
//   createResendDomains({ apiKey, fetch, baseUrl })  -> { get(domain), create(domain, region), verify(id) }
//   createCloudflare({ token, fetch, baseUrl })       -> { zone(name), records(zoneId), create/update/remove }
//   desiredRecords(resendDomain, { dmarcRua })       pure: Resend's records + DMARC, normalised
//   planDns(desired, existing)                       pure: { create, update, remove, unchanged }
//   applyPlan(cf, zoneId, plan)                      writes the plan; returns counts and errors
//
// Record shape (normalised, both sides): { type, name, content, ttl, priority? }. Names are
// fully qualified and lower-case; TXT content is unquoted. Cloudflare returns `name` as the
// FQDN and TXT content quoted; Resend returns `name` relative to the domain (or "@").

import { errorFromResponse } from '../providers/sse.js';

export const RESEND_BASE_URL = 'https://api.resend.com';
export const CLOUDFLARE_BASE_URL = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_MAIL_DOMAIN = 'makapark.com';
export const DEFAULT_RESEND_REGION = 'us-east-1';

async function json(fetchImpl, url, { method = 'GET', headers = {}, body, name } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    const e = new Error(`${name} network error: ${err && err.message ? err.message : err}`);
    e.code = 'NETWORK';
    throw e;
  }
  if (!res.ok) throw await errorFromResponse(res, name);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error(`${name} returned a non-JSON body`);
    e.code = 'BAD_RESPONSE';
    throw e;
  }
}

// ---- Resend domains ----
export function createResendDomains({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = RESEND_BASE_URL } = {}) {
  if (!apiKey) throw new Error('resend needs an apiKey');
  const headers = { authorization: `Bearer ${apiKey}` };
  const call = (p, opts = {}) => json(fetchImpl, `${baseUrl}${p}`, { ...opts, headers, name: 'resend' });
  return {
    async list() {
      const out = await call('/domains');
      return (out && out.data) || [];
    },
    // The domain record with its DNS records, or null when Resend does not know it.
    async get(domain) {
      const found = (await this.list()).find((d) => d.name === domain);
      if (!found) return null;
      return call(`/domains/${encodeURIComponent(found.id)}`);
    },
    create(domain, region = DEFAULT_RESEND_REGION) {
      return call('/domains', { method: 'POST', body: { name: domain, region } });
    },
    verify(id) {
      return call(`/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' });
    },
  };
}

// ---- Cloudflare ----
export function createCloudflare({ token, fetch: fetchImpl = globalThis.fetch, baseUrl = CLOUDFLARE_BASE_URL } = {}) {
  if (!token) throw new Error('cloudflare needs a token');
  const headers = { authorization: `Bearer ${token}` };
  const call = async (p, opts = {}) => {
    const out = await json(fetchImpl, `${baseUrl}${p}`, { ...opts, headers, name: 'cloudflare' });
    if (out && out.success === false) {
      const e = new Error(`cloudflare: ${(out.errors || []).map((x) => x.message).join('; ') || 'request failed'}`);
      e.code = 'CLOUDFLARE';
      throw e;
    }
    return out ? out.result : null;
  };
  return {
    async zone(name) {
      const zones = await call(`/zones?name=${encodeURIComponent(name)}`);
      return (zones || []).find((z) => z.name === name) || null;
    },
    records: (zoneId) => call(`/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=500`),
    create: (zoneId, record) => call(`/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: 'POST', body: toCloudflare(record) }),
    update: (zoneId, id, record) => call(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, { method: 'PUT', body: toCloudflare(record) }),
    remove: (zoneId, id) => call(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

function toCloudflare(r) {
  const out = { type: r.type, name: r.name, content: r.type === 'TXT' ? `"${r.content}"` : r.content, ttl: r.ttl || 1, proxied: false };
  if (r.type === 'MX') out.priority = r.priority ?? 10;
  return out;
}

// ---- normalisation and the pure plan ----
export function normalizeRecord(r, domain) {
  const type = String(r.type || '').toUpperCase();
  let name = String(r.name || '@').trim().toLowerCase().replace(/\.$/, '');
  if (name === '@' || name === '') name = domain;
  else if (!name.endsWith(domain)) name = `${name}.${domain}`;
  let content = String(r.content ?? r.value ?? '').trim();
  if (type === 'TXT') content = content.replace(/^"(.*)"$/s, '$1');
  if (type === 'MX' || type === 'CNAME') content = content.toLowerCase().replace(/\.$/, '');
  const out = { type, name, content, ttl: Number(r.ttl) > 0 ? Number(r.ttl) : 1 };
  if (type === 'MX') out.priority = Number(r.priority ?? 10);
  return out;
}

// Resend's records for the domain plus DMARC. `rua` is where aggregate reports go.
export function desiredRecords(resendDomain, { domain, dmarcRua = `mailto:gate@${domain}`, dmarcPolicy = 'none' } = {}) {
  const out = [];
  for (const r of (resendDomain && resendDomain.records) || []) out.push({ ...normalizeRecord(r, domain), source: `resend:${r.record || r.type}` });
  if (!out.some((r) => r.type === 'TXT' && r.name === `_dmarc.${domain}`)) {
    out.push({ ...normalizeRecord({ type: 'TXT', name: '_dmarc', content: `v=DMARC1; p=${dmarcPolicy}; rua=${dmarcRua}`, ttl: 3600 }, domain), source: 'maka:dmarc' });
  }
  return out;
}

function same(a, b) {
  return a.type === b.type && a.name === b.name && a.content === b.content && (a.type !== 'MX' || a.priority === b.priority);
}

// Diff desired against existing (both normalised; existing carries `id`). A desired record
// matches an existing one by type + name (+ the SPF prefix for TXT, so other TXT records at
// the same name are left alone). Extra MX records at a name Resend owns are removed, so
// mail is not split between providers.
export function planDns(desired, existing) {
  const plan = { create: [], update: [], remove: [], unchanged: [] };
  const used = new Set();
  const txtKey = (r) => (r.type === 'TXT' ? (r.content.startsWith('v=spf1') ? 'spf' : r.content.startsWith('v=DMARC1') ? 'dmarc' : r.content.startsWith('p=') || /^v=DKIM1/i.test(r.content) ? 'dkim' : 'txt:' + r.content) : '');
  for (const d of desired) {
    const candidates = existing.filter((e) => e.type === d.type && e.name === d.name && !used.has(e.id) && (d.type !== 'TXT' || txtKey(e) === txtKey(d) || (txtKey(d) === 'dkim' && e.name === d.name)));
    const exact = candidates.find((e) => same(e, d));
    if (exact) {
      used.add(exact.id);
      plan.unchanged.push({ ...d, id: exact.id });
      continue;
    }
    const replace = d.type === 'MX' ? null : candidates[0] || null;
    if (replace) {
      used.add(replace.id);
      plan.update.push({ ...d, id: replace.id, previous: replace.content });
    } else plan.create.push(d);
  }
  for (const d of desired.filter((r) => r.type === 'MX')) {
    for (const e of existing.filter((x) => x.type === 'MX' && x.name === d.name && !used.has(x.id))) {
      used.add(e.id);
      plan.remove.push(e);
    }
  }
  return plan;
}

export async function applyPlan(cf, zoneId, plan) {
  const result = { created: 0, updated: 0, removed: 0, errors: [] };
  for (const r of plan.create) {
    try {
      await cf.create(zoneId, r);
      result.created += 1;
    } catch (err) {
      result.errors.push(`create ${r.type} ${r.name}: ${err.message}`);
    }
  }
  for (const r of plan.update) {
    try {
      await cf.update(zoneId, r.id, r);
      result.updated += 1;
    } catch (err) {
      result.errors.push(`update ${r.type} ${r.name}: ${err.message}`);
    }
  }
  for (const r of plan.remove) {
    try {
      await cf.remove(zoneId, r.id);
      result.removed += 1;
    } catch (err) {
      result.errors.push(`remove ${r.type} ${r.name}: ${err.message}`);
    }
  }
  return result;
}

// Everything the plan route needs in one call: Resend's view, the zone, the diff.
export async function planFor({ domain = DEFAULT_MAIL_DOMAIN, resend, cloudflare, region = DEFAULT_RESEND_REGION, dmarcRua } = {}) {
  const zone = await cloudflare.zone(domain);
  if (!zone) {
    const e = new Error(`cloudflare has no zone named ${domain}`);
    e.code = 'NO_ZONE';
    throw e;
  }
  let resendDomain = await resend.get(domain);
  const notes = [];
  if (!resendDomain) notes.push(`${domain} is not registered at Resend yet; apply will create it (region ${region}) and then plan its records`);
  const desired = resendDomain ? desiredRecords(resendDomain, { domain, dmarcRua }) : [];
  const existing = (await cloudflare.records(zone.id)).map((r) => ({ ...normalizeRecord(r, domain), id: r.id }));
  const plan = planDns(desired, existing);
  return { domain, zoneId: zone.id, resend: resendDomain ? { id: resendDomain.id, status: resendDomain.status || null, records: resendDomain.records.length } : null, notes, plan, existing: existing.length };
}
