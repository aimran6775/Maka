// The mailbox's own thinking (D187), kept apart from its DOM so it runs under `node --test`
// like the park's maths does. Nothing here touches the document.
//
//   stationsOf(layout)        the departments that have a mailbox, in reading order
//   addressFor(addresses, s)  the station address a department sends from
//   fold(threads)             thread rows the list can draw without further work
//   shortDate(ms, now)        the Gmail-ish date: time today, "12 Oct" this year, else year
//   participantsLabel(t, own) who the row is "from" — the other party, not ourselves
//   nextIndex(len, i, step)   cursor movement that stops at the ends rather than wrapping
//   quoteReply(message)       the quoted body a reply starts from
//   replyFields(message, own) who a reply goes to, and the subject it carries

import { ZONE_LABELS, DEPARTMENT_KINDS } from '../../shared/world.js';

// A department's mailbox is its camp's room id — which is what the mail store calls the
// `station` that owns a message. The Ranger Station and the Peak keep mailboxes too: the
// park's own mail (briefings from the Peak) arrives there.
export const EXTRA_STATIONS = Object.freeze(['ranger-station', 'mountain-peak', 'visitor-center']);

export function stationsOf(layout) {
  const rooms = (layout && layout.rooms) || [];
  const out = [];
  // Departments first, in the order the park lists them, then the park's own places.
  for (const kind of DEPARTMENT_KINDS) {
    const room = rooms.find((r) => r.kind === kind);
    if (room) out.push({ id: room.id, label: ZONE_LABELS[kind] || room.name || room.id, kind, department: true });
  }
  for (const id of EXTRA_STATIONS) {
    const room = rooms.find((r) => r.id === id);
    if (room) out.push({ id: room.id, label: room.name || id, kind: room.kind || null, department: false });
  }
  return out;
}

// What this department sends from, if it has an address yet.
export function addressFor(addresses, stationId) {
  const rows = Array.isArray(addresses) ? addresses : (addresses && addresses.addresses) || [];
  const own = rows.find((a) => a.station === stationId && (a.kind === 'station' || !a.kind));
  return own ? own.address : null;
}

// One thread, ready to draw: no nested lookups, no date maths in the renderer.
export function fold(threads, { now = Date.now(), own = [] } = {}) {
  return (threads || []).map((t) => ({
    threadId: t.threadId,
    subject: t.subject || '(no subject)',
    from: participantsLabel(t, own),
    // D188: the preview text, which a mail row has and this one did not.
    snippet: t.snippet || '',
    // The message ids in the thread, so starring or archiving a row needs no second fetch.
    ids: t.ids || [],
    count: t.count || 1,
    unread: (t.unread || 0) > 0,
    starred: (t.labels || []).includes('starred'),
    archived: (t.labels || []).includes('archived'),
    trashed: (t.labels || []).includes('trashed'),
    // The labels the owner put on it, which the folders do not own.
    labels: (t.labels || []).filter((l) => !['read', 'starred', 'archived', 'trashed'].includes(l)),
    venture: t.venture || null,
    kind: t.kind || null,
    classification: t.classification || null,
    last: t.last,
    when: shortDate(t.last, now),
  }));
}

// D188: forwarding. A forward goes to nobody yet, keeps the thread's subject under Fwd:,
// and carries the message as a quoted block the way a reply does — so the person receiving
// it sees what the park saw.
export function forwardFields(message) {
  if (!message) return { to: [], cc: [], subject: '', text: '' };
  const subject = /^fwd:/i.test(message.subject || '') ? message.subject : `Fwd: ${message.subject || ''}`.trim();
  const head = [
    '',
    '---------- Forwarded message ----------',
    `From: ${message.from || ''}`,
    `Date: ${fullDate(message.date)}`,
    `Subject: ${message.subject || ''}`,
    `To: ${(message.to || []).join(', ')}`,
    '',
    String(message.text || ''),
  ].join('\n');
  return { to: [], cc: [], subject, text: head };
}

// D188: a label a person typed. Lower case, no spaces, nothing that would collide with a
// folder's own labels — otherwise "Starred" as a custom label would silently star things.
export const RESERVED_LABELS = Object.freeze(['read', 'starred', 'archived', 'trashed']);

export function cleanLabel(input) {
  const l = String(input || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
  if (!l || l.length > 40) return null;
  if (RESERVED_LABELS.includes(l)) return null;
  return l;
}

// Who the row is from: the people on the thread who are not us. A thread with nobody else
// on it is the park talking to itself, which is what a briefing is.
export function participantsLabel(t, own = []) {
  const mine = new Set((own || []).map((a) => String(a).toLowerCase()));
  const others = (t.participants || []).filter((p) => !mine.has(String(p).toLowerCase()));
  const names = (others.length ? others : t.participants || []).map(shortAddress);
  if (!names.length) return 'the park';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, ${names[1]}`;
  return `${names[0]} +${names.length - 1}`;
}

// `ada@makapark.com` reads as `ada` inside the park; anyone outside keeps their domain, so
// a stranger never looks like staff.
export function shortAddress(a) {
  const s = String(a || '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return s;
  return s.endsWith('@makapark.com') ? s.slice(0, at) : s;
}

const DAY = 86400000;

export function shortDate(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.getFullYear() === n.getFullYear()) {
    return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
  }
  return String(d.getFullYear());
}

export function fullDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Moving the cursor with j / k. It stops at the ends: wrapping from the last message to the
// first is disorienting in a list you are reading down.
export function nextIndex(length, index, step) {
  if (!length) return -1;
  if (index < 0) return step > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, index + step));
}

// The quoted body a reply opens with. Plain text only: the park writes plain mail.
export function quoteReply(message) {
  if (!message) return '';
  const when = fullDate(message.date);
  const body = String(message.text || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nOn ${when}, ${shortAddress(message.from)} wrote:\n${body}\n`;
}

// Who a reply goes to, and what it is called. Reply-To wins over From, which is what it is
// for; our own address is never a recipient of our own reply.
export function replyFields(message, own = [], { all = false } = {}) {
  if (!message) return { to: [], cc: [], subject: '' };
  const mine = new Set((own || []).map((a) => String(a).toLowerCase()));
  const back = (message.replyTo && message.replyTo.length ? message.replyTo : [message.from]).filter(Boolean);
  const to = [...new Set(back.map((a) => String(a)))];
  const cc = all
    ? [...new Set([...(message.to || []), ...(message.cc || [])].filter((a) => !mine.has(String(a).toLowerCase()) && !to.some((t) => String(t).toLowerCase() === String(a).toLowerCase())))]
    : [];
  const subject = /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || ''}`.trim();
  return { to, cc, subject };
}
