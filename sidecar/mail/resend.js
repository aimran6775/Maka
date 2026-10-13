// Resend mail (phase 2 step 10): the API client, webhook verification, inbound sync into
// the local store, delivery events, and the send mechanics.
//
//   createResendMail({ apiKey, fetch, baseUrl })
//     -> { send(body), getEmail(id), listReceived({ after, limit }), getReceived(id),
//          getAttachment(emailId, attachmentId), download(url) }
//   verifyWebhook({ secret, headers, body, now, toleranceMs }) -> parsed payload (throws)
//     Svix scheme: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}` with the secret
//     after `whsec_` base64-decoded; `svix-signature` holds space-separated `v1,<base64>`.
//   createMailSync({ store, addresses, getResend, bus, clock, domain, attachmentsLimit })
//     -> { poll(), ingest(received), handleWebhook({ headers, rawBody }), refreshOutbound(),
//          send(message), state() }
//
// Inbound: poll() lists received emails after the persisted cursor (oldest first), fetches
// each with its headers and text, downloads attachments under the size cap, routes every
// recipient on the domain through the address rules (station, venture, agent; unknown →
// visitors@), suppresses senders writing to unsubscribe@, stores the message and emits
// mail.message. The webhook does the same for email.received and turns delivery events
// into mail.event (+ store status; a permanent bounce or a complaint suppresses).
// Outbound: send() drops suppressed recipients, adds the unsubscribe footer and
// List-Unsubscribe header to campaigns, keeps thread headers on replies, posts to Resend,
// stores the copy and emits mail.message. Who may send what, from where and how often is
// policy in sidecar/mail/send.js (step 11); this file is the mechanics.

import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeEvent } from '../../shared/events.js';
import { errorFromResponse } from '../providers/sse.js';
import { normalizeAddress, addressList, refList } from './store.js';
import { RESEND_BASE_URL } from './dns.js';

export const ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
export const DELIVERY_EVENTS = Object.freeze({ 'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delivery_delayed', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.opened': 'opened', 'email.clicked': 'clicked', 'email.failed': 'failed', 'email.suppressed': 'suppressed' });

// D189: what the park will carry out. A ceiling on both the count and the total, because a
// provider rejection halfway through a send is worse than a refusal before it.
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // what Resend accepts per message
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,95}$/;

export function normalizeAttachments(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw fail('BAD_REQUEST', 'attachments must be a list');
  if (list.length > MAX_ATTACHMENTS) throw fail('BAD_REQUEST', `a message carries at most ${MAX_ATTACHMENTS} attachment(s); this one names ${list.length}`);
  let total = 0;
  const out = [];
  for (const a of list) {
    const filename = String((a && a.filename) || '').trim();
    const content = String((a && a.content) || '');
    if (!SAFE_FILENAME.test(filename)) throw fail('BAD_REQUEST', `"${filename}" is not a usable filename: letters, digits, dots, dashes, underscores and spaces, starting with a letter or digit`);
    if (!content) throw fail('BAD_REQUEST', `${filename} has no content`);
    // Base64 only, and proven so by round-tripping it. Checking the character set alone is
    // not enough: `/` and `+` are base64 characters, so "/etc/passwd" passes a charset test
    // — which the test caught. Re-encoding what decodes is the honest check.
    const compact = content.replace(/[\r\n\s]/g, '');
    const roundTrips = compact.length % 4 === 0 && Buffer.from(compact, 'base64').toString('base64') === compact;
    if (!roundTrips) throw fail('BAD_REQUEST', `${filename} must be base64 content, not a path or raw bytes`);
    const bytes = Buffer.from(compact, 'base64').length;
    total += bytes;
    if (total > MAX_ATTACHMENT_BYTES) throw fail('BAD_REQUEST', `the attachments add up to more than ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB, which is more than the provider accepts`);
    out.push({ filename, content: compact, contentType: a && a.contentType ? String(a.contentType) : null, bytes });
  }
  return out;
}

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

async function call(fetchImpl, url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    const e = new Error(`resend network error: ${err && err.message ? err.message : err}`);
    e.code = 'NETWORK';
    throw e;
  }
  if (!res.ok) throw await errorFromResponse(res, 'resend');
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function createResendMail({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = RESEND_BASE_URL } = {}) {
  if (!apiKey) throw new Error('resend needs an apiKey');
  const headers = { authorization: `Bearer ${apiKey}` };
  const api = (p, opts = {}) => call(fetchImpl, `${baseUrl}${p}`, { ...opts, headers });
  return {
    send: (body, { idempotencyKey } = {}) => api('/emails', { method: 'POST', body, headers: idempotencyKey ? { ...headers, 'idempotency-key': idempotencyKey } : headers }),
    getEmail: (id) => api(`/emails/${encodeURIComponent(id)}`),
    listReceived: ({ after, before, limit = 100 } = {}) => {
      const q = new URLSearchParams();
      q.set('limit', String(Math.min(100, Math.max(1, limit))));
      if (after) q.set('after', after);
      if (before) q.set('before', before);
      return api(`/emails/receiving?${q}`);
    },
    getReceived: (id) => api(`/emails/receiving/${encodeURIComponent(id)}?html_format=cid`),
    getAttachment: (emailId, attachmentId) => api(`/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`),
    async download(url, { limit = ATTACHMENT_LIMIT_BYTES } = {}) {
      const res = await fetchImpl(url);
      if (!res.ok) throw await errorFromResponse(res, 'resend download');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > limit) throw fail('TOO_LARGE', `attachment is ${buf.length} bytes; limit ${limit}`);
      return buf;
    },
  };
}

// Svix-style signature check. Returns the parsed JSON payload or throws { code }.
export function verifyWebhook({ secret, headers = {}, body, now = Date.now(), toleranceMs = WEBHOOK_TOLERANCE_MS } = {}) {
  if (!secret) throw fail('NO_SECRET', 'no webhook secret configured (RESEND_WEBHOOK_SECRET)', 503);
  const get = (k) => headers[k] || headers[k.toLowerCase()] || '';
  const id = get('svix-id');
  const ts = get('svix-timestamp');
  const sigHeader = get('svix-signature');
  if (!id || !ts || !sigHeader) throw fail('BAD_SIGNATURE', 'missing svix headers', 400);
  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > toleranceMs) throw fail('BAD_SIGNATURE', 'webhook timestamp outside tolerance', 400);
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  const ok = String(sigHeader).split(/\s+/).some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw fail('BAD_SIGNATURE', 'webhook signature mismatch', 400);
  try {
    return JSON.parse(body);
  } catch {
    throw fail('BAD_SIGNATURE', 'webhook body is not JSON', 400);
  }
}

// Test / tooling helper: signs a body the way Svix does.
export function signWebhook({ secret, body, id = `msg_${Date.now()}`, timestamp = Math.floor(Date.now() / 1000) }) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` };
}

function headerValue(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

export function unsubscribeFooter(address) {
  return `\n\n--\nTo stop receiving these emails, reply with UNSUBSCRIBE or write to ${address}.`;
}

export function createMailSync({ store, addresses, getResend, bus, clock = { now: () => Date.now() }, domain, webhookSecret = null, attachmentsLimit = ATTACHMENT_LIMIT_BYTES, log = console } = {}) {
  if (!store || !addresses || typeof getResend !== 'function' || !bus || !domain) throw new TypeError('createMailSync needs store, addresses, getResend, bus and domain');
  const state = { lastPollAt: null, lastError: null, received: 0, sent: 0, events: 0, polling: false };
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const unsubscribeAddress = `unsubscribe@${domain}`;

  function routeOf(received) {
    const recipients = [...addressList(received.to), ...addressList(received.received_for), ...addressList(received.cc)].map(normalizeAddress);
    const onDomain = recipients.filter((r) => r.endsWith(`@${domain}`));
    const rules = onDomain.map((r) => addresses.resolve(r));
    const first = rules.find((r) => !r.fallback) || rules[0] || addresses.resolve(`visitors@${domain}`);
    return { rule: first, recipients, onDomain };
  }

  async function saveAttachments(resend, received, messageId) {
    const out = [];
    for (const a of received.attachments || []) {
      const entry = { id: a.id, filename: a.filename || a.id, contentType: a.content_type || null, size: a.size || null, contentId: a.content_id || null, path: null, problem: null };
      try {
        if (a.size && a.size > attachmentsLimit) throw fail('TOO_LARGE', `attachment is ${a.size} bytes; limit ${attachmentsLimit}`);
        const meta = await resend.getAttachment(received.id, a.id);
        const buf = await resend.download(meta.download_url, { limit: attachmentsLimit });
        const dir = path.join(store.attachmentsDir, messageId);
        await fsp.mkdir(dir, { recursive: true });
        const safe = path.basename(entry.filename).replace(/[^A-Za-z0-9._-]/g, '_') || a.id;
        const file = path.join(dir, safe);
        await fsp.writeFile(file, buf);
        entry.path = path.relative(store.root, file);
        entry.size = buf.length;
      } catch (err) {
        entry.problem = err.message;
      }
      out.push(entry);
    }
    return out;
  }

  const api = {
    state: () => ({ ...state, cursor: store.cursor().received }),
    // Stores one received email (full object from the receiving API). Returns the record
    // or null when it was already stored.
    async ingest(received, { resend = null } = {}) {
      if (store.byResendId(received.id)) return null;
      const { rule, onDomain } = routeOf(received);
      const from = received.from || '';
      const sender = normalizeAddress(from);
      if (onDomain.includes(unsubscribeAddress) || /^\s*unsubscribe\b/i.test(received.subject || '')) {
        await store.suppress(sender, `asked to unsubscribe (${received.id})`);
      }
      const messageId = `msg-${String(received.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`;
      const attachments = resend ? await saveAttachments(resend, received, messageId) : (received.attachments || []).map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type || null, size: a.size || null, path: null, problem: 'not downloaded' }));
      const record = await store.add({
        id: messageId,
        direction: 'in',
        from,
        to: received.to,
        cc: received.cc,
        replyTo: received.reply_to,
        subject: received.subject || '',
        text: received.text || '',
        html: received.html || '',
        date: Date.parse(received.created_at) || clock.now(),
        messageId: received.message_id || null,
        inReplyTo: headerValue(received.headers, 'in-reply-to') || null,
        references: headerValue(received.headers, 'references').split(/\s+/).filter(Boolean),
        station: rule.station,
        venture: rule.venture || null,
        agentId: rule.agentId || null,
        kind: rule.kind === 'system' ? 'unsubscribe' : 'inbound',
        resendId: received.id,
        attachments,
        headers: received.headers || {},
        labels: rule.fallback ? ['triage'] : [],
      });
      state.received += 1;
      const payload = { messageId: record.id, threadId: record.threadId, direction: 'in', from: record.from, to: record.to, subject: record.subject, station: record.station, attachments: attachments.length, resendId: received.id };
      if (record.venture) payload.venture = record.venture;
      if (record.agentId) payload.agentId = record.agentId;
      payload.kind = record.kind;
      emit('mail.message', payload);
      return record;
    },
    // Pulls everything received after the cursor, oldest first; moves the cursor.
    async poll() {
      if (state.polling) return { received: 0, skipped: 'already polling' };
      state.polling = true;
      try {
        const resend = await getResend();
        // D190: Resend lists received mail NEWEST first, and `after` is its pagination
        // cursor walking *older* — not "newer than this". The park stored the newest id it
        // had seen and asked for everything after it, which Resend read as "older than the
        // newest", and answered with nothing. So inbound mail arrived on the first poll
        // (when there was no cursor) and never again. It took having real inbound mail to
        // see it: the first test message landed, the second never did.
        //
        // The shape that works with a newest-first list: walk back until something already
        // held turns up, then ingest what is new oldest-first so a reply can find the
        // message it answers.
        const seen = store.cursor().received || null;
        const fresh = [];
        let newest = null;
        let after;
        let caughtUp = false;
        for (let page = 0; page < 20 && !caughtUp; page++) {
          const list = await resend.listReceived({ after, limit: 100 });
          const items = list.data || []; // newest first, as the provider sends it
          if (!items.length) break;
          if (!newest) newest = items[0].id;
          for (const item of items) {
            // Two ways to know we have caught up: the cursor, and the message itself. The
            // second covers a cursor lost to a restore or a message ingested by the webhook.
            if ((seen && item.id === seen) || store.byResendId(item.id)) {
              caughtUp = true;
              break;
            }
            fresh.push(item);
          }
          if (caughtUp || !list.has_more) break;
          after = items[items.length - 1].id; // the next page is older
        }
        // Ingest oldest first, by each message's own date rather than by the list's order,
        // so a reply always finds the message it answers however the provider paginates.
        fresh.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        let received = 0;
        for (const { id } of fresh) {
          const full = await resend.getReceived(id);
          const rec = await api.ingest(full, { resend });
          if (rec) received += 1;
        }
        if (newest) await store.setCursor(newest);
        state.lastPollAt = clock.now();
        state.lastError = null;
        return { received };
      } catch (err) {
        state.lastError = err.message;
        state.lastPollAt = clock.now();
        throw err;
      } finally {
        state.polling = false;
      }
    },
    // Resend webhook: verifies the signature, ingests received mail, records delivery events.
    async handleWebhook({ headers, rawBody, secret = webhookSecret }) {
      const payload = verifyWebhook({ secret, headers, body: rawBody, now: clock.now() });
      const type = payload.type;
      const data = payload.data || {};
      if (type === 'email.received') {
        const resend = await getResend();
        const full = await resend.getReceived(data.email_id);
        const rec = await api.ingest(full, { resend });
        return { type, stored: Boolean(rec), messageId: rec ? rec.id : null };
      }
      const event = DELIVERY_EVENTS[type];
      if (!event) return { type, ignored: true };
      return api.recordEvent({ resendId: data.email_id, event, to: addressList(data.to), detail: data.bounce ? `${data.bounce.type || ''} ${data.bounce.subType || ''}: ${data.bounce.message || ''}`.trim() : '', bounceType: data.bounce ? data.bounce.type : null });
    },
    async recordEvent({ resendId, event, to = [], detail = '', bounceType = null }) {
      const s = await store.setStatus({ resendId, status: event, event, detail });
      let suppressed = false;
      if ((event === 'bounced' && bounceType !== 'Temporary') || event === 'complained') {
        for (const a of to) {
          await store.suppress(a, `${event}${detail ? `: ${detail}` : ''}`);
          suppressed = true;
        }
      }
      state.events += 1;
      const payload = { resendId, event, detail, suppressed };
      if (s) payload.messageId = s.id;
      if (to.length) payload.address = to.join(', ');
      emit('mail.event', payload);
      return { type: event, messageId: s ? s.id : null, suppressed };
    },
    // Without webhooks, ask Resend for the last event of recent sends still in flight.
    async refreshOutbound({ limit = 50 } = {}) {
      const resend = await getResend();
      const pending = store.list({ direction: 'out', limit }).filter((m) => m.resendId && ['sent', 'queued', 'delivery_delayed'].includes(m.status || 'sent'));
      let changed = 0;
      for (const m of pending) {
        try {
          const email = await resend.getEmail(m.resendId);
          const last = email && email.last_event;
          if (last && last !== m.status) {
            await api.recordEvent({ resendId: m.resendId, event: DELIVERY_EVENTS[`email.${last}`] || last, to: m.to, detail: 'from status poll' });
            changed += 1;
          }
        } catch (err) {
          log.error('resend status refresh failed:', err.message);
        }
      }
      return { checked: pending.length, changed };
    },
    // The send mechanics. `kind`: reply | notification | campaign. Returns the stored copy.
    async send({ from, to, cc, subject, text, html, inReplyTo, references, kind = 'reply', station, venture, agentId, tags, replyTo, idempotencyKey, attachments } = {}) {
      if (!from || !addressList(to).length || !subject) throw fail('BAD_REQUEST', 'send needs from, to and subject');
      if (!station) throw fail('BAD_REQUEST', 'send needs the sending station');
      const wanted = addressList(to);
      const recipients = wanted.filter((a) => !store.isSuppressed(a));
      const dropped = wanted.filter((a) => store.isSuppressed(a));
      if (!recipients.length) throw fail('SUPPRESSED', `every recipient is suppressed: ${dropped.join(', ')}`, 422);
      let bodyText = text || '';
      let bodyHtml = html || '';
      const headers = {};
      if (kind === 'campaign') {
        bodyText += unsubscribeFooter(unsubscribeAddress);
        if (bodyHtml) bodyHtml += `<p style="color:#777;font-size:12px">To stop receiving these emails, reply with UNSUBSCRIBE or write to <a href="mailto:${unsubscribeAddress}">${unsubscribeAddress}</a>.</p>`;
        headers['List-Unsubscribe'] = `<mailto:${unsubscribeAddress}?subject=unsubscribe>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
      const refs = refList(references);
      if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);
      if (refs.length) headers.References = refs.join(' ');
      // D189: files on the way out. Resend takes each as base64 `content` with a filename;
      // the park checks the count and the total before it builds the request, so a mistake
      // is a plain refusal rather than a provider error a Ranger cannot read.
      const files = normalizeAttachments(attachments);
      const body = { from, to: recipients, subject, text: bodyText };
      if (files.length) body.attachments = files.map((a) => ({ filename: a.filename, content: a.content, ...(a.contentType ? { content_type: a.contentType } : {}) }));
      if (bodyHtml) body.html = bodyHtml;
      if (cc && addressList(cc).length) body.cc = addressList(cc);
      if (replyTo) body.reply_to = replyTo;
      if (Object.keys(headers).length) body.headers = headers;
      if (tags && tags.length) body.tags = tags;
      const resend = await getResend();
      const out = await resend.send(body, { idempotencyKey });
      // D189: the sent record names what went with it — the filenames and sizes, never the
      // bytes. The park's own copy of a file it sent is not worth the disk, and the Sent
      // folder showing a list of what was attached is what a reader wants.
      const record = await store.add({ direction: 'out', from, to: recipients, cc: body.cc, subject, text: bodyText, html: bodyHtml, inReplyTo: inReplyTo || null, references: refs, station, venture, agentId, kind, resendId: out && out.id ? out.id : null, status: 'sent', headers, labels: dropped.length ? ['partial'] : [], attachments: files.map((a) => ({ filename: a.filename, size: a.bytes, contentType: a.contentType || null, outbound: true })) });
      state.sent += 1;
      const payload = { messageId: record.id, threadId: record.threadId, direction: 'out', from, to: recipients, subject, station, kind };
      if (venture) payload.venture = venture;
      if (agentId) payload.agentId = agentId;
      if (record.resendId) payload.resendId = record.resendId;
      emit('mail.message', payload);
      return { ...record, dropped };
    },
  };
  return api;
}
