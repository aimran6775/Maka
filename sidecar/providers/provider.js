// Provider interface and registry.
//
// A provider is { name, stream(request, { signal }) } where stream returns an async
// iterable of normalized chunks:
//
//   { type: 'text_delta',       index, text }
//   { type: 'tool_use_start',   index, id, name }
//   { type: 'tool_input_delta', index, partialJson }
//   { type: 'opaque_block',     index, block }      // provider-specific block (e.g. thinking)
//                                                   // kept verbatim in the transcript and
//                                                   // replayed to the same provider
//   { type: 'message_end',      stopReason, usage }
//
// usage: { inputTokens, outputTokens, costUsd? } or null. `costUsd` is set only when the
// provider itself reported a cost (OpenRouter does); the loop treats it as reconciled.
// stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'stop_sequence' | other.
//
// request: { model, system, messages, tools }
//   messages use the internal content-block format described in sidecar/loop.js
//   tools: [{ name, description, inputSchema }]
//
// Errors thrown from stream() carry `code` ('HTTP_<status>', 'NETWORK', 'BAD_STREAM') and
// become agent.run.error events in the loop. An AbortError ends the run as cancelled.

import { createAnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic.js';
import { createOpenRouterProvider, OPENROUTER_DEFAULT_MODEL } from './openrouter.js';
import { createOllamaProvider, ollamaHost, listModels, probe as probeOllama } from './ollama.js';
import { createHuggingFaceProvider, HUGGINGFACE_DEFAULT_MODEL } from './huggingface.js';
import { resolveKey } from './keys.js';
import { priceFor } from './pricing.js';

// `envVar: null` means the provider needs no key. `local: true` means zero marginal cost
// and that availability is a question of reachability, not credentials.
export const PROVIDERS = Object.freeze({
  anthropic: Object.freeze({ envVar: 'ANTHROPIC_API_KEY', defaultModel: ANTHROPIC_DEFAULT_MODEL, local: false, tierHint: 'judge' }),
  openrouter: Object.freeze({ envVar: 'OPENROUTER_API_KEY', defaultModel: OPENROUTER_DEFAULT_MODEL, local: false, tierHint: 'worker' }),
  ollama: Object.freeze({ envVar: null, defaultModel: null, local: true, tierHint: 'worker' }),
  // Phase 2 step 12b: hosted open-weight models, metered by calls (no price reported).
  huggingface: Object.freeze({ envVar: 'HF_TOKEN', defaultModel: HUGGINGFACE_DEFAULT_MODEL, local: false, tierHint: 'hosted_worker' }),
});

export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));
export const DEFAULT_PROVIDER = 'anthropic';

export function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || typeof p.stream !== 'function') {
    throw new TypeError('provider must be { name: string, stream: function }');
  }
  return p;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Builds a live provider for `name`. Keyed providers resolve their key from env or the
// keystore (throws NO_KEY). Ollama needs no key; its model is `model`, else OLLAMA_MODEL,
// else the first locally installed model (throws NO_MODEL when none, OLLAMA_UNREACHABLE
// when the server is down). Returns { provider, model, price }.
export async function createProvider(name, { model, env = process.env, keystorePath, fetch: fetchImpl } = {}) {
  const spec = PROVIDERS[name];
  if (!spec) throw fail('UNKNOWN_PROVIDER', `unknown provider "${name}"`);

  if (name === 'ollama') {
    const host = ollamaHost(env);
    let chosen = model || (env.OLLAMA_MODEL || '').trim();
    if (!chosen) {
      const models = await listModels({ fetch: fetchImpl, host }); // throws OLLAMA_UNREACHABLE
      if (!models.length) throw fail('NO_MODEL', `ollama at ${host} has no models installed; pull one from the Peak card (sized to this machine's memory) or run \`ollama pull <model>\``);
      chosen = models[0];
    }
    return { provider: createOllamaProvider({ fetch: fetchImpl, host }), model: chosen, price: null };
  }

  const apiKey = await resolveKey(name, { env, keystorePath });
  if (!apiKey) throw fail('NO_KEY', `no API key for ${name}: set ${spec.envVar} or add it to the keystore`);
  const chosenModel = model || spec.defaultModel;
  const provider = name === 'anthropic' ? createAnthropicProvider({ apiKey, fetch: fetchImpl }) : name === 'huggingface' ? createHuggingFaceProvider({ apiKey, fetch: fetchImpl }) : createOpenRouterProvider({ apiKey, fetch: fetchImpl });
  return { provider, model: chosenModel, price: priceFor(name, chosenModel) };
}

// Reports which providers are usable without revealing any key. Keyed providers report
// `configured`; ollama reports `reachable`, its host and the installed models.
export async function providerStatus({ env = process.env, keystorePath, fetch: fetchImpl, probeLocal = true } = {}) {
  const out = {};
  for (const name of PROVIDER_NAMES) {
    const spec = PROVIDERS[name];
    if (name === 'ollama') {
      const host = ollamaHost(env);
      const p = probeLocal ? await probeOllama({ fetch: fetchImpl, host }) : { reachable: false, models: [], problem: 'not probed' };
      out[name] = {
        configured: p.reachable,
        local: true,
        envVar: null,
        host,
        reachable: p.reachable,
        models: p.models,
        problem: p.problem || null,
        defaultModel: (env.OLLAMA_MODEL || '').trim() || p.models[0] || null,
        tierHint: spec.tierHint,
      };
      continue;
    }
    const key = await resolveKey(name, { env, keystorePath });
    out[name] = { configured: Boolean(key), local: false, envVar: spec.envVar, defaultModel: spec.defaultModel, tierHint: spec.tierHint };
  }
  return out;
}
