// A fake S3-compatible store (R2 stand-in) on an ephemeral port that verifies AWS
// Signature V4 on every request with its own small implementation (independent of the
// sidecar's signer), checks the payload hash, and serves PUT / GET / HEAD / DELETE and
// ListObjectsV2 with continuation tokens. Records every call; `fail` makes everything
// answer 500. Test-only.
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const sha = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const enc = (t, keepSlash) => [...String(t)].map((ch) => (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/') ? ch : [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))).join('');

export async function startFakeS3({ accessKeyId = 'AKIAFAKE', secretAccessKey = 'fake-secret', bucket = 'maka-backups', region = 'auto', pageSize = 1000 } = {}) {
  const objects = new Map(); // key -> { body, contentType, metadata, lastModified }
  const state = { calls: [], objects, fail: null, accessKeyId, secretAccessKey, bucket };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, bytes: body.length };
    state.calls.push(rec);
    const send = (status, text = '', headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/xml', ...headers });
      res.end(text);
    };
    const error = (status, code, message) => send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
    if (state.fail) return error(500, 'InternalError', state.fail);
    // --- signature verification ---
    const auth = req.headers.authorization || '';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(auth);
    if (!m) return error(403, 'AccessDenied', 'missing or malformed Authorization');
    const [, keyId, day, reg, signedHeaders, signature] = m;
    if (keyId !== accessKeyId) return error(403, 'InvalidAccessKeyId', 'unknown key id');
    if (reg !== region) return error(403, 'AuthorizationHeaderMalformed', `region ${reg}`);
    const payloadHash = req.headers['x-amz-content-sha256'];
    if (payloadHash !== sha(body)) return error(400, 'XAmzContentSHA256Mismatch', 'payload hash');
    const names = signedHeaders.split(';');
    const canonicalHeaders = names.map((n) => `${n}:${String(n === 'host' ? req.headers.host : req.headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonicalQuery = [...url.searchParams.keys()].sort().map((k) => `${enc(k, false)}=${enc(url.searchParams.get(k), false)}`).join('&');
    const canonical = [req.method, enc(decodeURIComponent(url.pathname), true), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const expected = createHmac('sha256', kSigning).update(sts).digest('hex');
    if (expected !== signature) return error(403, 'SignatureDoesNotMatch', 'signature');
    // --- routing ---
    const parts = decodeURIComponent(url.pathname).replace(/^\//, '').split('/');
    const b = parts.shift();
    const key = parts.join('/');
    if (b !== bucket) return error(404, 'NoSuchBucket', `bucket ${b}`);
    if (req.method === 'HEAD' && !key) return send(200);
    if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get('continuation-token') || 0);
      const page = keys.slice(start, start + pageSize);
      const truncated = start + pageSize < keys.length;
      const xml = `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}${page.map((k) => { const o = objects.get(k); return `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>${o.lastModified}</LastModified><ETag>&quot;${sha(o.body).slice(0, 32)}&quot;</ETag><Size>${o.body.length}</Size></Contents>`; }).join('')}</ListBucketResult>`;
      return send(200, xml);
    }
    if (req.method === 'PUT' && key) {
      const metadata = {};
      for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = v;
      objects.set(key, { body, contentType: req.headers['content-type'] || 'application/octet-stream', metadata, lastModified: new Date().toISOString() });
      return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
    }
    if (req.method === 'GET' && key) {
      const o = objects.get(key);
      if (!o) return error(404, 'NoSuchKey', key);
      const headers = { 'content-type': o.contentType, 'content-length': String(o.body.length) };
      for (const [k, v] of Object.entries(o.metadata)) headers[`x-amz-meta-${k}`] = v;
      res.writeHead(200, headers);
      return res.end(o.body);
    }
    if (req.method === 'DELETE' && key) {
      objects.delete(key);
      return send(204);
    }
    error(400, 'BadRequest', `unsupported ${req.method} ${url.pathname}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); };
  return state;
}
