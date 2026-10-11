// Telegram (phase 4 step 2): the Bot API over long polling with core `fetch`.
//
//   createTelegramAdapter({ fetch, netGuard, baseUrl, clock, pollTimeoutS, log })
//     -> an adapter for sidecar/channels/registry.js (keys: telegramBot)
//
// start() verifies the token with getMe, then polls getUpdates (messages and button
// presses only) with the offset after the last update, so a restart does not replay what
// was already handled; the registry drops a replayed update id on top of that. A press on
// an inline button is answered (answerCallbackQuery) before it is handed in, so the
// phone's spinner stops whatever the registry decides. Cards are sendMessage with an
// inline keyboard; text is plain (no parse mode, so a Ranger's words cannot break a
// message). Every inbound carries `chatType` from Telegram's chat.type, so the registry
// pairs private chats only (safety 2026-10-11 H1). Every request goes through the
// outbound guard (safety H1): the Bot API host
// must be public, and the sidecar never sets `allowLocal`. The token is part of the Bot
// API's URL; it is never put in an error, an event or a log line.

import { guardedFetch, defaultNetGuard } from '../netguard.js';
import { cardText } from './adapter.js';

export const TELEGRAM_API = 'https://api.telegram.org';
export const POLL_TIMEOUT_S = 25;
export const MAX_MESSAGE = 4096;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createTelegramAdapter({ fetch: fetchImpl = globalThis.fetch, netGuard = defaultNetGuard(), baseUrl = TELEGRAM_API, clock = { now: () => Date.now() }, pollTimeoutS = POLL_TIMEOUT_S, sleep = (ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); }), log = console } = {}) {
  let token = null;
  let onInbound = null;
  let controller = null;
  let polling = null;
  let offset = 0;
  const base = String(baseUrl).replace(/\/+$/, '');

  async function call(method, params = {}, { signal } = {}) {
    if (!token) throw fail('NOT_STARTED', 'telegram adapter is not started');
    let res;
    try {
      res = await guardedFetch(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal }, { fetch: fetchImpl, guard: netGuard });
    } catch (err) {
      if (err && err.name === 'AbortError') throw fail('ABORTED', 'telegram request aborted');
      if (err && err.code === 'NET_GUARD') throw fail('NET_GUARD', err.message);
      throw fail('NETWORK', `telegram ${method}: ${err && err.code ? err.code : err && err.cause && err.cause.code ? err.cause.code : err && err.message ? err.message.replace(token, '…') : 'network error'}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || data.ok !== true) {
      const description = data && data.description ? String(data.description).replace(token, '…') : `HTTP ${res.status}`;
      throw fail(res.status === 401 ? 'UNAUTHORIZED' : `HTTP_${res.status}`, `telegram ${method}: ${description}`);
    }
    return data.result;
  }

  // Telegram's chat.type: 'private' is the one-to-one chat with the bot; group,
  // supergroup and channel are not, and only a private chat may pair (safety 2026-10-11 H1).
  // A chat without a type is reported as unknown, which cannot pair either.
  const chatTypeOf = (chat) => (chat && chat.type === 'private' ? 'private' : chat && typeof chat.type === 'string' && chat.type ? chat.type : 'unknown');

  function inboundOf(update) {
    const updateId = String(update.update_id);
    if (update.message && update.message.chat && update.message.from) {
      const m = update.message;
      return { updateId, chatId: String(m.chat.id), userId: String(m.from.id), chatType: chatTypeOf(m.chat), text: typeof m.text === 'string' ? m.text : '', messageId: String(m.message_id) };
    }
    if (update.callback_query && update.callback_query.from) {
      const cb = update.callback_query;
      const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : null;
      if (!chatId) return null;
      return { updateId, chatId, userId: String(cb.from.id), chatType: chatTypeOf(cb.message.chat), callback: { id: cb.id, data: String(cb.data || ''), messageId: cb.message ? String(cb.message.message_id) : '' } };
    }
    return null;
  }

  async function poll() {
    let failures = 0;
    while (controller && !controller.signal.aborted) {
      let updates;
      try {
        updates = await call('getUpdates', { offset, timeout: pollTimeoutS, allowed_updates: ['message', 'callback_query'] }, { signal: controller.signal });
        failures = 0;
      } catch (err) {
        if (!controller || controller.signal.aborted || err.code === 'ABORTED') return;
        failures += 1;
        log.warn && log.warn(`telegram polling failed (${err.code}): ${err.message}; retrying in ${BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] / 1000}s`);
        await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1], controller.signal);
        continue;
      }
      for (const u of updates || []) {
        if (typeof u.update_id === 'number') offset = Math.max(offset, u.update_id + 1);
        const msg = inboundOf(u);
        if (!msg) continue;
        if (msg.callback) call('answerCallbackQuery', { callback_query_id: msg.callback.id }).catch((err) => log.warn && log.warn(`telegram answerCallbackQuery: ${err.message}`));
        if (onInbound) {
          try {
            await onInbound(msg);
          } catch (err) {
            log.error && log.error('telegram inbound failed:', err);
          }
        }
      }
    }
  }

  async function sendMessage(chatId, text, extra = {}) {
    const result = await call('sendMessage', { chat_id: String(chatId), text: text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text, disable_web_page_preview: true, ...extra });
    return { messageId: String(result && result.message_id !== undefined ? result.message_id : '') };
  }

  return {
    name: 'telegram',
    label: 'Telegram',
    keys: ['telegramBot'],
    buttons: true,
    offset: () => offset,
    async start({ keys, onInbound: handler }) {
      token = keys.telegramBot;
      onInbound = handler;
      const me = await call('getMe');
      controller = new AbortController();
      polling = poll().catch((err) => log.error && log.error('telegram polling stopped:', err));
      return { detail: `long polling as @${me.username || me.id}` };
    },
    async stop() {
      if (controller) controller.abort();
      controller = null;
      if (polling) await polling;
      polling = null;
      token = null;
      onInbound = null;
    },
    async sendCard(chatId, card) {
      const keyboard = (card.buttons || []).map((b) => ({ text: b.label, callback_data: b.data }));
      return sendMessage(chatId, [card.title, ...(card.lines || [])].join('\n'), keyboard.length ? { reply_markup: { inline_keyboard: [keyboard] } } : {});
    },
    async sendText(chatId, text) {
      return sendMessage(chatId, text);
    },
    textOf: cardText,
  };
}
