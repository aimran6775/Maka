// Anthropic Messages API adapter (raw fetch, streaming, tool use).
//
// Maka ships no runtime dependencies, so this talks HTTP directly instead of using the
// official SDK. The request shape is the documented /v1/messages streaming request; the
// internal message format is already Anthropic-style content blocks, so messages pass
// through unchanged. `thinking` blocks the model returns are kept verbatim (opaque_block)
// and replayed on the next turn as the API requires.

import { parseSSE, errorFromResponse } from './sse.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 16000;

export function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

export function toAnthropicMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === 'tool_result') {
        const out = { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content ?? '' };
        if (b.is_error) out.is_error = true;
        return out;
      }
      return b;
    }),
  }));
}

export function createAnthropicProvider({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  if (!apiKey) throw new Error('anthropic provider needs an apiKey');
  if (typeof fetchImpl !== 'function') throw new Error('anthropic provider needs fetch');

  return {
    name: 'anthropic',
    async *stream(request, { signal } = {}) {
      const body = {
        model: request.model,
        max_tokens: request.maxTokens || maxTokens,
        stream: true,
        messages: toAnthropicMessages(request.messages),
      };
      if (request.system) body.system = request.system;
      const tools = toAnthropicTools(request.tools);
      if (tools.length) body.tools = tools;

      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        const e = new Error(`anthropic network error: ${err && err.message ? err.message : err}`);
        e.code = 'NETWORK';
        throw e;
      }
      if (!res.ok) throw await errorFromResponse(res, 'anthropic');

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = null;
      const opaque = new Map(); // index -> block under construction (thinking etc.)

      for await (const { data } of parseSSE(res.body)) {
        if (!data) continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          const e = new Error('anthropic sent a non-JSON stream event');
          e.code = 'BAD_STREAM';
          throw e;
        }
        switch (ev.type) {
          case 'message_start': {
            const u = ev.message && ev.message.usage;
            if (u) {
              inputTokens = (u.input_tokens | 0) + (u.cache_creation_input_tokens | 0) + (u.cache_read_input_tokens | 0);
              outputTokens = u.output_tokens | 0;
            }
            break;
          }
          case 'content_block_start': {
            const b = ev.content_block || {};
            if (b.type === 'text') {
              if (b.text) yield { type: 'text_delta', index: ev.index, text: b.text };
            } else if (b.type === 'tool_use') {
              yield { type: 'tool_use_start', index: ev.index, id: b.id, name: b.name };
            } else {
              opaque.set(ev.index, { ...b });
            }
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta || {};
            if (d.type === 'text_delta') {
              yield { type: 'text_delta', index: ev.index, text: d.text || '' };
            } else if (d.type === 'input_json_delta') {
              yield { type: 'tool_input_delta', index: ev.index, partialJson: d.partial_json || '' };
            } else if (opaque.has(ev.index)) {
              const b = opaque.get(ev.index);
              if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
              else if (d.type === 'signature_delta') b.signature = (b.signature || '') + (d.signature || '');
            }
            break;
          }
          case 'content_block_stop': {
            if (opaque.has(ev.index)) {
              yield { type: 'opaque_block', index: ev.index, block: opaque.get(ev.index) };
              opaque.delete(ev.index);
            }
            break;
          }
          case 'message_delta': {
            if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage && typeof ev.usage.output_tokens === 'number') outputTokens = ev.usage.output_tokens;
            break;
          }
          case 'error': {
            const e = new Error(`anthropic stream error: ${(ev.error && ev.error.message) || 'unknown'}`);
            e.code = 'STREAM_ERROR';
            throw e;
          }
          default:
            break; // ping, message_stop, unknown future events
        }
      }
      yield { type: 'message_end', stopReason, usage: { inputTokens, outputTokens } };
    },
  };
}
