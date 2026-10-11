// Slack (phase 4 step 3): Socket Mode for what the owner sends, the Web API over `fetch`
// for what Maka sends, core modules only.
//
//   createSlackAdapter({ fetch, netGuard, apiUrl, WebSocketImpl, log })
//     -> an adapter for sidecar/channels/registry.js (keys: slackBot, slackApp)
//
// Two tokens, as Slack designs it: the bot token (xoxb) signs Web API calls (auth.test,
// chat.postMessage), the app-level token (xapp) opens the Socket Mode connection
// (apps.connections.open). Every envelope is acknowledged by envelope_id before it is
// handed in; `message` events from humans are inbound text (the bot's own and other bots'
// are skipped) carrying `chatType` from Slack's channel_type (only an `im`, the owner's DM
// with the bot, is private and may pair: safety 2026-10-11 H1), `block_actions` presses
// are callbacks with the button's value; a
// `disconnect` from Slack or a closed socket reconnects with backoff until stop(). Cards
// are plain_text blocks with one actions row; text is posted with mrkdwn off, so nothing
// a Ranger wrote is formatting. Socket Mode needs no public endpoint.

import { guardedFetch, defaultNetGuard } from '../netguard.js';
import { openGuardedSocket, backoffAt, sleepUnless } from './ws.js';
import { cardText } from './adapter.js';

export const SLACK_API = 'https://slack.com/api';
export const MAX_TEXT = 3000; // a plain_text block's limit
const STYLE = { approve: 'primary', reject: 'danger' };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createSlackAdapter({ fetch: fetchImpl = globalThis.fetch, netGuard = defaultNetGuard(), apiUrl = SLACK_API, WebSocketImpl = globalThis.WebSocket, log = console } = {}) {
  let tokens = null;
  let onInbound = null;
  let controller = null;
  let socket = null;
  let loop = null;
  const base = String(apiUrl).replace(/\/+$/, '');

  async function api(method, body, which = 'slackBot') {
    if (!tokens) throw fail('NOT_STARTED', 'slack adapter is not started');
    let res;
    try {
      res = await guardedFetch(`${base}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${tokens[which]}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body || {}) }, { fetch: fetchImpl, guard: netGuard });
    } catch (err) {
      if (err && err.code === 'NET_GUARD') throw fail('NET_GUARD', err.message);
      throw fail('NETWORK', `slack ${method}: ${err && err.code ? err.code : err && err.cause && err.cause.code ? err.cause.code : 'network error'}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || data.ok !== true) {
      const error = data && data.error ? String(data.error) : `HTTP ${res.status}`;
      throw fail(error === 'invalid_auth' || error === 'not_authed' || error === 'token_revoked' ? 'UNAUTHORIZED' : `SLACK_${error.toUpperCase()}`, `slack ${method}: ${error}`);
    }
    return data;
  }

  function deliver(message) {
    if (!onInbound) return;
    Promise.resolve(onInbound(message)).catch((err) => log.error && log.error('slack inbound failed:', err));
  }

  function handle(ws, msg) {
    if (msg.type === 'disconnect') {
      ws.close(1000, 'slack asked to reconnect').catch(() => {});
      return;
    }
    if (!msg.envelope_id) return; // hello and the like
    try { ws.send({ envelope_id: msg.envelope_id }); } catch { /* closed */ }
    const p = msg.payload || {};
    if (msg.type === 'events_api' && p.event && p.event.type === 'message') {
      const ev = p.event;
      if (ev.bot_id || ev.subtype || !ev.channel || !ev.user) return;
      deliver({ updateId: String(ev.client_msg_id || `${ev.channel}:${ev.ts}`), chatId: String(ev.channel), userId: String(ev.user), chatType: ev.channel_type === 'im' ? 'private' : typeof ev.channel_type === 'string' && ev.channel_type ? ev.channel_type : 'unknown', text: typeof ev.text === 'string' ? ev.text : '', messageId: String(ev.ts || '') });
    } else if (msg.type === 'interactive' && p.type === 'block_actions' && p.channel && p.user && Array.isArray(p.actions) && p.actions.length) {
      const a = p.actions[0];
      // block_actions name the channel but not its type; the registry pairs on text
      // messages only (those carry channel_type) and checks the sender on presses (H1).
      const chatType = p.channel.name === 'directmessage' ? 'private' : typeof p.channel.name === 'string' && p.channel.name ? 'channel' : undefined;
      deliver({ updateId: String(msg.envelope_id), chatId: String(p.channel.id), userId: String(p.user.id), ...(chatType ? { chatType } : {}), callback: { id: String(msg.envelope_id), data: String(a.value || a.action_id || ''), messageId: p.message ? String(p.message.ts || '') : '' } });
    }
  }

  async function connectOnce(signal) {
    const opened = await api('apps.connections.open', {}, 'slackApp');
    if (!opened || typeof opened.url !== 'string') throw fail('BAD_RESPONSE', 'slack apps.connections.open answered without a url');
    const ref = {};
    const ws = await openGuardedSocket(opened.url, { netGuard, WebSocketImpl, log, onMessage: (msg) => handle(ref.ws, msg) });
    ref.ws = ws;
    socket = ws;
    if (signal.aborted) {
      await ws.close();
      return;
    }
    await ws.closed_;
    if (socket === ws) socket = null;
  }

  async function run(signal) {
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        await connectOnce(signal);
        if (Date.now() - started > 60_000) failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        log.warn && log.warn(`slack socket mode failed (${err.code || 'error'}): ${err.message}; reconnecting in ${backoffAt(failures) / 1000}s`);
        await sleepUnless(backoffAt(failures), signal);
        continue;
      }
      if (signal.aborted) return;
      failures += 1;
      await sleepUnless(backoffAt(failures), signal);
    }
  }

  return {
    name: 'slack',
    label: 'Slack',
    keys: ['slackBot', 'slackApp'],
    buttons: true,
    async start({ keys, onInbound: handler }) {
      tokens = { slackBot: keys.slackBot, slackApp: keys.slackApp };
      onInbound = handler;
      const me = await api('auth.test', {});
      const opened = await api('apps.connections.open', {}, 'slackApp');
      if (!opened || typeof opened.url !== 'string') throw fail('BAD_RESPONSE', 'slack apps.connections.open answered without a url');
      controller = new AbortController();
      const ref = {};
      ref.ws = await openGuardedSocket(opened.url, { netGuard, WebSocketImpl, log, onMessage: (msg) => handle(ref.ws, msg) });
      socket = ref.ws;
      const signal = controller.signal;
      loop = (async () => {
        await ref.ws.closed_;
        if (socket === ref.ws) socket = null;
        if (!signal.aborted) await sleepUnless(backoffAt(1), signal);
        await run(signal);
      })().catch((err) => log.error && log.error('slack socket loop stopped:', err));
      return { detail: `socket mode as ${me.user || me.user_id}${me.team ? ` in ${me.team}` : ''}` };
    },
    async stop() {
      if (controller) controller.abort();
      controller = null;
      if (socket) await socket.close().catch(() => {});
      socket = null;
      if (loop) await loop;
      loop = null;
      tokens = null;
      onInbound = null;
    },
    async sendCard(chatId, card) {
      const clipBlock = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
      const blocks = [{ type: 'section', text: { type: 'plain_text', text: clipBlock(card.title || '(card)'), emoji: false } }];
      if ((card.lines || []).length) blocks.push({ type: 'section', text: { type: 'plain_text', text: clipBlock(card.lines.join('\n')), emoji: false } });
      if ((card.buttons || []).length) blocks.push({ type: 'actions', block_id: card.itemId ? `gate-${card.itemId}` : 'card', elements: card.buttons.slice(0, 5).map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label, emoji: false }, action_id: b.data, value: b.data, ...(STYLE[b.label.toLowerCase()] ? { style: STYLE[b.label.toLowerCase()] } : {}) })) });
      const r = await api('chat.postMessage', { channel: String(chatId), text: cardText(card), blocks, mrkdwn: false });
      return { messageId: String(r.ts || '') };
    },
    async sendText(chatId, text) {
      const r = await api('chat.postMessage', { channel: String(chatId), text, mrkdwn: false });
      return { messageId: String(r.ts || '') };
    },
    connected: () => Boolean(socket && !socket.closed),
  };
}
