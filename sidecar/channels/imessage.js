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
// `imessageHandle` is the owner's address (an Apple ID email or a phone number). It is
// the only key: it says who the park may talk to, and nothing is sent anywhere else.
// Unlike a bot token it is not a secret, but it lives with the others so one place
// answers "is this channel configured".
//
// No buttons: iMessage has none, so the registry renders a card as text with the slash
// commands that do what the buttons would (`cardText` in adapter.js).

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
export const POLL_MS = 3000;
export const MAX_MESSAGE = 8000; // a courtesy limit; iMessage itself is far more generous

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

// The AppleScript that sends one message. Messages picks the buddy on the iMessage
// service; if the handle is not reachable over iMessage the script fails and the
// registry records the delivery as failed, which is the truth.
export function sendScript(handle, text) {
  return [
    'tell application "Messages"',
    '  set targetService to 1st account whose service type = iMessage',
    `  set targetBuddy to participant ${osaQuote(handle)} of targetService`,
    `  send ${osaQuote(text)} to targetBuddy`,
    'end tell',
  ].join('\n');
}

// Messages that arrived after `afterRowId`, newest last. `text` is NULL for messages the
// newer Messages writes only as an attributed blob; those are reported with an empty
// text so the registry still sees that something came in from that chat.
export function inboundQuery(afterRowId) {
  return [
    'SELECT m.ROWID AS rowid, COALESCE(h.id, "") AS handle, COALESCE(m.text, "") AS text,',
    '       COALESCE(c.chat_identifier, "") AS chat, COALESCE(c.style, 0) AS style',
    'FROM message m',
    'LEFT JOIN handle h ON m.handle_id = h.ROWID',
    'LEFT JOIN chat_message_join j ON j.message_id = m.ROWID',
    'LEFT JOIN chat c ON c.ROWID = j.chat_id',
    `WHERE m.is_from_me = 0 AND m.ROWID > ${Number(afterRowId) || 0}`,
    'ORDER BY m.ROWID ASC LIMIT 50;',
  ].join(' ');
}

// chat.style 43 is a one-to-one conversation; 45 is a group. Anything else is unknown,
// and the registry refuses to pair with anything that is not plainly private
// (safety 2026-10-11 H1).
export function chatTypeOf(style) {
  if (Number(style) === 43) return 'private';
  if (Number(style) === 45) return 'group';
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
        // The handle is both who sent it and where a reply goes: on a one-to-one chat
        // they are the same, which is the only shape that can pair.
        await onInbound({
          chatId,
          userId: String(r.handle || '').trim() || chatId,
          chatType: chatTypeOf(r.style),
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
    buttons: false,

    async start({ keys, onInbound: cb, log: l = log }) {
      handle = String((keys && keys.imessageHandle) || '').trim();
      if (!handle) throw fail('NO_HANDLE', 'iMessage needs the owner handle (an Apple ID email or phone number)');
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
      return { detail: `Messages on this Mac, as ${handle}` };
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
      const body = String(text || '').slice(0, MAX_MESSAGE);
      try {
        await exec(osascript, ['-e', sendScript(to, body)]);
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
