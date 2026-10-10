// A fake Resend API on an ephemeral port: /domains (step 9), /emails send + retrieve,
// /emails/receiving list + retrieve + attachments with download URLs served by the fake
// itself (step 10). `state.received` is what the fake will report as received mail; push
// to it with `receive(email)`. Test-only.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export function receivedEmail({ id = `rcv_${randomUUID().slice(0, 8)}`, from = 'customer@example.com', to = ['visitors@makapark.com'], subject = 'Hello', text = 'Hi there', html = '<p>Hi there</p>', messageId = `<${randomUUID()}@example.com>`, headers = {}, attachments = [], createdAt = new Date().toISOString(), cc = [], receivedFor = [] } = {}) {
  return { object: 'email', id, to, from, created_at: createdAt, subject, html, html_format: 'cid', text, headers: { 'message-id': messageId, ...headers }, bcc: [], cc, reply_to: [], received_for: receivedFor, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, message_id: messageId, raw: null, attachments };
}

export const SAMPLE_RECORDS = (domain) => [
  { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'v=spf1 include:amazonses.com ~all' },
  { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC-test' },
  { record: 'MX', name: '@', type: 'MX', ttl: 'Auto', status: 'not_started', value: `inbound.resend.com`, priority: 10 },
].map((r) => ({ ...r, domain }));

export async function startFakeResend({ apiKey = 're_test_key', domains = [] } = {}) {
  const state = { domains: domains.map((d, i) => ({ id: d.id || `dom${i + 1}`, status: 'not_started', region: 'us-east-1', records: SAMPLE_RECORDS(d.name), ...d })), calls: [], emails: [], received: [], files: new Map(), failSend: null };
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
    if (url.pathname.startsWith('/__files/')) {
      const buf = state.files.get(url.pathname.slice('/__files/'.length));
      if (!buf) return send(404, { message: 'no file' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      return res.end(buf);
    }
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
    // ---- sending ----
    if (req.method === 'POST' && url.pathname === '/emails') {
      if (state.failSend) return send(state.failSend.status || 500, { statusCode: state.failSend.status || 500, message: state.failSend.message || 'send failed' });
      if (!body || !body.from || !body.to || !body.subject) return send(422, { statusCode: 422, name: 'validation_error', message: 'from, to and subject are required' });
      const email = { object: 'email', id: `em_${randomUUID().slice(0, 8)}`, message_id: `<${randomUUID()}@resend.dev>`, to: [].concat(body.to), from: body.from, created_at: new Date().toISOString(), subject: body.subject, html: body.html || null, text: body.text || null, bcc: [].concat(body.bcc || []), cc: [].concat(body.cc || []), reply_to: [].concat(body.reply_to || []), last_event: 'sent', scheduled_at: null, tags: body.tags || [], headers: body.headers || {}, idempotencyKey: req.headers['idempotency-key'] || null };
      state.emails.push(email);
      return send(200, { id: email.id });
    }
    const em = /^\/emails\/([^/]+)$/.exec(url.pathname);
    if (em && req.method === 'GET' && em[1] !== 'receiving') {
      const e = state.emails.find((x) => x.id === em[1]);
      return e ? send(200, e) : send(404, { statusCode: 404, message: 'email not found' });
    }
    // ---- receiving ----
    if (req.method === 'GET' && url.pathname === '/emails/receiving') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 100);
      const after = url.searchParams.get('after');
      const before = url.searchParams.get('before');
      let list = [...state.received].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); // newest first
      if (after) {
        const idx = list.findIndex((x) => x.id === after);
        if (idx !== -1) list = list.slice(0, idx);
      }
      if (before) {
        const idx = list.findIndex((x) => x.id === before);
        if (idx !== -1) list = list.slice(idx + 1);
      }
      const page = list.slice(0, limit);
      return send(200, { object: 'list', has_more: list.length > page.length, data: page.map(({ html, text, headers, raw, authentication, html_format, ...rest }) => ({ ...rest, attachments: (rest.attachments || []).map(({ id, filename, content_type, content_id, content_disposition, size }) => ({ id, filename, content_type, content_id, content_disposition, size })) })) });
    }
    const rm = /^\/emails\/receiving\/([^/]+)(?:\/attachments\/([^/]+))?$/.exec(url.pathname);
    if (rm && req.method === 'GET') {
      const e = state.received.find((x) => x.id === rm[1]);
      if (!e) return send(404, { statusCode: 404, message: 'received email not found' });
      if (!rm[2]) return send(200, e);
      const a = (e.attachments || []).find((x) => x.id === rm[2]);
      if (!a) return send(404, { statusCode: 404, message: 'attachment not found' });
      return send(200, { object: 'attachment', id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, content_disposition: a.content_disposition || 'attachment', content_id: a.content_id || null, download_url: `http://127.0.0.1:${server.address().port}/__files/${a.id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const fm = /^\/__files\/([^/]+)$/.exec(url.pathname);
    if (fm && req.method === 'GET') {
      const buf = state.files.get(fm[1]);
      if (!buf) return send(404, { message: 'no file' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      return res.end(buf);
    }
    return send(404, { statusCode: 404, message: 'no route' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    apiKey,
    state,
    // Makes the fake report an email as received; attachments get bytes to download.
    receive(email, files = {}) {
      const e = receivedEmail(email);
      for (const a of e.attachments) if (files[a.id]) state.files.set(a.id, Buffer.from(files[a.id]));
      state.received.push(e);
      return e;
    },
    setLastEvent(id, lastEvent) {
      const e = state.emails.find((x) => x.id === id);
      if (e) e.last_event = lastEvent;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}
