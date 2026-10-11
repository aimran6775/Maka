// A fake channel adapter for the registry tests: in-memory, records every send, lets a
// test inject inbound messages and button presses, and can refuse sends or fail to start.
// Test-only; the real adapters (Telegram, Discord, Slack) talk to fake platform servers.
import { assertAdapter } from '../../sidecar/channels/adapter.js';

export function fakeChannel({ name = 'fakechat', label = 'Fake Chat', keys = ['telegramBot'], buttons = true, startFails = null } = {}) {
  const state = { started: 0, stopped: 0, keys: null, sent: [], fail: null, inbound: null, nextMessageId: 100 };
  const adapter = {
    name,
    label,
    keys,
    buttons,
    state,
    async start({ keys: given, onInbound }) {
      if (startFails) {
        const e = new Error(startFails);
        e.code = 'START_FAILED';
        throw e;
      }
      state.started += 1;
      state.keys = given;
      state.inbound = onInbound;
      return { detail: `as @${name}_bot` };
    },
    async stop() {
      state.stopped += 1;
      state.inbound = null;
    },
    async sendCard(chatId, card) {
      if (state.fail) throw Object.assign(new Error(state.fail), { code: 'PLATFORM' });
      const messageId = String(state.nextMessageId++);
      state.sent.push({ chatId, kind: 'card', card, messageId });
      return { messageId };
    },
    async sendText(chatId, text) {
      if (state.fail) throw Object.assign(new Error(state.fail), { code: 'PLATFORM' });
      const messageId = String(state.nextMessageId++);
      state.sent.push({ chatId, kind: 'text', text, messageId });
      return { messageId };
    },
    // What the platform would deliver: a text message or a button press.
    receive(message) {
      if (!state.inbound) throw new Error(`${name} is not started`);
      return state.inbound(message);
    },
    sentTo: (chatId) => state.sent.filter((m) => m.chatId === String(chatId)),
  };
  return assertAdapter(adapter);
}
