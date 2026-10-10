// Known list prices in USD per million tokens, used to turn provider-reported usage into
// a reconciled cost. A model missing from this table yields `price: null`, and the loop
// emits cost.estimate { usd: null, reconciled: false } for it. Never guess a price here.
//
// Anthropic first-party API rates as of 2026-10-06. Cache read/write tokens are priced at
// the plain input rate (Maka sets no cache_control in phase 1, so none occur).

export const PRICES = Object.freeze({
  anthropic: Object.freeze({
    'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
    'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  }),
  // OpenRouter reports the cost of each request itself (usage.cost); the adapter passes it
  // through as usage.costUsd, so no table is needed here.
  openrouter: Object.freeze({}),
});

export function priceFor(provider, model) {
  const table = PRICES[provider];
  if (!table) return null;
  const p = table[model];
  return p ? { ...p } : null;
}
