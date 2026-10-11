// The channel adapter contract (phase 4 step 1): how the Peak reaches the owner's phone.
//
// An adapter is one messaging platform (Telegram, Discord, Slack) behind one small shape;
// the registry (registry.js) owns pairing, the Gate, the deliveries and every event, so an
// adapter is transport only and never decides who may act.
//
//   adapter = {
//     name: 'telegram',            // the channel id in every event
//     label: 'Telegram',
//     keys: ['telegramBot'],       // keystore / ENV_VARS names the registry resolves for it
//     buttons: true,               // true when sendCard can show inline buttons
//     async start({ keys, onInbound, log }) -> { detail }   // detail: a line for the Peak (the bot's name)
//     async stop(),
//     async sendCard(chatId, card) -> { messageId },         // throws on a platform refusal
//     async sendText(chatId, text) -> { messageId },
//   }
//
// Inbound messages reach the registry through `onInbound(message)`:
//   { chatId, userId, text?, messageId?, callback?: { data, messageId }, updateId? }
// A `callback` is a button press carrying the button's `data`; `updateId` lets the registry
// drop a replayed update. Every field is a string.
//
// A card is channel-neutral: { kind, title, lines, buttons: [{ label, data }], itemId? }.
// `cardText(card)` renders it as plain text with the slash commands that do what the
// buttons do, for adapters without buttons and as the fallback when a platform refuses
// the buttons.

const ADAPTER_METHODS = Object.freeze(['start', 'stop', 'sendCard', 'sendText']);

export function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('an adapter is an object');
  if (typeof adapter.name !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(adapter.name)) throw new TypeError('an adapter needs a name of lowercase letters, digits and underscores');
  if (typeof adapter.label !== 'string' || !adapter.label) throw new TypeError(`adapter ${adapter.name} needs a label`);
  if (!Array.isArray(adapter.keys) || !adapter.keys.length || adapter.keys.some((k) => typeof k !== 'string' || !k)) throw new TypeError(`adapter ${adapter.name} must name the keys it needs`);
  for (const m of ADAPTER_METHODS) if (typeof adapter[m] !== 'function') throw new TypeError(`adapter ${adapter.name} lacks ${m}()`);
  return adapter;
}

// The pairing code: 8 characters from an alphabet without 0 / O / 1 / I, so it can be read
// off the Peak and typed on a phone. `random(n)` gives n bytes (injectable for tests).
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;

export function makePairingCode(random) {
  const bytes = random(PAIRING_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  return out;
}

export function normalizePairingCode(text) {
  return String(text || '').trim().replace(/^\/pair\s+/i, '').replace(/[\s-]/g, '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I');
}

export function looksLikePairingCode(text) {
  const s = normalizePairingCode(text);
  return s.length === PAIRING_CODE_LENGTH && [...s].every((c) => PAIRING_ALPHABET.includes(c));
}

// Button callback data: `gate:<itemId>:<decision>`; short enough for every platform.
export function gateButtonData(itemId, decision) {
  return `gate:${itemId}:${decision}`;
}

export function parseButtonData(data) {
  const m = /^gate:([A-Za-z0-9_.:-]{1,120}):(approve|revise|reject)$/.exec(String(data || ''));
  return m ? { kind: 'gate', itemId: m[1], decision: m[2] } : null;
}

const MAX_LINE = 300;
const clip = (s, n = MAX_LINE) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : String(s ?? ''));

// A Gate item as a card. The evidence is bounded (chat messages are small); the decision
// buttons carry the item id; the text form names the slash commands.
export function gateCard(item) {
  const lines = [];
  lines.push(`${item.agentId} · ${item.domain} · ${item.level || 'draft'}${typeof item.amountUsd === 'number' ? ` · $${item.amountUsd.toFixed(2)}` : item.kind === 'action' && item.domain === 'money_out' ? ' · amount not provable' : ''}`);
  if (item.kind === 'proposal' && item.proposal) lines.push(`Proposal: ${item.proposal.from} → ${item.proposal.to}`);
  if (item.reason) lines.push(clip(`Reason: ${item.reason}`));
  for (const e of (item.evidence || []).slice(0, 4)) lines.push(clip(`${e.kind}: ${e.text}`));
  if ((item.evidence || []).length > 4) lines.push(`(+${item.evidence.length - 4} more evidence lines at the Gate)`);
  if (item.away) lines.push('(you are marked away)');
  const buttons = [{ label: 'Approve', data: gateButtonData(item.itemId, 'approve') }];
  if (item.kind !== 'proposal') buttons.push({ label: 'Revise', data: gateButtonData(item.itemId, 'revise') });
  buttons.push({ label: 'Reject', data: gateButtonData(item.itemId, 'reject') });
  return { kind: 'gate_card', itemId: item.itemId, title: `Gate: ${clip(item.summary, 200)}`, lines, buttons };
}

export function cardText(card) {
  const out = [card.title, ...(card.lines || [])];
  if (card.itemId && card.buttons && card.buttons.length) out.push('', `Reply: ${card.buttons.map((b) => `/${b.label.toLowerCase()} ${card.itemId}`).join(' · ')}`);
  return out.join('\n');
}

export { ADAPTER_METHODS };
