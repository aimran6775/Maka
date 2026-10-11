// Computer control (phase 4 step 18): the pure policy and the wire format, tested under
// Node. The shell does the driving (src-tauri/src/computer.rs); this file decides what may
// be asked of it and how the question travels over the credential broker's socket.
//
// Wire: one line per connection, like a credential request (src-tauri/src/broker.rs):
//   <token> COMPUTER <action> <base64 json>   ->   OK <base64 json> | ERR <message>
// The sidecar never opens an HTTP port for this and the shell never listens on one.

export const COMPUTER_ACTIONS = Object.freeze(['status', 'begin', 'end', 'frontmost', 'apps', 'focus', 'screenshot', 'locate', 'click', 'type', 'key', 'halt', 'resume']);
// The Ranger-facing tools, one per driving action; `status`, `begin`, `end`, `frontmost`,
// `halt` and `resume` are the control's own.
export const COMPUTER_TOOL_NAMES = Object.freeze(['computer.screenshot', 'computer.locate', 'computer.click', 'computer.type', 'computer.key', 'computer.focus', 'computer.apps']);
export const COMPUTER_DOMAIN = 'computer_control';
export const HALT_HOTKEY = '⌃⌥⌘H';
export const TRACE_LIMIT = 500;
export const TYPE_MAX_CHARS = 2000;
export const LOCATE_MAX_MATCHES = 40;

// Apps a Ranger never drives: the action hands off to the Superintendent instead. Bundle
// id prefixes and name words, matched case-insensitively. The shell keeps the same list
// (computer_policy.rs) as a second lock. Maka itself is first on it (safety 2026-10-11
// H2): a Ranger that could focus Maka's window could click its own Gate items. Browsers
// are on it too: the web is driven through the browser tools (sidecar/browser/), which
// carry the outbound guard, the payment handoff and the purchase rules; a browser driven
// by clicks and keys would carry none of them.
export const MAKA_BUNDLE_ID = 'com.makapark.maka';
export const BROWSER_BUNDLE_IDS = Object.freeze(['com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'com.google.Chrome', 'com.google.Chrome.canary', 'org.chromium.Chromium', 'org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'com.microsoft.edgemac', 'com.brave.Browser', 'com.operasoftware.Opera', 'com.vivaldi.Vivaldi', 'company.thebrowser.Browser', 'com.kagi.kagimacOS', 'org.torproject.torbrowser']);
export const SENSITIVE_APPS = Object.freeze({
  bundleIds: [
    MAKA_BUNDLE_ID, ...BROWSER_BUNDLE_IDS,
    'com.apple.systempreferences', 'com.apple.Terminal', 'com.apple.keychainaccess', 'com.apple.Passwords', 'com.apple.Passwords-Settings', 'com.apple.Console',
    'com.googlecode.iterm2', 'dev.warp.Warp', 'co.zeit.hyper', 'com.github.wez.wezterm', 'net.kovidgoyal.kitty', 'org.alacritty',
    'com.agilebits.onepassword', 'com.1password', 'com.bitwarden', 'com.lastpass', 'com.dashlane', 'org.keepassxc', 'com.nordpass', 'com.enpass',
    'com.apple.Wallet', 'com.paypal', 'com.venmo', 'com.squareup.cash', 'com.coinbase', 'com.binance', 'com.robinhood', 'com.revolut', 'co.uk.getmondo', 'com.transferwise', 'com.wise',
  ],
  names: ['maka', 'safari', 'chrome', 'chromium', 'firefox', 'edge', 'brave', 'opera', 'vivaldi', 'arc', 'orion', 'tor browser', 'system settings', 'system preferences', 'terminal', 'iterm', 'warp', 'hyper', 'wezterm', 'kitty', 'alacritty', 'console', 'keychain access', 'passwords', '1password', 'bitwarden', 'lastpass', 'dashlane', 'keepass', 'nordpass', 'enpass', 'wallet', 'bank', 'banking', 'paypal', 'venmo', 'cash app', 'coinbase', 'binance', 'robinhood', 'revolut', 'monzo', 'wise'],
});

// A window title or URL that names a loopback host (the sidecar's own UI, or any local
// web UI): the app in front is treated as sensitive whatever it is (safety 2026-10-11 H2).
// `ownHosts` adds the sidecar's own host:port strings as the shell knows them.
const LOOPBACK_RE = /(^|[^a-z0-9.-])(127(?:\.\d{1,3}){3}|localhost|0\.0\.0\.0|\[::1\]|::1|[a-z0-9-]+\.local)(?=$|[^a-z0-9.-])/i;
export function namesLoopback(text, ownHosts = []) {
  const t = String(text || '');
  if (!t) return null;
  const m = LOOPBACK_RE.exec(t);
  if (m) return m[2];
  for (const h of ownHosts || []) if (h && t.toLowerCase().includes(String(h).toLowerCase())) return String(h);
  return null;
}

// { sensitive, why } for an app as the shell names it, with its front window when known.
export function isSensitiveApp({ bundleId = '', name = '', window = null } = {}, { ownHosts = [] } = {}) {
  const id = String(bundleId || '').toLowerCase();
  const nm = String(name || '').toLowerCase().trim();
  for (const prefix of SENSITIVE_APPS.bundleIds) if (id === prefix.toLowerCase() || id.startsWith(`${prefix.toLowerCase()}.`)) return { sensitive: true, why: `${name || bundleId} (${bundleId}) is on the list of apps a Ranger never drives` };
  for (const word of SENSITIVE_APPS.names) {
    const re = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(nm)) return { sensitive: true, why: `${name} is on the list of apps a Ranger never drives (${word})` };
  }
  if (window && typeof window === 'object') {
    for (const field of ['url', 'title']) {
      const hit = namesLoopback(window[field], ownHosts);
      if (hit) return { sensitive: true, why: `the window in front (${field} names ${hit}) shows a local web UI, which may be Maka's own; a Ranger never drives it` };
    }
  }
  return { sensitive: false, why: null };
}

export const MODIFIERS = Object.freeze({ cmd: 'command', command: 'command', meta: 'command', ctrl: 'control', control: 'control', alt: 'option', opt: 'option', option: 'option', shift: 'shift', fn: 'function' });
export const NAMED_KEYS = Object.freeze(['return', 'enter', 'tab', 'space', 'delete', 'backspace', 'escape', 'esc', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12']);

// "cmd+shift+s" -> { modifiers: ['command', 'shift'], key: 's' }; a bad chord is an error.
export function parseChord(chord) {
  if (typeof chord !== 'string' || !chord.trim()) throw new Error('a key chord is required, like "cmd+s" or "return"');
  const parts = chord.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 5) throw new Error(`"${chord}" is not a key chord`);
  const key = parts.pop();
  const modifiers = [];
  for (const p of parts) {
    const m = MODIFIERS[p];
    if (!m) throw new Error(`"${p}" is not a modifier (cmd, ctrl, alt, shift, fn)`);
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  if (!(/^[a-z0-9]$/.test(key) || NAMED_KEYS.includes(key) || /^[-=\[\];'\\,./`]$/.test(key))) throw new Error(`"${key}" is not a key (a letter, a digit, punctuation or ${NAMED_KEYS.slice(0, 6).join(', ')}…)`);
  return { modifiers, key: key === 'enter' ? 'return' : key === 'esc' ? 'escape' : key === 'backspace' ? 'delete' : key };
}

// The accessibility tree as the shell flattens it: [{ id, role, title, value, description,
// x, y, w, h }]. A query matches title, value or description (case-insensitive substring)
// and, when it names a role, the role too. The centre of each match is given for clicks.
export function locateMatches(nodes, query, { max = LOCATE_MAX_MATCHES } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const n of nodes || []) {
    const hay = [n.title, n.value, n.description].filter((x) => typeof x === 'string').join(' ').toLowerCase();
    const roleHit = typeof n.role === 'string' && n.role.toLowerCase() === q;
    if (!roleHit && !hay.includes(q)) continue;
    const w = Number(n.w) || 0;
    const h = Number(n.h) || 0;
    out.push({ id: n.id, role: n.role || null, title: n.title || null, value: n.value || null, description: n.description || null, x: Number(n.x) || 0, y: Number(n.y) || 0, w, h, centre: { x: Math.round((Number(n.x) || 0) + w / 2), y: Math.round((Number(n.y) || 0) + h / 2) } });
    if (out.length >= max) break;
  }
  return out;
}

// The broker line's value for a COMPUTER request and the decoded answer.
export function encodeRequest(action, params = {}) {
  if (!COMPUTER_ACTIONS.includes(action)) throw new Error(`unknown computer action "${action}"`);
  return JSON.stringify({ action, ...params });
}

export function decodeReply(reply) {
  if (!reply || typeof reply !== 'object') return { ok: false, code: 'BAD_REPLY', error: 'no answer from the shell' };
  if (!reply.ok) return { ok: false, code: 'SHELL', error: reply.error || 'the shell refused' };
  if (reply.value === null || reply.value === undefined) return { ok: true, result: {} };
  try {
    const parsed = JSON.parse(reply.value);
    if (parsed && typeof parsed === 'object' && parsed.ok === false) return { ok: false, code: parsed.code || 'SHELL', error: parsed.error || 'the shell refused', app: parsed.app || null };
    return { ok: true, result: parsed && typeof parsed === 'object' ? parsed : { value: parsed } };
  } catch {
    return { ok: false, code: 'BAD_REPLY', error: `unreadable answer from the shell: ${String(reply.value).slice(0, 80)}` };
  }
}
