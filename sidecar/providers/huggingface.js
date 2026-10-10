// Hugging Face Inference Providers (phase 2 step 12b): hosted open-weight models behind an
// OpenAI-compatible chat-completions endpoint, authenticated with HF_TOKEN. Metered: the
// response reports token usage but no price, so cost events are unreconciled (usd null)
// and the ledger caps calls per day instead (router caps.hostedWorkerCallsPerDay).

import { createOpenAICompatProvider } from './openai-compat.js';

export const HUGGINGFACE_BASE_URL = 'https://router.huggingface.co/v1';
export const HUGGINGFACE_DEFAULT_MODEL = 'Qwen/Qwen2.5-72B-Instruct';

export function createHuggingFaceProvider({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = HUGGINGFACE_BASE_URL } = {}) {
  if (!apiKey) throw new Error('huggingface provider needs an apiKey');
  return createOpenAICompatProvider({
    name: 'huggingface',
    baseUrl,
    headers: { authorization: `Bearer ${apiKey}` },
    fetch: fetchImpl,
    cost: () => undefined, // no price is reported: unreconciled, call-capped by the ledger
  });
}
