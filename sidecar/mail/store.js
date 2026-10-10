// The local mail store (phase 2 step 10): messages, threads, labels, venture tags, station
// ownership, the suppression list and the receiving cursor, under <workspaceRoot>/_mail/.
//
//   createMailStore({ root, clock }) -> { init(), add(message), get(id), list(filter),
//     threads(filter), thread(threadId), setLabels(id, { add, remove }), setStatus(...),
//     byMessageId(mid), byResendId(rid), suppress(address, reason), unsuppress(address),
//     isSuppressed(address), suppressions(), cursor(), setCursor(id), search(q), counts() }
//
// Layout on disk (every write atomic, see sidecar/store.js writeJsonAtomic):
//   index.json             summaries of every message, oldest first (bounded)
//   messages/<id>.json     the full message (bodies, headers, attachment list)
//   attachments/<id>/...   downloaded attachment files
//   suppression.json       { address: { reason, at } }
//   cursor.json            { received: <last Resend received id>, at }
// A message is { id, threadId, direction: 'in'|'out', from, to[], cc[], replyTo[], subject,
// text, html, date, messageId, inReplyTo, references[], station, venture, agentId, kind,
// resendId, status, labels[], attachments[], classification, headers }.
// Threading: a message joins the thread of any stored message whose Message-ID it names in
// In-Reply-To or References; otherwise it starts a thread. Station ownership is the zone
// id the address routes to (sidecar/mail/addresses.js).

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic, readJson } from '../store.js';

const INDEX_LIMIT = 20000;
const SNIPPET = 160;

export function normalizeAddress(a) {
  if (!a) return '';
  const m = /<([^>]+)>/.exec(String(a));
  return (m ? m[1] : String(a)).trim().toLowerCase();
}

export function addressList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((a) => String(a).trim()).filter(Boolean);
}

// Message-ID lists (References) are whitespace separated; commas are tolerated.
export function refList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
  return arr.map((a) => String(a).trim()).filter(Boolean);
}

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createMailStore({ root, clock = { now: () => Date.now() } } = {}) {
  if (!root) throw new TypeError('createMailStore needs root');
  const indexFile = path.join(root, 'index.json');
  const suppressionFile = path.join(root, 'suppression.json');
  const cursorFile = path.join(root, 'cursor.json');
  const messagesDir = path.join(root, 'messages');
  const attachmentsDir = path.join(root, 'attachments');
  let index = []; // summaries
  let suppression = {};
  let cursor = { received: null, at: 0 };
  let saving = Promise.resolve();
  const save = (file, data) => {
    saving = saving.then(() => writeJsonAtomic(file, data)).catch((err) => console.error('mail store save failed:', err));
    return saving;
  };
  const summaryOf = (m) => ({ id: m.id, threadId: m.threadId, direction: m.direction, from: m.from, to: m.to, subject: m.subject, date: m.date, messageId: m.messageId || null, inReplyTo: m.inReplyTo || null, station: m.station, venture: m.venture || null, agentId: m.agentId || null, kind: m.kind || null, resendId: m.resendId || null, status: m.status || null, labels: m.labels || [], attachments: (m.attachments || []).length, classification: m.classification || null, snippet: (m.text || '').replace(/\s+/g, ' ').slice(0, SNIPPET) });

  return {
    root,
    messagesDir,
    attachmentsDir,
    async init() {
      await fsp.mkdir(messagesDir, { recursive: true });
      await fsp.mkdir(attachmentsDir, { recursive: true });
      const loaded = await readJson(indexFile, null);
      if (loaded && Array.isArray(loaded.messages)) index = loaded.messages;
      suppression = (await readJson(suppressionFile, null)) || {};
      cursor = (await readJson(cursorFile, null)) || cursor;
      return this;
    },
    counts() {
      const byStation = {};
      let unread = 0;
      for (const m of index) {
        byStation[m.station] = byStation[m.station] || { in: 0, out: 0 };
        byStation[m.station][m.direction] += 1;
        if (m.direction === 'in' && !m.labels.includes('read')) unread += 1;
      }
      return { messages: index.length, unread, byStation, suppressed: Object.keys(suppression).length, cursor: cursor.received, cursorAt: cursor.at };
    },
    // Adds a message; returns the stored record with id and threadId.
    async add(message) {
      if (!message || !['in', 'out'].includes(message.direction)) throw fail('BAD_REQUEST', 'message needs direction in|out');
      if (!message.station) throw fail('BAD_REQUEST', 'message needs a station');
      const id = message.id || `msg-${randomUUID().slice(0, 12)}`;
      if (index.some((m) => m.id === id)) throw fail('CONFLICT', `message ${id} exists`, 409);
      if (message.resendId && message.direction === 'in' && index.some((m) => m.resendId === message.resendId && m.direction === 'in')) throw fail('CONFLICT', `received ${message.resendId} is already stored`, 409);
      const refs = [...refList(message.references), ...(message.inReplyTo ? [message.inReplyTo.trim()] : [])];
      let threadId = message.threadId || null;
      if (!threadId && refs.length) {
        const parent = index.find((m) => m.messageId && refs.includes(m.messageId));
        if (parent) threadId = parent.threadId;
      }
      if (!threadId) threadId = `thread-${id.replace(/^msg-/, '')}`;
      const record = {
        id,
        threadId,
        direction: message.direction,
        from: message.from || '',
        to: addressList(message.to),
        cc: addressList(message.cc),
        replyTo: addressList(message.replyTo),
        subject: message.subject || '',
        text: message.text || '',
        html: message.html || '',
        date: Number.isFinite(message.date) ? message.date : clock.now(),
        messageId: message.messageId || null,
        inReplyTo: message.inReplyTo || null,
        references: refList(message.references),
        station: message.station,
        venture: message.venture || null,
        agentId: message.agentId || null,
        kind: message.kind || (message.direction === 'in' ? 'inbound' : 'reply'),
        resendId: message.resendId || null,
        status: message.status || (message.direction === 'out' ? 'sent' : 'received'),
        labels: [...new Set(message.labels || [])],
        attachments: message.attachments || [],
        classification: message.classification || null,
        headers: message.headers || {},
        storedAt: clock.now(),
      };
      await writeJsonAtomic(path.join(messagesDir, `${id}.json`), record);
      index.push(summaryOf(record));
      if (index.length > INDEX_LIMIT) index = index.slice(-INDEX_LIMIT);
      await save(indexFile, { version: 1, messages: index });
      return record;
    },
    get: (id) => (/^[A-Za-z0-9_-]{1,80}$/.test(id) ? readJson(path.join(messagesDir, `${id}.json`), null) : Promise.resolve(null)),
    // The index entry (sync): what the policy needs to judge a draft's kind without a read.
    summary: (id) => index.find((m) => m.id === id) || null,
    // Is this a thread the park has mail in (sync)? Drafts do not make a thread known.
    hasThread: (threadId) => Boolean(threadId) && index.some((m) => m.threadId === threadId && m.status !== 'draft'),
    byMessageId: (mid) => index.find((m) => m.messageId === mid) || null,
    byResendId: (rid) => index.find((m) => m.resendId === rid) || null,
    list({ station, venture, threadId, direction, label, agentId, limit = 50 } = {}) {
      return index
        .filter((m) => (!station || m.station === station) && (!venture || m.venture === venture) && (!threadId || m.threadId === threadId) && (!direction || m.direction === direction) && (!label || m.labels.includes(label)) && (!agentId || m.agentId === agentId))
        .slice(-limit)
        .reverse();
    },
    threads({ station, venture, limit = 50 } = {}) {
      const by = new Map();
      for (const m of index) {
        if ((station && m.station !== station) || (venture && m.venture !== venture)) continue;
        const t = by.get(m.threadId) || { threadId: m.threadId, subject: m.subject, station: m.station, venture: m.venture, count: 0, first: m.date, last: m.date, participants: new Set(), labels: new Set(), unread: 0, lastDirection: m.direction, classification: null };
        t.count += 1;
        t.last = Math.max(t.last, m.date);
        t.lastDirection = m.direction;
        participantsOf(m).forEach((p) => t.participants.add(p));
        m.labels.forEach((l) => t.labels.add(l));
        if (m.direction === 'in' && !m.labels.includes('read')) t.unread += 1;
        if (m.classification) t.classification = m.classification;
        by.set(m.threadId, t);
      }
      return [...by.values()].sort((a, b) => b.last - a.last).slice(0, limit).map((t) => ({ ...t, participants: [...t.participants], labels: [...t.labels] }));
    },
    async thread(threadId) {
      const out = [];
      for (const m of index.filter((x) => x.threadId === threadId)) out.push(await this.get(m.id));
      return out.filter(Boolean);
    },
    async setLabels(id, { add = [], remove = [] } = {}) {
      const s = index.find((m) => m.id === id);
      if (!s) throw fail('NOT_FOUND', `no message ${id}`, 404);
      const labels = new Set(s.labels);
      add.forEach((l) => labels.add(l));
      remove.forEach((l) => labels.delete(l));
      s.labels = [...labels];
      const full = await this.get(id);
      if (full) {
        full.labels = s.labels;
        await writeJsonAtomic(path.join(messagesDir, `${id}.json`), full);
      }
      await save(indexFile, { version: 1, messages: index });
      return s.labels;
    },
    async setClassification(id, classification) {
      const s = index.find((m) => m.id === id);
      if (!s) throw fail('NOT_FOUND', `no message ${id}`, 404);
      s.classification = classification;
      const full = await this.get(id);
      if (full) {
        full.classification = classification;
        await writeJsonAtomic(path.join(messagesDir, `${id}.json`), full);
      }
      await save(indexFile, { version: 1, messages: index });
      return s;
    },
    // Delivery status of a sent message, by Resend id or store id.
    async setStatus({ resendId, id, status, event, detail, at }) {
      const s = index.find((m) => (resendId && m.resendId === resendId) || (id && m.id === id));
      if (!s) return null;
      s.status = status;
      const full = await this.get(s.id);
      if (full) {
        full.status = status;
        full.events = [...(full.events || []), { event: event || status, detail: detail || '', at: at || clock.now() }];
        await writeJsonAtomic(path.join(messagesDir, `${s.id}.json`), full);
      }
      await save(indexFile, { version: 1, messages: index });
      return s;
    },
    async suppress(address, reason) {
      const a = normalizeAddress(address);
      if (!a) return null;
      suppression[a] = { reason: reason || 'unspecified', at: clock.now() };
      await save(suppressionFile, suppression);
      return suppression[a];
    },
    async unsuppress(address) {
      const a = normalizeAddress(address);
      const had = Boolean(suppression[a]);
      delete suppression[a];
      await save(suppressionFile, suppression);
      return had;
    },
    isSuppressed: (address) => Boolean(suppression[normalizeAddress(address)]),
    suppressions: () => Object.entries(suppression).map(([address, v]) => ({ address, ...v })),
    cursor: () => ({ ...cursor }),
    async setCursor(received) {
      cursor = { received, at: clock.now() };
      await save(cursorFile, cursor);
    },
    search(q, { limit = 50 } = {}) {
      const needle = String(q || '').toLowerCase();
      if (!needle) return [];
      return index.filter((m) => [m.subject, m.from, ...m.to, m.snippet, m.venture || ''].some((f) => String(f).toLowerCase().includes(needle))).slice(-limit).reverse();
    },
    flushed: () => saving,
  };
}

function participantsOf(m) {
  return [normalizeAddress(m.from), ...m.to.map(normalizeAddress)].filter(Boolean);
}
