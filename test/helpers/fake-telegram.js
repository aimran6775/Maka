// A fake Telegram Bot API on an ephemeral port: getMe, getUpdates (long polling that
// answers as soon as an update is queued, or empty at the timeout), sendMessage (records
// text and inline keyboards, hands out message ids), answerCallbackQuery; a wrong token is
// 401 in the Bot API's shape; `fail` makes every call answer an error. Test-only.
import http from 'node:http';

export async function startFakeTelegram({ token = '123456:ABC-DEF', username = 'maka_test_bot', pollTimeoutMs = 50 } = {}) {
  const state = { calls: [], sent: [], answered: [], queue: [], nextUpdateId: 1, nextMessageId: 500, fail: null, waiters: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, given, method] = m;
    state.calls.push({ method, body, token: given === token });
    if (given !== token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    if (state.fail) return send(state.fail.status || 500, { ok: false, error_code: state.fail.status || 500, description: state.fail.description || 'Internal Server Error' });
    if (method === 'getMe') return send(200, { ok: true, result: { id: 123456, is_bot: true, first_name: 'Maka', username } });
    if (method === 'getUpdates') {
      const offset = Number(body.offset || 0);
      const due = () => state.queue.filter((u) => u.update_id >= offset);
      const reply = () => send(200, { ok: true, result: due().slice(0, Number(body.limit) || 100) });
      if (due().length) return reply();
      const timer = setTimeout(() => { state.waiters = state.waiters.filter((w) => w !== waiter); reply(); }, Math.min(pollTimeoutMs, (Number(body.timeout) || 0) * 1000 || pollTimeoutMs));
      const waiter = () => { clearTimeout(timer); reply(); };
      state.waiters.push(waiter);
      req.on('close', () => { clearTimeout(timer); state.waiters = state.waiters.filter((w) => w !== waiter); });
      return;
    }
    if (method === 'sendMessage') {
      if (typeof body.chat_id === 'undefined' || typeof body.text !== 'string') return send(400, { ok: false, error_code: 400, description: 'Bad Request: chat_id and text are required' });
      if (String(body.chat_id) === '404') return send(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      if (body.text.length > 4096) return send(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' });
      const message_id = state.nextMessageId++;
      state.sent.push({ chatId: String(body.chat_id), text: body.text, replyMarkup: body.reply_markup || null, parseMode: body.parse_mode || null, messageId: String(message_id) });
      return send(200, { ok: true, result: { message_id, chat: { id: body.chat_id }, text: body.text } });
    }
    if (method === 'answerCallbackQuery') {
      state.answered.push(body.callback_query_id);
      return send(200, { ok: true, result: true });
    }
    send(404, { ok: false, error_code: 404, description: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const push = (update) => {
    const u = { update_id: update.update_id ?? state.nextUpdateId++, ...update };
    state.nextUpdateId = Math.max(state.nextUpdateId, u.update_id + 1);
    state.queue.push(u);
    for (const w of state.waiters.splice(0)) w();
    return u.update_id;
  };
  let msgId = 1;
  return {
    url,
    token,
    username,
    state,
    push,
    // A text message from a chat.
    message({ chatId, userId = chatId, text, updateId, chatType = 'private' }) {
      return push({ ...(updateId !== undefined ? { update_id: updateId } : {}), message: { message_id: msgId++, from: { id: Number(userId), is_bot: false, first_name: 'Owner' }, chat: { id: Number(chatId), type: chatType }, date: 1700000000, text } });
    },
    // A button press on one of the bot's messages.
    press({ chatId, userId = chatId, data, messageId = '500', updateId, chatType = 'private' }) {
      return push({ ...(updateId !== undefined ? { update_id: updateId } : {}), callback_query: { id: `cb-${msgId++}`, from: { id: Number(userId), is_bot: false, first_name: 'Owner' }, message: { message_id: Number(messageId), chat: { id: Number(chatId), type: chatType } }, data } });
    },
    sentTo: (chatId) => state.sent.filter((s) => s.chatId === String(chatId)),
    async close() {
      for (const w of state.waiters.splice(0)) w();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
