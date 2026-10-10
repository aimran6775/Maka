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
import { resolveKey } from './keys.js';
import { priceFor } from './pricing.js';

export const PROVIDERS = Object.freeze({
  anthropic: Object.freeze({ envVar: 'ANTHROPIC_API_KEY', defaultModel: ANTHROPIC_DEFAULT_MODEL, create: createAnthropicProvider }),
  openrouter: Object.freeze({ envVar: 'OPENROUTER_API_KEY', defaultModel: OPENROUTER_DEFAULT_MODEL, create: createOpenRouterProvider }),
});

export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));
export const DEFAULT_PROVIDER = 'anthropic';

export function assertProvider(p) {
  if (!p || typeof p.name !== 'string' || typeof p.stream !== 'function') {
    throw new TypeError('provider must be { name: string, stream: function }');
  }
  return p;
}

// Builds a live provider for `name`, resolving its key from env or the keystore.
// Returns { provider, model, price } or throws { code: 'NO_KEY' } when no key is configured.
export async function createProvider(name, { model, env = process.env, keystorePath, fetch: fetchImpl } = {}) {
  const spec = PROVIDERS[name];
  if (!spec) {
    const err = new Error(`unknown provider "${name}"`);
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  const apiKey = await resolveKey(name, { env, keystorePath });
  if (!apiKey) {
    const err = new Error(`no API key for ${name}: set ${spec.envVar} or add it to the keystore`);
    err.code = 'NO_KEY';
    throw err;
  }
  const chosenModel = model || spec.defaultModel;
  const provider = spec.create({ apiKey, fetch: fetchImpl });
  return { provider, model: chosenModel, price: priceFor(name, chosenModel) };
}

// Reports which providers have a key configured, without revealing the keys.
export async function providerStatus({ env = process.env, keystorePath } = {}) {
  const out = {};
  for (const name of PROVIDER_NAMES) {
    const key = await resolveKey(name, { env, keystorePath });
    out[name] = { configured: Boolean(key), envVar: PROVIDERS[name].envVar, defaultModel: PROVIDERS[name].defaultModel };
  }
  return out;
}
