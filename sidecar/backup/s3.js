// An S3-compatible client for Cloudflare R2 with core modules only (phase 3 step 5):
// AWS Signature Version 4 over `fetch`, path-style URLs, five calls: head bucket, put,
// get, delete, list (ListObjectsV2). R2's endpoint is
// `https://<accountId>.r2.cloudflarestorage.com`, region `auto`.
//
// `signV4` is pure (the request parts and a clock in, the headers out) so the signing
// math is checked against AWS's published example in test/backup.test.js.

import { createHash, createHmac } from 'node:crypto';

export const R2_REGION = 'auto';
export const S3_SERVICE = 's3';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function r2Endpoint(accountId) {
  if (!/^[a-f0-9]{32}$/i.test(String(accountId || ''))) throw new Error('CLOUDFLARE_ACCOUNT_ID must be the 32-hex account id');
  return `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
}

// S3's URI encoding: RFC 3986 unreserved characters pass, '/' stays, the rest is %XX.
export function uriEncode(text, { keepSlash = true } = {}) {
  let out = '';
  for (const ch of String(text)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function amzDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Signs one request. `headers` must already include `host` and whatever else is to be
// signed; `x-amz-date` and `x-amz-content-sha256` are added here. Returns the headers
// with `authorization`.
export function signV4({ method, path, query = {}, headers = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, region = R2_REGION, service = S3_SERVICE, now = Date.now() }) {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const all = {};
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  all['x-amz-date'] = date;
  all['x-amz-content-sha256'] = payloadHash;
  const signedHeaders = Object.keys(all).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${all[k]}\n`).join('');
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k, { keepSlash: false })}=${uriEncode(query[k], { keepSlash: false })}`).join('&');
  const canonicalRequest = [method.toUpperCase(), uriEncode(path), canonicalQuery, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  return { headers: all, canonicalRequest, stringToSign, signature };
}

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

// Minimal XML field reader for ListObjectsV2 answers (no XML library in core).
export function parseList(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const get = (tag) => { const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block); return r ? r[1] : null; };
    items.push({ key: decodeXml(get('Key') || ''), size: Number(get('Size') || 0), lastModified: get('LastModified'), etag: (get('ETag') || '').replace(/&quot;|"/g, '') });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { items, truncated, nextToken: token ? decodeXml(token[1]) : null };
}
const decodeXml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function createS3({ endpoint, bucket, accessKeyId, secretAccessKey, region = R2_REGION, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, timeoutMs = 120_000 } = {}) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new TypeError('createS3 needs endpoint, bucket, accessKeyId and secretAccessKey');
  const base = endpoint.replace(/\/+$/, '');
  const host = new URL(base).host;

  async function call(method, key, { query = {}, body = null, headers = {} } = {}) {
    const path = `/${bucket}${key ? `/${key}` : ''}`;
    const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
    const payloadHash = payload ? sha256Hex(payload) : EMPTY_SHA256;
    const signed = signV4({ method, path, query, headers: { host, ...headers }, payloadHash, accessKeyId, secretAccessKey, region, now: clock.now() });
    const qs = Object.keys(query).length ? `?${Object.keys(query).sort().map((k) => `${uriEncode(k, { keepSlash: false })}=${uriEncode(query[k], { keepSlash: false })}`).join('&')}` : '';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      const { host: _h, ...sendHeaders } = signed.headers;
      res = await fetchImpl(`${base}${uriEncode(path)}${qs}`, { method, headers: sendHeaders, body: payload || undefined, signal: ac.signal });
    } catch (err) {
      throw fail('NETWORK', `R2 ${method} ${key || bucket}: ${err && err.name === 'AbortError' ? 'timeout' : err.message}`);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text);
      const msg = /<Message>([^<]+)<\/Message>/.exec(text);
      throw fail(`HTTP_${res.status}`, `R2 ${method} ${key || bucket} answered ${res.status}${code ? ` ${code[1]}` : ''}${msg ? `: ${msg[1]}` : ''}`, res.status);
    }
    return res;
  }

  return {
    bucket,
    endpoint: base,
    async headBucket() {
      await call('HEAD', '');
      return { ok: true, bucket };
    },
    async put(key, body, { contentType = 'application/octet-stream', metadata = {} } = {}) {
      const headers = { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) };
      for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
      const res = await call('PUT', key, { body, headers });
      return { key, etag: (res.headers.get('etag') || '').replace(/"/g, ''), bytes: Buffer.byteLength(body) };
    },
    async get(key) {
      const res = await call('GET', key);
      const meta = {};
      res.headers.forEach((v, k) => { if (k.startsWith('x-amz-meta-')) meta[k.slice('x-amz-meta-'.length)] = v; });
      return { key, body: Buffer.from(await res.arrayBuffer()), metadata: meta, contentType: res.headers.get('content-type') };
    },
    async delete(key) {
      await call('DELETE', key);
      return { key, deleted: true };
    },
    async list(prefix = '', { max = 1000 } = {}) {
      const items = [];
      let token = null;
      for (let page = 0; page < 20; page++) {
        const query = { 'list-type': '2', 'max-keys': String(Math.min(max, 1000)), prefix };
        if (token) query['continuation-token'] = token;
        const res = await call('GET', '', { query });
        const parsed = parseList(await res.text());
        items.push(...parsed.items);
        if (!parsed.truncated || !parsed.nextToken || items.length >= max) break;
        token = parsed.nextToken;
      }
      return items.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
