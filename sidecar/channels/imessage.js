// iMessage (D170): the owner's channel on their own Mac, instead of a bot on somebody
// else's service.
//
//   createIMessageAdapter({ run, dbPath, pollMs, clock, log })
//     -> an adapter for sidecar/channels/registry.js (keys: imessageHandle)
//
// The park is local and personal, so the owner channel should be too: no bot to register,
// no token to leak, no third party holding the Gate cards. Messages.app is already signed
// in as the owner, so the park sends through it and reads what comes back.
//
//   sending    `osascript` tells Messages to send to a handle on the iMessage service.
//   receiving  the Messages database (~/Library/Messages/chat.db) is polled read-only
//              through the `sqlite3` that ships with macOS, for messages that arrived
//              after the adapter started.
//
// Two macOS permissions decide whether this works, and the adapter says plainly which one
// is missing rather than looking wired and going quiet:
//   Full Disk Access      for whatever runs the sidecar (Terminal, or Maka itself) —
//                         without it chat.db cannot be opened and nothing is received.
//   Automation → Messages the first send raises the prompt; denied, sending fails.
//
// `imessageHandle` is the owner's address (an Apple ID email or a phone number; several,
// comma separated, when the owner writes from a phone as well as an Apple ID). It is the
// only key, and it is an allow-list, not a default: **the park messages the owner and
// nobody else.** A send to any other handle is refused before Messages is asked, and a
// message from any other handle is dropped before the registry ever sees it — so the park
// cannot answer a stranger, not even to say "not paired", and only the owner's own chat
// can pair. Unlike a bot token the handle is not a secret, but it lives with the others
// so one place answers "is this channel configured".
//
// No buttons: iMessage has none, so the registry renders a card as text with the slash
// commands that do what the buttons would (`cardText` in adapter.js).
//
// The echo (D172): the Mac is signed in as the owner and the park writes to the owner, so
// Messages files every outgoing message twice — once as sent and once as *received* on
// the same account, with the owner's handle on it. Read naively the park would take its
// own Gate cards back as the owner's replies and hand them to the Chief as questions, so
// what was just sent is remembered briefly and an inbound line matching it is dropped.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
export const POLL_MS = 3000;
export const MAX_MESSAGE = 8000; // a courtesy limit; iMessage itself is far more generous
export const ECHO_WINDOW_MS = 120000; // how long the park recognises its own message coming back
export const ECHO_MEMORY = 50; // how many of its own messages it remembers at once

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// execFile as a promise. Arguments are always an array, never a shell string, so a
// handle or a message body can never be read as shell syntax.
function run(file, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = fail('EXEC', `${path.basename(file)}: ${String(stderr || err.message).trim().split('\n')[0]}`);
        e.stderr = String(stderr || '');
        return reject(e);
      }
      resolve(String(stdout));
    });
  });
}

// Apple's own escaping rules for a string inside an AppleScript literal.
export function osaQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The AppleScript that sends one message. `from` (D173) names the Apple ID to send as:
// Messages files an account as "E:<apple id>", and with a second account signed in the
// park writes as itself instead of as the owner — which is what stops its messages
// landing in the owner's own thread with themselves. Without it the first iMessage
// account is used, which on a Mac signed in as the owner is the owner.
// If the handle is not reachable over iMessage the script fails and the registry records
// the delivery as failed, which is the truth.
export function sendScript(handle, text, from = null) {
  const service = from ? `service id ${osaQuote(`E:${String(from).trim()}`)}` : '1st account whose service type = iMessage';
  return [
    'tell application "Messages"',
    `  set targetService to ${service}`,
    `  set targetBuddy to participant ${osaQuote(handle)} of targetService`,
    `  send ${osaQuote(text)} to targetBuddy`,
    'end tell',
  ].join('\n');
}

// Every message the park sends carries its name. On a thread the owner may share with
// themselves, "who is talking" is otherwise a guess (D173).
export const SIGNATURE = 'Maka · ';
export function signed(text) {
  const body = String(text || '');
  return body.startsWith(SIGNATURE) ? body : SIGNATURE + body;
}

// Messages that arrived after `afterRowId`, newest last. `text` is NULL for messages the
// newer Messages writes only as an attributed blob; those are reported with an empty
// text so the registry still sees that something came in from that chat.
export function inboundQuery(afterRowId) {
  return [
    'SELECT m.ROWID AS rowid, COALESCE(h.id, "") AS handle, COALESCE(m.text, "") AS text,',
    '       COALESCE(c.chat_identifier, "") AS chat, COALESCE(c.style, 0) AS style,',
    '       (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participants',
    'FROM message m',
    'LEFT JOIN handle h ON m.handle_id = h.ROWID',
    'LEFT JOIN chat_message_join j ON j.message_id = m.ROWID',
    'LEFT JOIN chat c ON c.ROWID = j.chat_id',
    `WHERE m.is_from_me = 0 AND m.ROWID > ${Number(afterRowId) || 0}`,
    'ORDER BY m.ROWID ASC LIMIT 50;',
  ].join(' ');
}

// One handle in a form two spellings of the same person compare equal: an address is
// lower-cased, a phone number is reduced to its digits (Messages reports "+1 555 0000",
// "+15550000" and "5550000" for the same contact), with the country code's leading 1
// dropped for a ten-digit North American number so both spellings meet.
export function normalizeHandle(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) return s;
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// The owner's handles, as an allow-list. Everything else the park sees is not the owner.
export function ownerHandles(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((h) => normalizeHandle(h))
      .filter(Boolean),
  );
}

// Whether a chat is the one-to-one conversation the owner may act in (safety H1).
//
// `chat.style` is the obvious flag — 43 for a direct chat, 45 for a group — but Messages
// does not keep it honest: the owner's own thread with themselves is filed as 45, and
// every command the owner sent was being thrown away as "a group" (D174). How many people
// are in the chat is the thing actually being asked, so when the participant count is
// known it decides, and the style is only the fallback.
export function chatTypeOf(styleOrRow, participantsArg) {
  const row = styleOrRow && typeof styleOrRow === 'object' ? styleOrRow : null;
  const style = Number(row ? row.style : styleOrRow);
  const participants = Number(row ? row.participants : participantsArg);
  if (Number.isFinite(participants) && participants > 0) return participants === 1 ? 'private' : 'group';
  if (style === 43) return 'private';
  if (style === 45) return 'group';
  return 'unknown';
}

// One sqlite3 -json row set, parsed. An empty result prints nothing at all.
export function parseRows(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function createIMessageAdapter({
  exec = run,
  dbPath = DEFAULT_DB,
  sqlite3 = '/usr/bin/sqlite3',
  osascript = '/usr/bin/osascript',
  pollMs = POLL_MS,
  clock = { now: () => Date.now() },
  log = console,
} = {}) {
  let handle = null;
  let owners = new Set(); // the only handles the park will ever message or listen to
  let primary = null; // the one of them every outgoing message actually goes to
  let from = null; // D173: the Apple ID the park sends as, when it has one of its own
  const justSent = []; // { text, at } — what the park said, to recognise its own echo
  let onInbound = null;
  let timer = null;
  let lastRowId = 0;
  let stopped = true;
  let polling = false;

  const query = (sql) => exec(sqlite3, ['-readonly', '-json', dbPath, sql]);

  async function highestRowId() {
    const rows = parseRows(await query('SELECT COALESCE(MAX(ROWID), 0) AS rowid FROM message;'));
    return Number(rows[0] && rows[0].rowid) || 0;
  }

  async function poll() {
    if (stopped || polling || !onInbound) return;
    polling = true;
    try {
      const rows = parseRows(await query(inboundQuery(lastRowId)));
      for (const r of rows) {
        lastRowId = Math.max(lastRowId, Number(r.rowid) || 0);
        const chatId = String(r.handle || r.chat || '').trim();
        if (!chatId) continue;
        // The park answers the owner and nobody else: a message from any other handle is
        // dropped here, so the registry never sees it and never replies to a stranger.
        if (!owners.has(normalizeHandle(r.handle)) || !owners.has(normalizeHandle(chatId))) continue;
        // And only in the owner's own one-to-one chat: a group the owner happens to be
        // in is not the owner's channel, whoever typed in it.
        if (chatTypeOf(r) !== 'private') continue;
        // The park's own words coming back on the same Apple ID are not the owner
        // speaking. Matched on the text, within a window, and consumed once.
        const body = String(r.text || '');
        const echo = justSent.findIndex((e) => e.text === body && clock.now() - e.at < ECHO_WINDOW_MS);
        if (body && echo !== -1) {
          justSent.splice(echo, 1);
          continue;
        }
        // The handle is both who sent it and where a reply goes: on a one-to-one chat
        // they are the same, which is the only shape that can pair.
        await onInbound({
          chatId,
          userId: String(r.handle || '').trim() || chatId,
          chatType: chatTypeOf(r),
          text: String(r.text || ''),
          messageId: String(r.rowid),
          updateId: `imessage:${r.rowid}`,
        });
      }
    } catch (err) {
      // A permission that was revoked while running, or Messages mid-write: say so once
      // and keep polling, rather than dying quietly.
      log.error(`imessage poll: ${err && err.message ? err.message : err}`);
    } finally {
      polling = false;
    }
  }

  return {
    name: 'imessage',
    label: 'iMessage',
    keys: ['imessageHandle'],
    optionalKeys: ['imessageFrom'],
    buttons: false,
    // D172: this channel carries the owner and nobody else — the handle in the keystore
    // is the credential, checked on every message in and out — so the registry pairs the
    // owner's chat on sight instead of asking them to prove they are themselves.
    trusted: true,

    async start({ keys, onInbound: cb, log: l = log }) {
      handle = String((keys && keys.imessageHandle) || '').trim();
      if (!handle) throw fail('NO_HANDLE', 'iMessage needs the owner handle (an Apple ID email or phone number)');
      owners = ownerHandles(handle);
      if (!owners.size) throw fail('NO_HANDLE', `iMessage cannot read an owner handle from "${handle}"`);
      // The first handle as the owner wrote it: Messages wants the address in the shape
      // it knows, not the normalised form the allow-list compares with.
      primary = String(handle).split(',')[0].trim();
      from = String((keys && keys.imessageFrom) || '').trim() || null;
      // Reading the database is the permission people forget, so it is checked first and
      // named exactly: the park would otherwise look connected and never hear anything.
      try {
        lastRowId = await highestRowId();
      } catch (err) {
        throw fail(
          'NO_DISK_ACCESS',
          `cannot read the Messages database (${dbPath}). Give Full Disk Access to whatever runs Maka: System Settings → Privacy & Security → Full Disk Access. (${err && err.message ? err.message : err})`,
        );
      }
      onInbound = cb;
      stopped = false;
      timer = setInterval(() => void poll(), pollMs);
      if (timer.unref) timer.unref();
      l.info && l.info(`imessage: watching Messages for ${handle}`);
      return { detail: `Messages on this Mac${from ? ` as ${from}` : ''}, to ${primary} only${owners.size > 1 ? ` (replies accepted from ${owners.size} handles)` : ''}` };
    },

    async stop() {
      stopped = true;
      onInbound = null;
      if (timer) clearInterval(timer);
      timer = null;
    },

    async sendText(chatId, text) {
      const to = String(chatId || handle || '').trim();
      if (!to) throw fail('NO_HANDLE', 'iMessage has nobody to send to');
      // The allow-list is checked here, not upstream: whatever the registry decides, the
      // park cannot message anyone but its owner.
      if (!owners.has(normalizeHandle(to))) throw fail('NOT_THE_OWNER', `iMessage only ever writes to the owner; "${to}" is not ${[...owners].join(', ')}`);
      // …and it always answers in the one thread, whichever of the owner's handles the
      // chat was filed under, so the same conversation does not arrive twice.
      const target = primary || to;
      const body = signed(String(text || '')).slice(0, MAX_MESSAGE);
      // Remembered before the send, so the echo cannot arrive first.
      justSent.push({ text: body, at: clock.now() });
      while (justSent.length > ECHO_MEMORY) justSent.shift();
      try {
        await exec(osascript, ['-e', sendScript(target, body, from)]);
      } catch (err) {
        const detail = String((err && err.stderr) || (err && err.message) || '');
        if (/Not authori[sz]ed|assistive|1743|–1743/.test(detail)) {
          throw fail('NO_AUTOMATION', 'Messages refused automation. System Settings → Privacy & Security → Automation → allow Maka (or Terminal) to control Messages.');
        }
        throw fail('SEND_FAILED', `iMessage send failed: ${detail.split('\n')[0] || 'unknown error'}`);
      }
      return { messageId: `imessage-${clock.now()}` };
    },

    // iMessage has no buttons, so a card goes as the text the registry renders for
    // button-less channels, with the slash commands that do the same thing.
    async sendCard(chatId, card) {
      const { cardText } = await import('./adapter.js');
      return this.sendText(chatId, cardText(card));
    },
  };
}
