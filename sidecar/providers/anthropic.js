// Anthropic Messages API adapter (raw fetch, streaming, tool use).
//
// Maka ships no runtime dependencies, so this talks HTTP directly instead of using the
// official SDK. The request shape is the documented /v1/messages streaming request; the
// internal message format is already Anthropic-style content blocks, so messages pass
// through unchanged. `thinking` blocks the model returns are kept verbatim (opaque_block)
// and replayed on the next turn as the API requires.

import { parseSSE, errorFromResponse } from './sse.js';
import { toolNameMap } from './tool-names.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 16000;

// D169: the API refuses Maka's dotted names, so the wire gets safe ones. `names` is the
// map for this request; without one the names go as they are (the old behaviour, kept so
// the function stays usable on its own).
export function toAnthropicTools(tools, names = null) {
  return (tools || []).map((t) => ({
    name: names ? names.toApi(t.name) : t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

// D169: a past turn's tool_use block names the tool the model called, and the API checks
// that name against the same pattern and the same tool list — so the history has to carry
// the wire name the tool list carries, not Maka's dotted one.
export function toAnthropicMessages(messages, names = null) {
  const out = [];
  for (const m of messages) {
    const content = m.content
      .map((b) => {
        if (b.type === 'tool_result') {
          const o = { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content ?? '' };
          if (b.is_error) o.is_error = true;
          return o;
        }
        if (b.type === 'tool_use' && names) return { ...b, name: names.toApi(b.name) };
        return b;
      })
      // D175: the API refuses an empty text block, and a worker that answers with nothing
      // but whitespace leaves exactly that. Dropping it keeps the rest of the turn sendable.
      .filter((b) => !(b.type === 'text' && !String(b.text || '').trim()));
    // A turn with nothing left in it cannot be sent at all: the API refuses empty content.
    // It carried no information, so leaving it out loses nothing — but the turn on either
    // side of it may now share a role, and those have to be joined into one message.
    if (!content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

export function createAnthropicProvider({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  if (!apiKey) throw new Error('anthropic provider needs an apiKey');
  if (typeof fetchImpl !== 'function') throw new Error('anthropic provider needs fetch');

  return {
    name: 'anthropic',
    async *stream(request, { signal } = {}) {
      const names = toolNameMap(request.tools);
      const body = {
        model: request.model,
        max_tokens: request.maxTokens || maxTokens,
        stream: true,
        messages: toAnthropicMessages(request.messages, names),
      };
      if (request.system) body.system = request.system;
      const tools = toAnthropicTools(request.tools, names);
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
              yield { type: 'tool_use_start', index: ev.index, id: b.id, name: names.fromApi(b.name) };
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
