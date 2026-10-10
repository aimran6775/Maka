// A fake Resend API on an ephemeral port. Step 9 covers /domains; later steps add emails,
// receiving and events. Test-only.
import http from 'node:http';

export const SAMPLE_RECORDS = (domain) => [
  { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'v=spf1 include:amazonses.com ~all' },
  { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC-test' },
  { record: 'MX', name: '@', type: 'MX', ttl: 'Auto', status: 'not_started', value: `inbound.resend.com`, priority: 10 },
].map((r) => ({ ...r, domain }));

export async function startFakeResend({ apiKey = 're_test_key', domains = [] } = {}) {
  const state = { domains: domains.map((d, i) => ({ id: d.id || `dom${i + 1}`, status: 'not_started', region: 'us-east-1', records: SAMPLE_RECORDS(d.name), ...d })), calls: [], emails: [], received: [], events: [] };
  let n = state.domains.length;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    state.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { statusCode: 401, name: 'validation_error', message: 'API key is invalid' });
    if (req.method === 'GET' && url.pathname === '/domains') return send(200, { data: state.domains.map(({ records, ...d }) => d) });
    if (req.method === 'POST' && url.pathname === '/domains') {
      if (!body || !body.name) return send(422, { statusCode: 422, message: 'name is required' });
      if (state.domains.some((d) => d.name === body.name)) return send(403, { statusCode: 403, message: 'domain already exists' });
      const d = { id: `dom${++n}`, name: body.name, status: 'not_started', region: body.region || 'us-east-1', records: SAMPLE_RECORDS(body.name), created_at: new Date().toISOString() };
      state.domains.push(d);
      return send(201, d);
    }
    const dm = /^\/domains\/([^/]+)(?:\/(verify))?$/.exec(url.pathname);
    if (dm) {
      const d = state.domains.find((x) => x.id === dm[1]);
      if (!d) return send(404, { statusCode: 404, message: 'domain not found' });
      if (req.method === 'GET' && !dm[2]) return send(200, d);
      if (req.method === 'POST' && dm[2] === 'verify') {
        d.status = 'pending';
        return send(200, { object: 'domain', id: d.id });
      }
    }
    const extra = state.extraRoutes ? await state.extraRoutes(req, url, body, send) : false;
    if (extra) return undefined;
    return send(404, { statusCode: 404, message: 'no route' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    apiKey,
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}
