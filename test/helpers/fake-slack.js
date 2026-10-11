// A fake Slack: the Web API methods the adapter uses (auth.test with the bot token,
// apps.connections.open with the app-level token, chat.postMessage) answering in Slack's
// { ok, error } shape, plus Socket Mode on a WebSocket: `hello` on connect, envelopes
// for events_api (message) and interactive (block_actions) that must be acknowledged by
// envelope_id, and a `disconnect` the test can send. Test-only.
import { startWsHttpServer } from './ws-server.js';

export async function startFakeSlack({ botToken = 'xoxb-fake-bot', appToken = 'xapp-fake-app', botName = 'maka', pendingAckMs = 0 } = {}) {
  const state = { calls: [], sent: [], acks: [], sockets: new Set(), nextTs: 1700000000.0001, fail: null, opens: 0 };
  const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = await startWsHttpServer({
    wsPath: '/link',
    onRequest(req, res, raw) {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ method: url.pathname.slice('/api/'.length), body, bearer: bearer === botToken ? 'bot' : bearer === appToken ? 'app' : bearer ? 'wrong' : null });
      if (state.fail) return json(res, { ok: false, error: state.fail });
      if (url.pathname === '/api/auth.test') {
        if (bearer !== botToken) return json(res, { ok: false, error: 'invalid_auth' });
        return json(res, { ok: true, url: 'https://maka.slack.com/', team: 'Maka', user: botName, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' });
      }
      if (url.pathname === '/api/apps.connections.open') {
        if (bearer !== appToken) return json(res, { ok: false, error: 'invalid_auth' });
        state.opens += 1;
        return json(res, { ok: true, url: `${server.wsUrl}?ticket=t${state.opens}` });
      }
      if (url.pathname === '/api/chat.postMessage') {
        if (bearer !== botToken) return json(res, { ok: false, error: 'invalid_auth' });
        if (body.channel === 'C404') return json(res, { ok: false, error: 'channel_not_found' });
        if (typeof body.text === 'string' && body.text.length > 40000) return json(res, { ok: false, error: 'msg_too_long' });
        const ts = (state.nextTs += 0.0001).toFixed(4);
        state.sent.push({ chatId: body.channel, text: body.text, blocks: body.blocks || null, mrkdwn: body.mrkdwn, ts });
        return json(res, { ok: true, channel: body.channel, ts, message: { text: body.text, ts } });
      }
      json(res, { ok: false, error: 'unknown_method' });
    },
    onSocket(conn) {
      state.sockets.add(conn);
      conn.send({ type: 'hello', num_connections: state.sockets.size, connection_info: { app_id: 'A1' } });
      conn.onMessage((msg) => { if (msg.envelope_id) state.acks.push(msg.envelope_id); });
      conn.onClose(() => state.sockets.delete(conn));
    },
  });
  let n = 0;
  const envelope = (type, payload) => {
    const env = { envelope_id: `env-${++n}`, type, payload, accepts_response_payload: false };
    for (const c of state.sockets) c.send(env);
    return env.envelope_id;
  };
  return {
    ...server,
    botToken,
    appToken,
    state,
    apiUrl: `${server.httpUrl}/api`,
    message({ chatId, userId = 'U1', text, ts, channelType = 'im' }) {
      return envelope('events_api', { type: 'event_callback', team_id: 'T1', event: { type: 'message', channel: String(chatId), channel_type: channelType, user: String(userId), text, ts: ts || (state.nextTs += 0.0001).toFixed(4), client_msg_id: `cm-${n + 1}` } });
    },
    botMessage({ chatId, text }) {
      return envelope('events_api', { type: 'event_callback', event: { type: 'message', channel: String(chatId), user: 'UBOT', bot_id: 'B1', text, ts: (state.nextTs += 0.0001).toFixed(4) } });
    },
    press({ chatId, userId = 'U1', data, messageTs = '1700000000.0001', channelName = 'directmessage' }) {
      return envelope('interactive', { type: 'block_actions', user: { id: String(userId), name: 'owner' }, channel: { id: String(chatId), name: channelName }, message: { ts: messageTs }, actions: [{ type: 'button', action_id: data, value: data, block_id: 'b1', action_ts: '1700000001.0001' }] });
    },
    disconnectAll(reason = 'refresh_requested') { for (const c of state.sockets) c.send({ type: 'disconnect', reason }); },
    sentTo: (chatId) => state.sent.filter((s) => s.chatId === String(chatId)),
  };
}
