// Ollama adapter: a local OpenAI-compatible endpoint (default http://127.0.0.1:11434/v1).
// No API key. Local inference has zero marginal cost, so every turn's cost is reported as
// a reconciled $0 (that is a fact about the bill, not an estimate).
//
// Which models exist is a property of the user's machine: `listModels()` asks the server
// (`GET /api/tags`) and `probe()` reports reachability. Nothing here guesses a model name.
// Honest caveat (docs/KICKOFF_BRIEF.md, Model strategy): a local model must support tool
// calling for the agent loop to do anything but talk.

import { createOpenAICompatProvider } from './openai-compat.js';

export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434';
export const OLLAMA_PROBE_TIMEOUT_MS = 1500;

export function ollamaHost(env = process.env) {
  const h = (env.OLLAMA_HOST || '').trim();
  if (!h) return OLLAMA_DEFAULT_HOST;
  return /^https?:\/\//.test(h) ? h.replace(/\/+$/, '') : `http://${h.replace(/\/+$/, '')}`;
}

export function createOllamaProvider({ fetch: fetchImpl, host = OLLAMA_DEFAULT_HOST, maxTokens } = {}) {
  return createOpenAICompatProvider({
    name: 'ollama',
    baseUrl: `${host}/v1`,
    fetch: fetchImpl,
    maxTokens,
    usageOptions: { stream_options: { include_usage: true } },
    cost: () => 0,
  });
}

// Lists locally available models, or throws with code OLLAMA_UNREACHABLE.
export async function listModels({ fetch: fetchImpl = globalThis.fetch, host = OLLAMA_DEFAULT_HOST, timeoutMs = OLLAMA_PROBE_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data.models) ? data.models : []).map((m) => m.name || m.model).filter(Boolean);
  } catch (err) {
    const e = new Error(`ollama not reachable at ${host}: ${err && err.message ? err.message : err}`);
    e.code = 'OLLAMA_UNREACHABLE';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function probe(opts = {}) {
  try {
    const models = await listModels(opts);
    return { reachable: true, models };
  } catch (err) {
    return { reachable: false, models: [], problem: err.message };
  }
}
