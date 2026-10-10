// Inbound mail classification (phase 2 step 12): customer / supplier / platform notice /
// spam, by the worker model first, the judge when the worker is unsure or unreadable.
//
//   createClassifier({ router, makeProvider, ledger, bus, env, keystorePath, fetch, clock })
//     -> { classify(message) -> { classification, by, confidence, reason } }
//
// Every model answer is one JSON object; a confidence under `threshold` (0.6) or a
// non-answer sends the message to the judge ('ambiguity' step). When no model is reachable
// (Ollama down, no key) the message stays 'unclassified' and the event says `by: 'none'`:
// nothing is guessed. Costs: the worker turn is a reconciled $0 on Ollama; a judge call
// emits cost.estimate { tier: 'judge' } on runId `classify-<messageId>` and counts in the
// ledger's judge totals; the judge daily cap skips the judge.

import { makeEvent } from '../../shared/events.js';
import { costOf } from '../loop.js';
import { createProvider as defaultMakeProvider } from '../providers/provider.js';

export const CLASSES = Object.freeze(['customer', 'supplier', 'platform_notice', 'spam']);
export const CLASSIFY_SYSTEM_PROMPT = [
  'You classify one email received by an online business. Answer with exactly one JSON object and nothing else:',
  '{"classification": "customer" | "supplier" | "platform_notice" | "spam", "confidence": <0..1>, "reason": "<one sentence>"}',
  'customer: a buyer or prospect writing about products, orders, returns, questions. supplier: a vendor, manufacturer, freelancer or shipping partner. platform_notice: automated mail from a platform or service (Etsy, Shopify, Stripe, a bank, DNS, hosting). spam: unsolicited bulk, scams, phishing.',
  'Be honest about confidence: 0.9+ only when the text makes it obvious.',
].join('\n');

export function parseClassification(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (!obj || !CLASSES.includes(obj.classification)) return null;
      const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0;
      return { classification: obj.classification, confidence, reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '' };
    } catch {
      /* extend */
    }
  }
  return null;
}

function promptFor(m) {
  return [`From: ${m.from}`, `To: ${(m.to || []).join(', ')}`, `Subject: ${m.subject}`, `Attachments: ${(m.attachments || []).length}`, '', (m.text || '').slice(0, 4000) || '(no text)', '', 'Answer with the JSON object only.'].join('\n');
}

export function createClassifier({ router, makeProvider = defaultMakeProvider, ledger = null, bus, env = process.env, keystorePath, fetch: fetchImpl, clock = { now: () => Date.now() }, threshold = 0.6, log = console } = {}) {
  if (!router || !bus) throw new TypeError('createClassifier needs router and bus');
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const caps = router.caps();
  const cache = {};

  async function provider(kind) {
    if (cache[kind]) return cache[kind];
    const route = router.route({ kind });
    cache[kind] = { route, ...(await makeProvider(route.provider, { model: route.model || undefined, env, keystorePath, fetch: fetchImpl })) };
    return cache[kind];
  }

  async function ask(kind, message) {
    const p = await provider(kind);
    let text = '';
    let usage = null;
    const stream = p.provider.stream({ model: p.model, system: CLASSIFY_SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: promptFor(message) }] }], tools: [] }, {});
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') text += chunk.text;
      else if (chunk.type === 'message_end') usage = chunk.usage || null;
    }
    const turnUsage = usage ? { inputTokens: usage.inputTokens | 0, outputTokens: usage.outputTokens | 0 } : null;
    const usd = p.route.provider === 'ollama' ? 0 : usage && typeof usage.costUsd === 'number' ? usage.costUsd : costOf(turnUsage, p.price);
    emit('cost.estimate', { runId: `classify-${message.id}`, turn: 1, provider: p.provider.name, model: p.model, inputTokens: turnUsage ? turnUsage.inputTokens : 0, outputTokens: turnUsage ? turnUsage.outputTokens : 0, usd, reconciled: usd !== null, tier: p.route.tier });
    if (p.route.tier === 'judge' && ledger) await ledger.recordJudge({ usd: usd || 0 }).catch(() => {});
    return { parsed: parseClassification(text), tier: p.route.tier, raw: text };
  }

  return {
    async classify(message) {
      let result = { classification: 'unclassified', by: 'none', confidence: 0, reason: '' };
      let workerFailed = null;
      try {
        const w = await ask('turn', message);
        if (w.parsed && w.parsed.confidence >= threshold) result = { classification: w.parsed.classification, by: w.tier, confidence: w.parsed.confidence, reason: w.parsed.reason };
        else workerFailed = w.parsed ? `worker unsure (${w.parsed.confidence.toFixed(2)})` : 'worker answer unreadable';
      } catch (err) {
        workerFailed = `worker unavailable: ${err.message}`;
      }
      if (result.by === 'none') {
        const today = ledger ? ledger.judgeToday() : { usd: 0, calls: 0 };
        if (ledger && (today.usd >= caps.judgeUsdPerDay || today.calls >= caps.judgeCallsPerDay)) {
          result.reason = `${workerFailed}; judge at its daily cap`;
        } else {
          try {
            const j = await ask('ambiguity', message);
            if (j.parsed) result = { classification: j.parsed.classification, by: j.tier, confidence: j.parsed.confidence, reason: `${workerFailed}; ${j.parsed.reason}`.slice(0, 300) };
            else result.reason = `${workerFailed}; judge answer unreadable`;
          } catch (err) {
            result.reason = `${workerFailed}; judge unavailable: ${err.message}`;
          }
        }
      }
      emit('mail.classified', { messageId: message.id, classification: result.classification, by: result.by, confidence: result.confidence, reason: result.reason });
      return result;
    },
  };
}
