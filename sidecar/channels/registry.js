// The channel registry (phase 4 step 1): the Peak on the owner's phone.
//
//   createChannels({ bus, store, gateQueue, chief, reflect, away, env, keystorePath, clock,
//                    random, log })
//     .register(adapter)       one platform (sidecar/channels/adapter.js contract)
//     .init()                  loads the pairing state (channels.json)
//     .start()                 starts every adapter whose keys resolve; channel.connect
//     .list()                  one row per adapter: status, where the token came from,
//                              the paired chats (no secrets)
//     .pairing()               the current pairing code and its expiry, or null
//     .newPairingCode()        a fresh single-use code (shown at the Peak)
//     .unpair(name, chatId)
//     .connect(name, { token }) / .disconnect(name)   Gate items (account_settings) that
//                              store / remove the bot token in the keystore and (re)start
//     .inbound(name, message)  what an adapter calls for every message (also for tests)
//     .notify(text)            a plain notice to every paired chat
//     .close()
//
// Owner pairing: a chat is trusted only after the 8-character code shown at the Peak was
// sent from it while the code was valid (ten minutes, single use; a new code replaces the
// old one; five wrong codes revoke it). Pairing binds the chat AND the sender (safety
// 2026-10-11 H1): the chat must be a private one-to-one chat with the bot (the adapter
// reports `chatType: 'private'`; a group, channel or guild chat, or one of unknown type,
// cannot pair, and a right code sent from one is revoked because it was exposed), and from
// then on only that user id may act in it: a Gate decision, revise notes, a question for
// the Peak, a command. Another member of the chat, or a later message from a chat that is
// no longer private, is refused and logged with the real sender id. An unpaired chat is
// told how to pair once an hour at most, and every attempt is a channel.inbound
// { paired: false } event. Pairing state is persisted atomically; unpairing is a click at
// the Peak.
//
// Deliveries: every pending Gate item goes to every paired chat as a card with Approve /
// Revise / Reject (Revise asks for notes as the next message); when an item is decided, the
// chats that hold its card hear the outcome; reflections, away digests and answers from the
// Peak go as text. Every send is a channel.delivery { sent | failed }: nothing is shown as
// delivered that the platform did not accept.
//
// Bot tokens come from the environment or the keystore / broker (keys.js) and reach only
// the adapter's start(); they are never in an event, a route or a log line.

import { randomBytes } from 'node:crypto';
import { makeEvent } from '../../shared/events.js';
import { resolveKey, setKey, ENV_VARS } from '../providers/keys.js';
import { assertAdapter, makePairingCode, normalizePairingCode, looksLikePairingCode, parseButtonData, gateCard, cardText } from './adapter.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const NOTES_TTL_MS = 10 * 60 * 1000;
export const UNPAIRED_REPLY_EVERY_MS = 60 * 60 * 1000;
export const MAX_TEXT = 3500;
export const MAX_QUESTION = 2000;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const chatKey = (name, chatId) => `${name}:${chatId}`;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : String(s ?? ''));

export function createChannels({ bus, store, gateQueue = null, chief = null, reflect = null, away = null, env = process.env, keystorePath, clock = { now: () => Date.now() }, random = (n) => randomBytes(n), log = console } = {}) {
  if (!bus || !store) throw new TypeError('createChannels needs bus and store');
  const adapters = new Map(); // name -> { adapter, status, by, detail, lastError, startedAt, pendingItem }
  let state = { version: 1, code: null, chats: {} }; // chats: key -> { channel, chatId, userId, pairedAt }
  const seenUpdates = new Map(); // name -> Set of recent update ids
  const notesPending = new Map(); // chatKey -> { itemId, at }
  const unpairedReplied = new Map(); // chatKey -> ts of the last "not paired" reply
  const cards = new Map(); // itemId -> [{ channel, chatId, messageId }]
  const decidedVia = new Map(); // itemId -> chatKey
  let saving = Promise.resolve();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  const save = () => {
    saving = saving.then(() => store.saveChannels(state)).catch((err) => log.error('channels save failed:', err));
    return saving;
  };

  function entry(name) {
    const e = adapters.get(name);
    if (!e) throw fail('UNKNOWN_CHANNEL', `no channel "${name}"`, 404);
    return e;
  }
  const pairedChats = (name) => Object.values(state.chats).filter((c) => !name || c.channel === name);
  const isPaired = (name, chatId) => Boolean(state.chats[chatKey(name, chatId)]);

  async function keysFor(adapter) {
    const keys = {};
    const missing = [];
    for (const k of adapter.keys) {
      const v = await resolveKey(k, { env, keystorePath, warn: (p) => log.warn && log.warn(p) });
      if (v) keys[k] = v;
      else missing.push(ENV_VARS[k] || k);
    }
    return { keys, missing, by: adapter.keys.every((k) => env[ENV_VARS[k]] && String(env[ENV_VARS[k]]).trim()) ? 'env' : 'keystore' };
  }

  async function startOne(name) {
    const e = entry(name);
    if (e.status === 'up') return e;
    const { keys, missing, by } = await keysFor(e.adapter);
    if (missing.length) {
      e.status = 'not_wired';
      e.missing = missing;
      e.by = null;
      emit('channel.connect', { channel: name, status: 'not_wired', message: `set ${missing.join(', ')}` });
      return e;
    }
    try {
      const started = await e.adapter.start({ keys, onInbound: (m) => api.inbound(name, m).catch((err) => log.error(`channel ${name} inbound failed:`, err)), log });
      e.status = 'up';
      e.by = by;
      e.missing = [];
      e.detail = (started && started.detail) || '';
      e.lastError = null;
      e.startedAt = clock.now();
      emit('channel.connect', { channel: name, status: 'up', message: e.detail, by });
    } catch (err) {
      e.status = 'error';
      e.by = by;
      e.lastError = { at: clock.now(), message: err.message, code: err.code || 'START_FAILED' };
      emit('channel.connect', { channel: name, status: 'error', message: err.message, by });
    }
    return e;
  }

  async function stopOne(name, by = 'superintendent') {
    const e = entry(name);
    if (e.status !== 'up') return e;
    try {
      await e.adapter.stop();
    } catch (err) {
      log.error(`channel ${name} stop failed:`, err);
    }
    e.status = 'down';
    emit('channel.connect', { channel: name, status: 'down', by });
    return e;
  }

  // One send, recorded as a delivery whatever the platform answered.
  async function send(name, chatId, { kind, card = null, text = null, itemId = null, ref = null }) {
    const e = adapters.get(name);
    const payload = { channel: name, chatId, kind };
    if (itemId) payload.itemId = itemId;
    if (ref) payload.ref = ref;
    if (!e || e.status !== 'up') {
      emit('channel.delivery', { ...payload, status: 'failed', error: `channel ${name} is ${e ? e.status : 'unknown'}` });
      return null;
    }
    try {
      let r;
      if (card) {
        try {
          r = e.adapter.buttons ? await e.adapter.sendCard(chatId, card) : await e.adapter.sendText(chatId, cardText(card));
        } catch (err) {
          if (!e.adapter.buttons) throw err;
          r = await e.adapter.sendText(chatId, cardText(card)); // the buttons were refused: the text form still carries the commands
        }
      } else {
        r = await e.adapter.sendText(chatId, clip(text, MAX_TEXT));
      }
      const messageId = r && r.messageId ? String(r.messageId) : '';
      emit('channel.delivery', { ...payload, status: 'sent', ...(messageId ? { messageId } : {}) });
      return { messageId };
    } catch (err) {
      e.lastError = { at: clock.now(), message: err.message, code: err.code || 'SEND_FAILED' };
      emit('channel.delivery', { ...payload, status: 'failed', error: err.message });
      return null;
    }
  }

  async function broadcast(opts, { only = null, except = null } = {}) {
    const out = [];
    for (const c of pairedChats(only)) {
      if (except && chatKey(c.channel, c.chatId) === except) continue;
      const r = await send(c.channel, c.chatId, opts);
      if (r) out.push({ channel: c.channel, chatId: c.chatId, messageId: r.messageId });
    }
    return out;
  }

  // The bus feeds the phone: Gate items as cards, decisions, reflections, digests.
  bus.listen((event) => {
    const p = event.payload;
    if (event.type === 'gate.item') {
      if (p.status === 'pending') {
        broadcast({ kind: 'gate_card', card: gateCard(p), itemId: p.itemId }).then((sent) => { if (sent.length) cards.set(p.itemId, sent); }).catch((err) => log.error('gate card delivery failed:', err));
      } else if (cards.has(p.itemId) || decidedVia.has(p.itemId)) {
        const via = decidedVia.get(p.itemId);
        const where = via ? `via ${via.split(':')[0]}` : p.status === 'expired' ? '' : 'at the park';
        const text = `${p.status.toUpperCase()}${where ? ` ${where}` : ''}: ${clip(p.summary, 200)}${p.notes ? `\nNotes: ${clip(p.notes, 300)}` : ''}${p.reason ? `\n${clip(p.reason, 200)}` : ''}`;
        const holders = cards.get(p.itemId) || [];
        cards.delete(p.itemId);
        decidedVia.delete(p.itemId);
        Promise.all(holders.filter((h) => chatKey(h.channel, h.chatId) !== via).map((h) => send(h.channel, h.chatId, { kind: 'gate_update', text, itemId: p.itemId }))).catch((err) => log.error('gate update delivery failed:', err));
      }
    } else if (event.type === 'reflection.posted') {
      const text = p.status === 'posted' ? `Reflection ${p.reflectionId} (${p.reason}):\n${clip(p.portfolio || '', 1500)}\n${(p.ventures || []).map((v) => `- ${v.id}: plan ${v.planStillRight === false ? 'needs revision' : 'still right'}, $${(v.spentUsd || 0).toFixed(2)} of $${(v.budgetUsd || 0).toFixed(2)}, ${v.itemsDone || 0} done / ${v.itemsFailed || 0} failed`).join('\n')}${p.path ? `\nDocument: ${p.path}` : ''}` : `Reflection ${p.reflectionId} skipped: ${p.skipReason || 'no reason given'}`;
      broadcast({ kind: 'reflection', text, ref: p.reflectionId }).catch((err) => log.error('reflection delivery failed:', err));
    } else if (event.type === 'away.digest') {
      broadcast({ kind: 'digest', text: `Away digest ${p.digestId}: ${p.summary || `${p.actions} action(s), ${p.waiting} waiting`}\nFrom ${new Date(p.since).toISOString()} to ${new Date(p.until).toISOString()}${p.path ? `\nDigest: ${p.path}` : ''}`, ref: p.digestId }).catch((err) => log.error('digest delivery failed:', err));
    }
  });

  function replayed(name, updateId) {
    if (updateId === undefined || updateId === null || updateId === '') return false;
    let seen = seenUpdates.get(name);
    if (!seen) {
      seen = new Set();
      seenUpdates.set(name, seen);
    }
    const id = String(updateId);
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    return false;
  }

  function pairingValid() {
    return Boolean(state.code && state.code.expiresAt > clock.now() && state.code.attempts < PAIRING_MAX_ATTEMPTS);
  }

  function helpText(name) {
    return ['Commands: /gate (items waiting), /approve <item> [notes], /revise <item> <notes>, /reject <item> [notes], /status, /away, /back, /help.', 'Anything else is a question for the Chief Ranger at the Peak, answered from recorded data only.'].join('\n');
  }

  async function statusText() {
    const pending = gateQueue ? gateQueue.pending() : [];
    const st = chief ? chief.state() : null;
    const aw = away ? away.state() : null;
    const latest = reflect ? reflect.latest() : null;
    return [
      `Gate: ${pending.length} waiting${pending.length ? ` (${pending.slice(0, 5).map((it) => `${it.itemId}: ${clip(it.summary, 60)}`).join('; ')})` : ''}`,
      st && st.mission ? `Mission ${st.mission.id}: ${st.mission.status}${st.mission.reason ? ` (${st.mission.reason})` : ''} · plan ${st.plan ? `v${st.plan.version}` : 'none'}` : 'No mission yet',
      st && st.judgeToday ? `Judge today: $${st.judgeToday.usd.toFixed(2)} of $${st.caps.judgeUsdPerDay}` : null,
      aw ? (aw.away ? `Away since ${new Date(aw.since).toISOString()}: ${aw.actions} action(s)` : 'You are marked present') : null,
      latest ? `Last reflection: ${latest.id} ${latest.status}` : 'No reflection yet',
    ].filter(Boolean).join('\n');
  }

  // `userId` is the real sender, checked against the paired user by inbound() before this
  // is reached; every event names the sender, never the chat's owner by assumption.
  async function decide(name, chatId, userId, { itemId, decision, notes = '', messageId }) {
    const key = chatKey(name, chatId);
    const base = { channel: name, chatId, userId, action: 'gate', paired: true, itemId, decision };
    if (messageId) base.messageId = String(messageId);
    if (!gateQueue) {
      emit('channel.inbound', { ...base, outcome: 'refused: no Gate queue' });
      return send(name, chatId, { kind: 'notice', text: 'There is no Entrance Gate queue in this sidecar.' });
    }
    const item = gateQueue.get(itemId);
    if (!item) {
      emit('channel.inbound', { ...base, outcome: 'refused: unknown item' });
      return send(name, chatId, { kind: 'notice', text: `No Gate item "${itemId}".`, itemId });
    }
    if (item.status !== 'pending') {
      emit('channel.inbound', { ...base, outcome: `refused: already ${item.status}` });
      return send(name, chatId, { kind: 'notice', text: `${itemId} is already ${item.status}.`, itemId });
    }
    if (decision === 'revise' && !notes.trim()) {
      if (item.kind === 'proposal') {
        emit('channel.inbound', { ...base, outcome: 'refused: a proposal is approved or rejected' });
        return send(name, chatId, { kind: 'notice', text: `${itemId} is a proposal: approve or reject it.`, itemId });
      }
      notesPending.set(key, { itemId, at: clock.now() });
      emit('channel.inbound', { ...base, outcome: 'notes requested' });
      return send(name, chatId, { kind: 'notice', text: `Revise ${itemId}: reply with your notes for the Ranger (within 10 minutes).`, itemId });
    }
    decidedVia.set(itemId, key);
    try {
      await gateQueue.resolve(itemId, { decision, notes: notes.trim() });
      emit('channel.inbound', { ...base, outcome: 'accepted' });
      return send(name, chatId, { kind: 'gate_update', text: `${decision === 'approve' ? 'Approved' : decision === 'revise' ? 'Sent back for revision' : 'Rejected'}: ${clip(item.summary, 200)}`, itemId });
    } catch (err) {
      decidedVia.delete(itemId);
      emit('channel.inbound', { ...base, outcome: `refused: ${err.code || err.message}` });
      return send(name, chatId, { kind: 'notice', text: `Could not decide ${itemId}: ${err.message}`, itemId });
    }
  }

  async function ask(name, chatId, userId, question, messageId) {
    const base = { channel: name, chatId, userId, action: 'ask', paired: true, text: clip(question, 200) };
    if (messageId) base.messageId = String(messageId);
    if (!chief || typeof chief.ask !== 'function') {
      emit('channel.inbound', { ...base, outcome: 'refused: no Chief' });
      return send(name, chatId, { kind: 'notice', text: 'The Chief Ranger is not wired in this sidecar.' });
    }
    let started;
    try {
      started = await chief.ask({ question: clip(question, MAX_QUESTION), context: reflect ? await reflect.gather({ rollup: false }).catch(() => null) : null, by: `channel:${name}` }); // read-only: a question rolls nothing up (safety 2026-10-11 L6)
    } catch (err) {
      emit('channel.inbound', { ...base, outcome: `refused: ${err.code || err.message}` });
      return send(name, chatId, { kind: 'notice', text: `The Peak cannot answer now: ${err.message}` });
    }
    emit('channel.inbound', { ...base, outcome: 'asked', runId: started.runId });
    await send(name, chatId, { kind: 'notice', text: `Asking the Chief Ranger (run ${started.runId})…`, ref: started.runId });
    const answer = await started.answer;
    const evidence = [`run ${started.runId}`, ...(answer.evidence || [])];
    const text = answer.ok ? `${clip(answer.text || '(no answer)', 2500)}\n\nEvidence: ${evidence.join(' · ')}` : `The Chief could not answer: ${answer.reason}${answer.text ? `\n${clip(answer.text, 500)}` : ''}\nEvidence: ${evidence.join(' · ')}`;
    return send(name, chatId, { kind: 'answer', text, ref: started.runId });
  }

  const api = {
    register(adapter) {
      assertAdapter(adapter);
      if (adapters.has(adapter.name)) throw new TypeError(`channel ${adapter.name} is already registered`);
      adapters.set(adapter.name, { adapter, status: 'down', by: null, detail: '', lastError: null, startedAt: null, missing: [], pendingItem: null });
      return api;
    },
    async init() {
      const loaded = await store.loadChannels(null);
      if (loaded && loaded.version === 1 && loaded.chats && typeof loaded.chats === 'object') state = { version: 1, code: loaded.code || null, chats: loaded.chats };
      return api;
    },
    async start() {
      for (const name of adapters.keys()) await startOne(name);
      return api.list();
    },
    list() {
      return [...adapters.values()].map((e) => ({
        name: e.adapter.name,
        label: e.adapter.label,
        status: e.status,
        buttons: Boolean(e.adapter.buttons),
        by: e.by,
        detail: e.detail,
        missing: e.missing,
        keys: e.adapter.keys.map((k) => ENV_VARS[k] || k),
        lastError: e.lastError,
        startedAt: e.startedAt,
        pendingItemId: e.pendingItem ? e.pendingItem.itemId : null,
        paired: pairedChats(e.adapter.name).map((c) => ({ chatId: c.chatId, userId: c.userId, pairedAt: c.pairedAt })),
      }));
    },
    status: (name) => api.list().find((c) => c.name === name) || null,
    pairing: () => (pairingValid() ? { code: state.code.code, issuedAt: state.code.issuedAt, expiresAt: state.code.expiresAt, attempts: state.code.attempts } : null),
    async newPairingCode() {
      const code = makePairingCode(random);
      const now = clock.now();
      state = { ...state, code: { code, issuedAt: now, expiresAt: now + PAIRING_TTL_MS, attempts: 0 } };
      await save();
      return api.pairing();
    },
    async unpair(name, chatId) {
      entry(name);
      const key = chatKey(name, String(chatId));
      if (!state.chats[key]) throw fail('NOT_PAIRED', `${name} chat ${chatId} is not paired`, 404);
      const was = state.chats[key];
      const chats = { ...state.chats };
      delete chats[key];
      state = { ...state, chats };
      notesPending.delete(key);
      await save();
      emit('channel.inbound', { channel: name, chatId: String(chatId), userId: was.userId || 'unknown', action: 'pair', paired: false, outcome: 'unpaired at the Peak' });
      send(name, String(chatId), { kind: 'notice', text: 'This chat was unpaired at the Peak. It can no longer act on the Gate.' }).catch(() => {});
      return { unpaired: true };
    },
    // Everything an adapter received. Decides pairing, then what a paired chat may do.
    async inbound(name, message) {
      const e = entry(name);
      const chatId = String(message.chatId || '');
      const userId = String(message.userId || '');
      if (!chatId) return null;
      if (replayed(name, message.updateId)) return null;
      const key = chatKey(name, chatId);
      const paired = isPaired(name, chatId);
      const messageId = message.messageId !== undefined ? String(message.messageId) : (message.callback && message.callback.messageId !== undefined ? String(message.callback.messageId) : undefined);
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      const chatType = typeof message.chatType === 'string' ? message.chatType : '';
      const isPrivate = chatType === 'private';
      const base = { channel: name, chatId, userId: userId || 'unknown' };
      if (messageId) base.messageId = messageId;

      if (!paired) {
        // The one thing an unpaired chat can do is send the pairing code, and only a
        // private chat with a sender id can (H1): a group that sees the right code has
        // exposed it, so the code is revoked rather than spent on the group.
        const button = message.callback ? parseButtonData(message.callback.data) : null;
        if (text && looksLikePairingCode(text) && pairingValid() && (!isPrivate || !userId)) {
          const matched = normalizePairingCode(text) === state.code.code;
          if (matched) {
            state = { ...state, code: null };
            await save();
          }
          const why = !userId ? 'no sender id' : `not a private chat (${chatType || 'type unknown'})`;
          log.warn && log.warn(`channel ${name}: chat ${chatId} (user ${userId || 'unknown'}) sent a pairing code from a chat that cannot pair (${why})${matched ? '; the code is revoked' : ''}`);
          emit('channel.inbound', { ...base, action: 'pair', paired: false, outcome: matched ? `refused: ${why}; the code was exposed here and is revoked` : `refused: ${why}` });
          await send(name, chatId, { kind: 'pairing', text: matched ? 'Pairing works only from a private chat with this bot. That code was shown here, so it is revoked; make a new one at the Peak and send it from a private chat.' : 'Pairing works only from a private chat with this bot.' });
          return { paired: false };
        }
        if (text && looksLikePairingCode(text) && pairingValid()) {
          if (normalizePairingCode(text) === state.code.code) {
            const chats = { ...state.chats, [key]: { channel: name, chatId, userId, pairedAt: clock.now() } };
            state = { ...state, code: null, chats };
            await save();
            emit('channel.inbound', { ...base, action: 'pair', paired: true, outcome: 'paired' });
            await send(name, chatId, { kind: 'pairing', text: `Paired with the Mountain Peak. ${helpText(name)}` });
            return { paired: true };
          }
          state = { ...state, code: { ...state.code, attempts: state.code.attempts + 1 } };
          await save();
          const revoked = state.code.attempts >= PAIRING_MAX_ATTEMPTS;
          emit('channel.inbound', { ...base, action: 'pair', paired: false, outcome: revoked ? 'refused: wrong code; the code is revoked' : 'refused: wrong code' });
          await send(name, chatId, { kind: 'pairing', text: revoked ? 'Wrong code. The pairing code is revoked; make a new one at the Peak.' : 'Wrong pairing code.' });
          return { paired: false };
        }
        const action = button ? 'gate' : text && looksLikePairingCode(text) ? 'pair' : 'ignored';
        const payload = { ...base, action, paired: false, outcome: button ? 'refused: not paired' : action === 'pair' ? 'refused: no valid pairing code' : 'ignored: not paired' };
        if (button) {
          payload.itemId = button.itemId;
          payload.decision = button.decision;
          log.warn && log.warn(`channel ${name}: unpaired chat ${chatId} (user ${userId}) tried to ${button.decision} ${button.itemId}; refused`);
        }
        emit('channel.inbound', payload);
        const last = unpairedReplied.get(key) || 0;
        if (button || clock.now() - last >= UNPAIRED_REPLY_EVERY_MS) {
          unpairedReplied.set(key, clock.now());
          await send(name, chatId, { kind: 'pairing', text: 'This chat is not paired with Maka. Send the pairing code shown at the Mountain Peak.' });
        }
        return { paired: false };
      }

      // A paired chat: only the user who paired it acts, and only while it is private (H1).
      const owner = state.chats[key];
      const senderOk = Boolean(userId) && Boolean(owner.userId) && userId === owner.userId;
      if (!senderOk || (chatType && !isPrivate)) {
        const button = message.callback ? parseButtonData(message.callback.data) : null;
        const action = button ? 'gate' : text.startsWith('/') ? 'command' : text ? 'ask' : 'ignored';
        const why = !senderOk ? 'not the paired user' : `not a private chat (${chatType})`;
        const payload = { ...base, action, paired: false, outcome: `refused: ${why}` };
        if (button) {
          payload.itemId = button.itemId;
          payload.decision = button.decision;
        }
        if (text && !button) payload.text = clip(text, 200);
        log.warn && log.warn(`channel ${name}: ${why} in paired chat ${chatId}: user ${userId || 'unknown'} (paired user ${owner.userId || 'unknown'}) tried to ${button ? `${button.decision} ${button.itemId}` : action === 'ignored' ? 'send nothing' : action}; refused`);
        emit('channel.inbound', payload);
        if (button || text.startsWith('/')) await send(name, chatId, { kind: 'notice', text: !senderOk ? 'Only the user who paired this chat with the Mountain Peak can act here.' : 'This chat is no longer a private chat with the bot; unpair it at the Peak and pair again from a private chat.' });
        return { paired: false };
      }
      if (message.callback) {
        const button = parseButtonData(message.callback.data);
        if (!button) {
          emit('channel.inbound', { ...base, action: 'ignored', paired: true, outcome: 'ignored: unknown button' });
          return null;
        }
        return decide(name, chatId, userId, { itemId: button.itemId, decision: button.decision, messageId });
      }
      if (!text) {
        emit('channel.inbound', { ...base, action: 'ignored', paired: true, outcome: 'ignored: no text' });
        return null;
      }
      const waiting = notesPending.get(key);
      if (waiting && !text.startsWith('/')) {
        notesPending.delete(key);
        if (clock.now() - waiting.at > NOTES_TTL_MS) {
          emit('channel.inbound', { ...base, action: 'notes', paired: true, outcome: 'refused: the notes came too late', itemId: waiting.itemId });
          return send(name, chatId, { kind: 'notice', text: `The revise notes for ${waiting.itemId} came too late; press Revise again.`, itemId: waiting.itemId });
        }
        emit('channel.inbound', { ...base, action: 'notes', paired: true, outcome: 'accepted', itemId: waiting.itemId, decision: 'revise', text: clip(text, 200) });
        return decide(name, chatId, userId, { itemId: waiting.itemId, decision: 'revise', notes: text, messageId });
      }
      if (text.startsWith('/')) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        const command = cmd.toLowerCase().replace(/@.*$/, '');
        const outcomeOf = (o) => emit('channel.inbound', { ...base, action: 'command', paired: true, outcome: o, text: `/${command}` });
        if (['approve', 'revise', 'reject'].includes(command)) {
          const itemId = rest[0];
          if (!itemId) {
            outcomeOf('refused: no item id');
            return send(name, chatId, { kind: 'notice', text: `Usage: /${command} <item id>${command === 'revise' ? ' <notes>' : ' [notes]'}` });
          }
          return decide(name, chatId, userId, { itemId, decision: command, notes: rest.slice(1).join(' '), messageId });
        }
        if (command === 'gate') {
          const pending = gateQueue ? gateQueue.pending() : [];
          outcomeOf(`listed ${pending.length}`);
          if (!pending.length) return send(name, chatId, { kind: 'notice', text: 'Nothing is waiting at the Gate.' });
          for (const it of pending.slice(0, 10)) {
            const r = await send(name, chatId, { kind: 'gate_card', card: gateCard(it), itemId: it.itemId });
            if (r) cards.set(it.itemId, [...(cards.get(it.itemId) || []).filter((h) => chatKey(h.channel, h.chatId) !== key), { channel: name, chatId, messageId: r.messageId }]);
          }
          return null;
        }
        if (command === 'status') {
          outcomeOf('status');
          return send(name, chatId, { kind: 'notice', text: await statusText() });
        }
        if (command === 'away' || command === 'back') {
          if (!away) {
            outcomeOf('refused: no away mode');
            return send(name, chatId, { kind: 'notice', text: 'Away mode is not wired.' });
          }
          const r = await away.set(command === 'away');
          outcomeOf(command === 'away' ? 'away on' : 'away off');
          return send(name, chatId, { kind: 'notice', text: command === 'away' ? 'Away mode is on: every Gate decision is logged as evidence.' : r.digest ? `Welcome back. ${r.digest.actions} action(s), ${r.digest.waiting} waiting; digest ${r.digest.path}` : 'You were already marked present.' });
        }
        if (command === 'help' || command === 'start') {
          outcomeOf('help');
          return send(name, chatId, { kind: 'notice', text: helpText(name) });
        }
        outcomeOf('refused: unknown command');
        return send(name, chatId, { kind: 'notice', text: `Unknown command /${command}. ${helpText(name)}` });
      }
      return ask(name, chatId, userId, text, messageId);
    },
    notify: (text) => broadcast({ kind: 'notice', text }),
    // The bot token through the Gate (account_settings), like a connector key (D75).
    async connect(name, { token } = {}) {
      const e = entry(name);
      if (typeof token !== 'string' || !token.trim()) throw fail('BAD_REQUEST', `${e.adapter.label} needs a bot token`);
      if (e.adapter.keys.length !== 1) throw fail('BAD_REQUEST', `${e.adapter.label} takes ${e.adapter.keys.map((k) => ENV_VARS[k] || k).join(' and ')} from the environment or the keystore`);
      const key = token.trim();
      return gated(name, { tool: 'channel.connect', summary: `connect ${e.adapter.label} with a bot token`, reason: `${e.adapter.label}'s bot token is stored in the keystore only with your approval`, evidence: [{ kind: 'input', text: `${e.adapter.label} token ending in …${key.slice(-4)}` }], onApprove: async () => { await setKey(e.adapter.keys[0], key, { env, keystorePath }); await startOne(name); } });
    },
    async disconnect(name) {
      const e = entry(name);
      if (e.status !== 'up' && e.status !== 'error') throw fail('NOT_CONNECTED', `${e.adapter.label} is not connected`, 409);
      return gated(name, { tool: 'channel.disconnect', summary: `disconnect ${e.adapter.label}`, reason: `${e.adapter.label}'s bot token is removed from the keystore only with your approval${e.by === 'env' ? `; it is also set in the environment, which Maka cannot unset` : ''}`, evidence: [{ kind: 'input', text: `${e.adapter.label}: token from ${e.by || 'the keystore'}, ${pairedChats(name).length} paired chat(s) kept` }], onApprove: async () => { for (const k of e.adapter.keys) await setKey(k, null, { env, keystorePath }); await stopOne(name); } });
    },
    async close() {
      for (const name of adapters.keys()) {
        const e = adapters.get(name);
        if (e.status === 'up') {
          try {
            await e.adapter.stop();
          } catch (err) {
            log.error(`channel ${name} stop failed:`, err);
          }
          e.status = 'down';
        }
      }
    },
    flushed: () => saving,
    cardHolders: (itemId) => (cards.get(itemId) || []).slice(),
  };

  async function gated(name, { tool, summary, reason, evidence, onApprove }) {
    const e = entry(name);
    if (!gateQueue) throw fail('GATE_UNAVAILABLE', 'no Entrance Gate queue to decide channel credentials', 503);
    if (e.pendingItem) throw fail('PENDING', `${e.adapter.label} already has a decision waiting at the Gate (${e.pendingItem.itemId})`, 409);
    const decision = gateQueue.submit({ agentId: 'superintendent', domain: 'account_settings', tool, summary, level: 'draft', evidence, reason });
    const item = gateQueue.pending().find((it) => it.tool === tool && it.summary === summary) || null;
    e.pendingItem = item;
    decision
      .then(async (d) => {
        e.pendingItem = null;
        if (d.decision !== 'approve') {
          emit('channel.connect', { channel: name, status: e.status === 'up' ? 'up' : 'down', message: `${tool} ${d.decision === 'revise' ? 'sent back' : d.status === 'expired' ? 'expired' : 'rejected'} at the Gate${d.notes ? `: ${d.notes}` : ''}`, by: 'superintendent' });
          return;
        }
        try {
          await onApprove(d);
        } catch (err) {
          e.lastError = { at: clock.now(), message: err.message, code: err.code || 'CONNECT_FAILED' };
          emit('channel.connect', { channel: name, status: 'error', message: err.message, by: 'superintendent' });
        }
      })
      .catch((err) => log.error && log.error(`channel ${name} gate failed:`, err));
    return { itemId: item ? item.itemId : null, status: 'pending' };
  }

  return api;
}
