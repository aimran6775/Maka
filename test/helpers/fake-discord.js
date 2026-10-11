// A fake Discord: the REST paths the adapter uses (/users/@me, /gateway/bot,
// /channels/:id/messages, /interactions/:id/:token/callback) with the `Bot <token>` check
// and Discord-shaped errors, plus a gateway on a WebSocket: Hello (op 10) with a short
// heartbeat interval, Identify checked (op 2), Ready (op 0 READY), heartbeats ACKed
// (op 11), and `message()` / `press()` dispatch MESSAGE_CREATE / INTERACTION_CREATE to
// every identified socket. Test-only.
import { startWsHttpServer } from './ws-server.js';

export async function startFakeDiscord({ token = 'MTIz.fake.discord-token', username = 'maka-bot', heartbeatMs = 200 } = {}) {
  const state = { calls: [], sent: [], acks: [], identifies: [], heartbeats: 0, sockets: new Set(), nextId: 9000, fail: null, seq: 0 };
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = await startWsHttpServer({
    wsPath: '/gateway',
    onRequest(req, res, raw) {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      const authed = req.headers.authorization === `Bot ${token}`;
      state.calls.push({ method: req.method, path: url.pathname, body, authed });
      if (state.fail) return json(res, state.fail.status || 500, { message: state.fail.message || 'Internal Server Error', code: 0 });
      if (url.pathname.startsWith('/api/v10/interactions/')) {
        const [, , , , id] = url.pathname.split('/');
        state.acks.push({ id, type: body && body.type });
        res.writeHead(204);
        return res.end();
      }
      if (!authed) return json(res, 401, { message: '401: Unauthorized', code: 0 });
      if (req.method === 'GET' && url.pathname === '/api/v10/users/@me') return json(res, 200, { id: '1', username, bot: true });
      if (req.method === 'GET' && url.pathname === '/api/v10/gateway/bot') return json(res, 200, { url: server.wsUrl, shards: 1, session_start_limit: { total: 1000, remaining: 999 } });
      const m = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        if (m[1] === '404') return json(res, 404, { message: 'Unknown Channel', code: 10003 });
        if (typeof body.content === 'string' && body.content.length > 2000) return json(res, 400, { message: 'Invalid Form Body', code: 50035, errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' }] } } });
        const id = String(state.nextId++);
        state.sent.push({ chatId: m[1], content: body.content, components: body.components || null, id });
        return json(res, 200, { id, channel_id: m[1], content: body.content, components: body.components || [] });
      }
      json(res, 404, { message: '404: Not Found', code: 0 });
    },
    onSocket(conn) {
      state.sockets.add(conn);
      conn.identified = false;
      conn.send({ op: 10, d: { heartbeat_interval: heartbeatMs } });
      conn.onMessage((msg) => {
        if (msg.op === 2) {
          state.identifies.push(msg.d);
          if (msg.d.token !== token) return conn.send({ op: 9, d: false });
          conn.identified = true;
          conn.send({ op: 0, t: 'READY', s: ++state.seq, d: { v: 10, session_id: `sess-${state.identifies.length}`, resume_gateway_url: server.wsUrl, user: { id: '1', username } } });
        } else if (msg.op === 1) {
          state.heartbeats += 1;
          conn.send({ op: 11 });
        }
      });
      conn.onClose(() => state.sockets.delete(conn));
    },
  });
  const dispatch = (t, d) => {
    for (const c of state.sockets) if (c.identified) c.send({ op: 0, t, s: ++state.seq, d });
  };
  let n = 0;
  return {
    ...server,
    token,
    username,
    state,
    restUrl: `${server.httpUrl}/api/v10`,
    message({ chatId, userId = chatId, text, id, guildId = null }) {
      const mid = id || `m-${++n}`;
      dispatch('MESSAGE_CREATE', { id: mid, channel_id: String(chatId), ...(guildId ? { guild_id: String(guildId) } : {}), author: { id: String(userId), username: 'owner', bot: false }, content: text });
      return mid;
    },
    botMessage({ chatId, text }) {
      dispatch('MESSAGE_CREATE', { id: `b-${++n}`, channel_id: String(chatId), author: { id: '1', username, bot: true }, content: text });
    },
    press({ chatId, userId = chatId, data, messageId = '9000', id, guildId = null }) {
      const iid = id || `i-${++n}`;
      dispatch('INTERACTION_CREATE', { id: iid, token: `itoken-${iid}`, type: 3, channel_id: String(chatId), ...(guildId ? { guild_id: String(guildId), member: { user: { id: String(userId), username: 'owner' } } } : { user: { id: String(userId), username: 'owner' } }), message: { id: String(messageId) }, data: { custom_id: data, component_type: 2 } });
      return iid;
    },
    reconnectAll() { dispatch('RECONNECT', null); for (const c of state.sockets) c.send({ op: 7, d: null }); },
    sentTo: (chatId) => state.sent.filter((s) => s.chatId === String(chatId)),
  };
}
