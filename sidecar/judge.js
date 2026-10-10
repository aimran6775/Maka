// The judge step (phase 2 step 2): Claude reviews a worker's turn before it acts in a
// leash domain at "Act with cap" or "Act freely", and before a run ends.
//
//   createJudge({ router, makeProvider, ledger, bus, clock, env, keystorePath, fetch })
//     -> { forRun({ runId, agentId, gate, brief, persona }) -> review(ctx), status() }
//
// review(ctx) is the loop's hook (sidecar/loop.js, runLoop({ review })):
//   - ctx.final === false: only when at least one of the turn's tool calls is in a
//     non-research domain at act_capped / act_free does the judge run; otherwise approve
//     silently (draft-level calls get the Superintendent at the Gate, observe is refused).
//   - ctx.final === true: the worker's closing answer is reviewed.
// Every judge call emits cost.estimate { tier: 'judge' } and judge.verdict, counts in the
// ledger's judge totals, and its cost is returned so the loop adds it to the run's spend.
// When the judge cannot run (daily USD / call caps, no key, a failed call) it emits
// judge.verdict { verdict: 'skipped', reason } and, for actions, returns
// { verdict: 'approve', escalate: true } so the gate parks the call as Draft for review.
//
// The judge never rewrites the worker's output: it answers approve / revise / reject with
// notes, and the loop hands those back to the worker (docs/DECISIONS.md D20).

import { makeEvent } from '../shared/events.js';
import { costOf } from './loop.js';
import { createProvider as defaultMakeProvider } from './providers/provider.js';

export const JUDGE_SYSTEM_PROMPT = [
  'You are the Judge in Maka, a harness where AI Rangers run an online business for their Superintendent (the owner).',
  'You review one worker turn at a time and answer with exactly one JSON object and nothing else:',
  '{"verdict": "approve" | "revise" | "reject", "notes": "<one to three sentences>"}',
  'Approve only when the action (or final answer) is safe, within the brief, platform-compliant, original (no copied listings, images or brand names), and its inputs are correct and complete.',
  'Revise when a specific fix would make it acceptable; say exactly what to change.',
  'Reject when it should not happen at all (wrong target, money or messages the brief did not ask for, deception, policy risk).',
  'Never invent facts. If you cannot tell, revise and ask the worker for the missing evidence.',
].join('\n');

const INPUT_LIMIT = 4000;

function clip(text, n = INPUT_LIMIT) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}

// Extracts the first JSON object with a verdict from the judge's text.
export function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj.verdict === 'string') {
        const verdict = obj.verdict.trim().toLowerCase();
        if (!['approve', 'revise', 'reject'].includes(verdict)) return null;
        return { verdict, notes: typeof obj.notes === 'string' ? obj.notes.trim() : '' };
      }
      return null;
    } catch {
      /* keep extending */
    }
  }
  return null;
}

// Which of the turn's tool calls the judge must review: non-research calls the leash lets
// through alone (act_capped / act_free), plus calls at Draft for review whose tool asks
// for a review itself (`tool.judgeAtDraft(input)`, e.g. a mail to a new external address).
export function needsActionReview(gate, toolUses) {
  const needing = [];
  for (const tu of toolUses) {
    const l = gate && typeof gate.leashFor === 'function' ? gate.leashFor(tu.name, tu.input) : null;
    if (!l || l.domain === 'research') continue;
    if (l.level === 'act_capped' || l.level === 'act_free') {
      needing.push({ name: tu.name, domain: l.domain, level: l.level });
      continue;
    }
    const tool = gate && typeof gate.tool === 'function' ? gate.tool(tu.name) : null;
    if (l.level === 'draft' && tool && typeof tool.judgeAtDraft === 'function') {
      let wants = false;
      try {
        wants = Boolean(tool.judgeAtDraft(tu.input));
      } catch {
        wants = false;
      }
      if (wants) needing.push({ name: tu.name, domain: l.domain, level: l.level, reason: 'new external recipient' });
    }
  }
  return needing;
}

export function createJudge({ router, makeProvider = defaultMakeProvider, ledger = null, bus, clock = { now: () => Date.now() }, env = process.env, keystorePath, fetch: fetchImpl, log = console } = {}) {
  if (!router || !bus) throw new TypeError('createJudge needs router and bus');
  const caps = router.caps();
  const route = router.route({ kind: 'review' });
  let cached = null; // { provider, model, price } once resolved

  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  async function provider() {
    if (cached) return cached;
    cached = await makeProvider(route.provider, { model: route.model || undefined, env, keystorePath, fetch: fetchImpl });
    return cached;
  }

  function capReason(callsThisRun) {
    if (callsThisRun >= caps.judgeCallsPerRun) return `judge cap reached: ${caps.judgeCallsPerRun} call(s) per run`;
    if (ledger) {
      const today = ledger.judgeToday();
      if (today.calls >= caps.judgeCallsPerDay) return `judge cap reached: ${caps.judgeCallsPerDay} call(s) per day`;
      if (today.usd >= caps.judgeUsdPerDay) return `judge daily cap reached: $${today.usd.toFixed(2)} of $${caps.judgeUsdPerDay}`;
    }
    return null;
  }

  // One-off review of a document a tool produced (a venture brief, step 18): the same
  // model, caps, cost and judge.verdict event as a turn review; scope 'action' with the
  // tool named. Returns { verdict, notes, usd } or { verdict: 'skipped', reason }.
  async function reviewDocument({ runId = 'none', agentId = 'none', turn = 0, tool = 'document', title = 'document', text, brief = '' }) {
    const cap = capReason(0);
    const skip = (reason) => {
      emit('judge.verdict', { agentId, runId, turn, verdict: 'skipped', scope: 'action', reason, provider: route.provider, model: route.model || '', usd: null, reconciled: false, tools: [tool] });
      return { verdict: 'skipped', reason };
    };
    if (cap) return skip(cap);
    let p;
    try {
      p = await provider();
    } catch (err) {
      return skip(`judge not wired: ${err && err.message ? err.message : err}`);
    }
    const lines = [`Brief from the Superintendent to Ranger "${agentId}":`, clip(brief, 2000), '', `SCOPE: the worker submitted a ${title} through ${tool}. Review it: is every claim backed by the evidence given (sources with URLs), are the costs real figures with a basis, is the go / no-go consistent with the evidence? Approve, or revise with what is missing, or reject.`, '', clip(text, 12000), '', 'Answer with the JSON object only.'];
    let out = '';
    let usage = null;
    try {
      const stream = p.provider.stream({ model: p.model, system: JUDGE_SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }], tools: [] }, {});
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') out += chunk.text;
        else if (chunk.type === 'message_end') usage = chunk.usage || null;
      }
    } catch (err) {
      log.error('judge call failed:', err);
      return skip(`judge call failed: ${err && err.message ? err.message : err}`);
    }
    const turnUsage = usage ? { inputTokens: usage.inputTokens | 0, outputTokens: usage.outputTokens | 0 } : null;
    const usd = usage && typeof usage.costUsd === 'number' && usage.costUsd >= 0 ? usage.costUsd : costOf(turnUsage, p.price);
    emit('cost.estimate', { runId: runId || `judge-${tool}`, turn, provider: p.provider.name, model: p.model, inputTokens: turnUsage ? turnUsage.inputTokens : 0, outputTokens: turnUsage ? turnUsage.outputTokens : 0, usd, reconciled: usd !== null, tier: 'judge' });
    if (ledger) await ledger.recordJudge({ usd: usd || 0 }).catch((err) => log.error('judge ledger failed:', err));
    const parsed = parseVerdict(out) || { verdict: 'reject', notes: `the judge did not return a readable verdict (${clip(out, 200) || 'empty answer'})` };
    emit('judge.verdict', { agentId, runId, turn, verdict: parsed.verdict, scope: 'action', provider: p.provider.name, model: p.model, usd, reconciled: usd !== null, notes: parsed.notes, tools: [tool] });
    return { verdict: parsed.verdict, notes: parsed.notes, usd };
  }

  return {
    route,
    caps,
    reviewDocument,
    status() {
      const today = ledger ? ledger.judgeToday() : { usd: 0, calls: 0 };
      return { provider: route.provider, model: route.model, caps, today, wired: Boolean(cached) };
    },
    forRun({ runId, agentId, gate, brief = '', persona = '' }) {
      let calls = 0;
      const seen = []; // tool calls the judge reviewed in this run, for the final review
      const skipped = (ctx, reason, extra = {}) => {
        emit('judge.verdict', { agentId, runId, turn: ctx.turn, verdict: 'skipped', scope: ctx.final ? 'final' : 'action', reason, provider: route.provider, model: route.model || '', usd: null, reconciled: false, tools: ctx.toolUses.map((t) => t.name), ...extra });
        return ctx.final ? { verdict: 'approve', skipped: true, reason } : { verdict: 'approve', escalate: true, reason };
      };

      return async function review(ctx) {
        const needing = ctx.final ? [] : needsActionReview(gate, ctx.toolUses);
        if (!ctx.final && needing.length === 0) return null; // nothing for the judge here
        const cap = capReason(calls);
        if (cap) return skipped(ctx, cap);
        let p;
        try {
          p = await provider();
        } catch (err) {
          return skipped(ctx, `judge not wired: ${err && err.message ? err.message : err}`);
        }

        const turnText = ctx.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const lines = [`Brief from the Superintendent to Ranger "${agentId}":`, clip(brief, 2000), ''];
        if (persona) lines.push(`Ranger persona: ${clip(persona, 800)}`, '');
        if (ctx.final) {
          lines.push('SCOPE: the worker is about to finish. Review its final answer against the brief.', '');
          if (seen.length) lines.push('Tool calls made earlier in this run:', ...seen.map((s) => `- ${s}`), '');
          lines.push('Final answer:', clip(turnText || '(empty)', 6000));
        } else {
          lines.push('SCOPE: the worker wants to run these tool calls now. They are in leash domains that let it act without the Superintendent, so you are the check.', '');
          if (turnText) lines.push('What the worker said this turn:', clip(turnText, 2000), '');
          lines.push('Tool calls:');
          for (const tu of ctx.toolUses) {
            const need = needing.find((n) => n.name === tu.name);
            lines.push(`- ${tu.name}${need ? ` [domain ${need.domain}, leash ${need.level}${need.reason ? `, ${need.reason}` : ''}]` : ' [no judge review needed]'}: ${clip(tu.input)}`);
            seen.push(`${tu.name} ${clip(tu.input, 200)}`);
          }
        }
        lines.push('', 'Answer with the JSON object only.');

        calls += 1;
        let text = '';
        let usage = null;
        try {
          const stream = p.provider.stream({ model: p.model, system: JUDGE_SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }], tools: [] }, {});
          for await (const chunk of stream) {
            if (chunk.type === 'text_delta') text += chunk.text;
            else if (chunk.type === 'message_end') usage = chunk.usage || null;
          }
        } catch (err) {
          log.error('judge call failed:', err);
          return skipped(ctx, `judge call failed: ${err && err.message ? err.message : err}`);
        }
        const turnUsage = usage ? { inputTokens: usage.inputTokens | 0, outputTokens: usage.outputTokens | 0 } : null;
        const usd = usage && typeof usage.costUsd === 'number' && usage.costUsd >= 0 ? usage.costUsd : costOf(turnUsage, p.price);
        emit('cost.estimate', { runId, turn: ctx.turn, provider: p.provider.name, model: p.model, inputTokens: turnUsage ? turnUsage.inputTokens : 0, outputTokens: turnUsage ? turnUsage.outputTokens : 0, usd, reconciled: usd !== null, tier: 'judge' });
        if (ledger) await ledger.recordJudge({ usd: usd || 0 }).catch((err) => log.error('judge ledger failed:', err));
        const parsed = parseVerdict(text) || { verdict: 'reject', notes: `the judge did not return a readable verdict (${clip(text, 200) || 'empty answer'})` };
        emit('judge.verdict', { agentId, runId, turn: ctx.turn, verdict: parsed.verdict, scope: ctx.final ? 'final' : 'action', provider: p.provider.name, model: p.model, usd, reconciled: usd !== null, notes: parsed.notes, tools: ctx.toolUses.map((t) => t.name) });
        return { verdict: parsed.verdict, notes: parsed.notes, usd };
      };
    },
  };
}
