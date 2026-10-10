// OpenRouter adapter: OpenAI-compatible chat completions with streaming tool calls.
// OpenRouter reports the request cost in the final usage chunk (`usage.cost`); it is
// forwarded as usage.costUsd so spend is reconciled without a local price table.

import { createOpenAICompatProvider, toOpenAIMessages, toOpenAITools } from './openai-compat.js';

export { toOpenAIMessages, toOpenAITools };
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export function createOpenRouterProvider({ apiKey, fetch: fetchImpl, baseUrl = DEFAULT_BASE_URL, maxTokens, appTitle = 'Maka' } = {}) {
  if (!apiKey) throw new Error('openrouter provider needs an apiKey');
  return createOpenAICompatProvider({
    name: 'openrouter',
    baseUrl,
    headers: { authorization: `Bearer ${apiKey}`, 'x-title': appTitle },
    fetch: fetchImpl,
    maxTokens,
    usageOptions: { usage: { include: true } },
    cost: (usage) => (typeof usage.cost === 'number' ? usage.cost : undefined),
  });
}
