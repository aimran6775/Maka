// Shared adapter for OpenAI-compatible chat-completions endpoints (OpenRouter, Ollama).
//
// Translates the internal Anthropic-style content blocks to chat-completions messages and
// the streamed deltas back to normalized chunks. Tool calls arrive with their own `index`;
// text goes to block index 0 and tool call i goes to block index 1 + i so the loop's
// by-index accumulation works unchanged.
//
//   createOpenAICompatProvider({ name, baseUrl, headers, fetch, maxTokens, usageOptions, cost })
//     cost(usage) -> number | undefined : provider-reported or known-zero cost per request

import { parseSSE, errorFromResponse } from './sse.js';
import { toolNameMap } from './tool-names.js';

const DEFAULT_MAX_TOKENS = 16000;

// D169: OpenAI-shaped APIs refuse Maka's dotted tool names too, so the wire gets safe
// ones. `names` is this request's map; without one the names go as they are.
export function toOpenAITools(tools, names = null) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: names ? names.toApi(t.name) : t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));
}

export function toOpenAIMessages(system, messages, names = null) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: names ? names.toApi(b.name) : b.name, arguments: JSON.stringify(b.input || {}) } }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      const results = m.content.filter((b) => b.type === 'tool_result');
      for (const r of results) {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '') });
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text || results.length === 0) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

const STOP_MAP = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

export function createOpenAICompatProvider({ name, baseUrl, headers = {}, fetch: fetchImpl = globalThis.fetch, maxTokens = DEFAULT_MAX_TOKENS, usageOptions = {}, cost = () => undefined }) {
  if (!name || !baseUrl) throw new Error('openai-compat provider needs name and baseUrl');
  if (typeof fetchImpl !== 'function') throw new Error(`${name} provider needs fetch`);

  return {
    name,
    async *stream(request, { signal } = {}) {
      const names = toolNameMap(request.tools);
      const body = {
        model: request.model,
        max_tokens: request.maxTokens || maxTokens,
        stream: true,
        ...usageOptions,
        messages: toOpenAIMessages(request.system, request.messages, names),
      };
      const tools = toOpenAITools(request.tools, names);
      if (tools.length) body.tools = tools;

      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        const e = new Error(`${name} network error: ${err && err.message ? err.message : err}`);
        e.code = 'NETWORK';
        throw e;
      }
      if (!res.ok) throw await errorFromResponse(res, name);

      let stopReason = null;
      let usage = null;
      const started = new Set(); // tool call indexes already announced

      for await (const { data } of parseSSE(res.body)) {
        if (!data || data === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          const e = new Error(`${name} sent a non-JSON stream event`);
          e.code = 'BAD_STREAM';
          throw e;
        }
        if (ev.error) {
          const e = new Error(`${name} stream error: ${ev.error.message || JSON.stringify(ev.error)}`);
          e.code = 'STREAM_ERROR';
          throw e;
        }
        const choice = Array.isArray(ev.choices) ? ev.choices[0] : null;
        if (choice) {
          const delta = choice.delta || {};
          if (typeof delta.content === 'string' && delta.content) {
            yield { type: 'text_delta', index: 0, text: delta.content };
          }
          for (const tc of delta.tool_calls || []) {
            const i = typeof tc.index === 'number' ? tc.index : started.size;
            const index = 1 + i;
            if (!started.has(i)) {
              started.add(i);
              yield { type: 'tool_use_start', index, id: tc.id || `call_${i}`, name: names.fromApi((tc.function && tc.function.name) || '') };
            }
            const args = tc.function && tc.function.arguments;
            if (args) yield { type: 'tool_input_delta', index, partialJson: args };
          }
          if (choice.finish_reason) stopReason = STOP_MAP[choice.finish_reason] || choice.finish_reason;
        }
        if (ev.usage) {
          usage = { inputTokens: ev.usage.prompt_tokens | 0, outputTokens: ev.usage.completion_tokens | 0 };
          const c = cost(ev.usage);
          if (typeof c === 'number' && Number.isFinite(c) && c >= 0) usage.costUsd = c;
        }
      }
      yield { type: 'message_end', stopReason, usage };
    },
  };
}
