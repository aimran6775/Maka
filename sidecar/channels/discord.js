// Discord (phase 4 step 3): the Gateway over a WebSocket for what the owner sends, the
// REST API over `fetch` for what Maka sends, both with core modules only.
//
//   createDiscordAdapter({ fetch, netGuard, restUrl, WebSocketImpl, log })
//     -> an adapter for sidecar/channels/registry.js (keys: discordBot)
//
// start() verifies the token (GET /users/@me), asks for the gateway URL (GET
// /gateway/bot), opens the socket through the outbound guard, identifies with the
// DIRECT_MESSAGES intent only (the owner's chat with the bot is a DM; no guild content is
// read) and heartbeats as told. MESSAGE_CREATE from a human becomes an inbound text, with
// `chatType: 'private'` only when no guild_id is on it (a guild message or interaction,
// should one arrive, is 'guild' and cannot pair: safety 2026-10-11 H1);
// INTERACTION_CREATE for a button press is acknowledged at once (a deferred update, so
// Discord stops the spinner) and handed in as a callback with the button's custom_id. A
// closed socket, a RECONNECT or an invalid session reconnect with backoff until stop().
// Cards are a message with one action row of buttons; text is plain, clipped at 2000.
// The token goes in the Authorization header only and is never in an error or an event.

import { guardedFetch, defaultNetGuard } from '../netguard.js';
import { openGuardedSocket, backoffAt, sleepUnless } from './ws.js';

export const DISCORD_API = 'https://discord.com/api/v10';
export const INTENT_DIRECT_MESSAGES = 1 << 12;
export const MAX_CONTENT = 2000;
const STYLE = { approve: 3, revise: 1, reject: 4 }; // success, primary, danger
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createDiscordAdapter({ fetch: fetchImpl = globalThis.fetch, netGuard = defaultNetGuard(), restUrl = DISCORD_API, WebSocketImpl = globalThis.WebSocket, log = console } = {}) {
  let token = null;
  let onInbound = null;
  let controller = null;
  let socket = null;
  let heartbeat = null;
  let loop = null;
  let gatewayUrl = null;
  const base = String(restUrl).replace(/\/+$/, '');

  async function rest(method, path, body, { auth = true } = {}) {
    if (!token) throw fail('NOT_STARTED', 'discord adapter is not started');
    let res;
    try {
      res = await guardedFetch(`${base}${path}`, { method, headers: { ...(auth ? { authorization: `Bot ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { fetch: fetchImpl, guard: netGuard });
    } catch (err) {
      if (err && err.code === 'NET_GUARD') throw fail('NET_GUARD', err.message);
      throw fail('NETWORK', `discord ${method} ${path}: ${err && err.code ? err.code : err && err.cause && err.cause.code ? err.cause.code : 'network error'}`);
    }
    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = data && data.message ? String(data.message) : `HTTP ${res.status}`;
      throw fail(res.status === 401 ? 'UNAUTHORIZED' : `HTTP_${res.status}`, `discord ${method} ${path}: ${message}${data && data.code ? ` (code ${data.code})` : ''}`);
    }
    return data;
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  async function connectOnce(signal) {
    const ws = await openGuardedSocket(`${gatewayUrl}${gatewayUrl.includes('?') ? '&' : '?'}v=10&encoding=json`, {
      netGuard,
      WebSocketImpl,
      log,
      onMessage: (msg) => handle(ws, msg),
    });
    socket = ws;
    if (signal.aborted) {
      await ws.close();
      return;
    }
    await ws.closed_;
    stopHeartbeat();
    if (socket === ws) socket = null;
  }

  function handle(ws, msg) {
    if (msg.op === OP.HELLO) {
      stopHeartbeat();
      const every = Math.max(1000, Number(msg.d && msg.d.heartbeat_interval) || 41250);
      heartbeat = setInterval(() => { try { ws.send({ op: OP.HEARTBEAT, d: null }); } catch { /* closed */ } }, every);
      ws.send({ op: OP.IDENTIFY, d: { token, intents: INTENT_DIRECT_MESSAGES, properties: { os: process.platform, browser: 'maka', device: 'maka' } } });
      return;
    }
    if (msg.op === OP.HEARTBEAT) {
      try { ws.send({ op: OP.HEARTBEAT, d: null }); } catch { /* closed */ }
      return;
    }
    if (msg.op === OP.RECONNECT || msg.op === OP.INVALID_SESSION) {
      ws.close(4000, 'reconnect requested').catch(() => {});
      return;
    }
    if (msg.op !== OP.DISPATCH) return;
    if (msg.t === 'MESSAGE_CREATE' && msg.d && msg.d.author && !msg.d.author.bot && msg.d.channel_id) {
      deliver({ updateId: String(msg.d.id), chatId: String(msg.d.channel_id), userId: String(msg.d.author.id), chatType: msg.d.guild_id ? 'guild' : 'private', text: typeof msg.d.content === 'string' ? msg.d.content : '', messageId: String(msg.d.id) });
    } else if (msg.t === 'INTERACTION_CREATE' && msg.d && msg.d.type === 3 && msg.d.data && msg.d.channel_id) {
      const user = msg.d.user || (msg.d.member && msg.d.member.user) || {};
      rest('POST', `/interactions/${msg.d.id}/${msg.d.token}/callback`, { type: 6 }, { auth: false }).catch((err) => log.warn && log.warn(`discord interaction ack: ${err.message}`));
      deliver({ updateId: String(msg.d.id), chatId: String(msg.d.channel_id), userId: String(user.id || ''), chatType: msg.d.guild_id ? 'guild' : 'private', callback: { id: String(msg.d.id), data: String(msg.d.data.custom_id || ''), messageId: msg.d.message ? String(msg.d.message.id) : '' } });
    }
  }

  function deliver(message) {
    if (!onInbound) return;
    Promise.resolve(onInbound(message)).catch((err) => log.error && log.error('discord inbound failed:', err));
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
        log.warn && log.warn(`discord gateway failed (${err.code || 'error'}): ${err.message}; reconnecting in ${backoffAt(failures) / 1000}s`);
        await sleepUnless(backoffAt(failures), signal);
        continue;
      }
      if (signal.aborted) return;
      failures += 1;
      await sleepUnless(backoffAt(failures), signal);
    }
  }

  return {
    name: 'discord',
    label: 'Discord',
    keys: ['discordBot'],
    buttons: true,
    async start({ keys, onInbound: handler }) {
      token = keys.discordBot;
      onInbound = handler;
      const me = await rest('GET', '/users/@me');
      const gw = await rest('GET', '/gateway/bot');
      if (!gw || typeof gw.url !== 'string') throw fail('BAD_RESPONSE', 'discord gateway/bot answered without a url');
      gatewayUrl = gw.url;
      controller = new AbortController();
      const first = openGuardedSocket(`${gatewayUrl}?v=10&encoding=json`, { netGuard, WebSocketImpl, log, onMessage: (msg) => handle(socketRef.ws, msg) });
      const socketRef = {};
      socketRef.ws = await first; // the first connection must open, so a bad gateway fails start() plainly
      socket = socketRef.ws;
      const signal = controller.signal;
      loop = (async () => {
        await socketRef.ws.closed_;
        stopHeartbeat();
        if (socket === socketRef.ws) socket = null;
        if (!signal.aborted) await sleepUnless(backoffAt(1), signal);
        await run(signal);
      })().catch((err) => log.error && log.error('discord gateway loop stopped:', err));
      return { detail: `gateway as ${me.username || me.id} (DMs only)` };
    },
    async stop() {
      if (controller) controller.abort();
      controller = null;
      stopHeartbeat();
      if (socket) await socket.close().catch(() => {});
      socket = null;
      if (loop) await loop;
      loop = null;
      token = null;
      onInbound = null;
    },
    async sendCard(chatId, card) {
      const components = (card.buttons || []).length ? [{ type: 1, components: (card.buttons || []).slice(0, 5).map((b) => ({ type: 2, style: STYLE[b.label.toLowerCase()] || 2, label: b.label, custom_id: b.data })) }] : [];
      const content = [card.title, ...(card.lines || [])].join('\n');
      const r = await rest('POST', `/channels/${encodeURIComponent(chatId)}/messages`, { content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT - 1)}…` : content, components });
      return { messageId: String(r && r.id ? r.id : '') };
    },
    async sendText(chatId, text) {
      const r = await rest('POST', `/channels/${encodeURIComponent(chatId)}/messages`, { content: text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text });
      return { messageId: String(r && r.id ? r.id : '') };
    },
    connected: () => Boolean(socket && !socket.closed),
  };
}
