// The agentic loop. Pure given its injected edges: provider, tools, emit, clock, signal.
//
//   runLoop({ runId, agentId, provider, model, tier, system, prompt, messages, tools,
//             emit, clock, signal, maxTurns, budgetUsd, price, ids, review })
//     -> { reason, turns, finalText, usage, spentUsd, messages }
//
// `tier` ('worker' | 'judge') is recorded on every cost.estimate so a run shows which model
// did which turn. `review` is the pre-Gate hook point for the judge step (sidecar/judge.js):
//   review({ runId, turn, content, toolUses, final }) -> { verdict, notes, usd?, escalate?, reason? }
//   verdict: 'approve' | 'revise' | 'reject'
// With tool calls (final: false), revise/reject means the turn's tool calls are NOT
// executed; each gets an error tool_result carrying the notes, so the worker sees the
// verdict as a new turn. Without tool calls (final: true, the worker is about to finish),
// revise/reject becomes a new user turn carrying the notes, at most `maxReviewRetries`
// times, after which the run ends as completed. `usd` (the judge call's reconciled cost)
// counts against the run budget. `escalate` is handed to the tools as ctx.review so the
// gate can send the call to the Entrance Gate instead (judge at cap). No review = approve.
//
// Invariants (each one is tested in test/loop.test.js):
//   - every transition is an event validated against shared/events.js before emit();
//   - guards run before every paid provider call: cancelled, max turns, budget;
//   - streamed content blocks are accumulated by index;
//   - every agent.tool_call is paired with exactly one agent.tool_result, in order,
//     including when the tool throws, the input JSON is bad, or the run is cancelled
//     between tool calls;
//   - a provider failure emits agent.run.error and NO agent.run.end; every other exit
//     emits agent.run.end with its reason.
//
// Message format (internal, provider adapters translate): Anthropic-style content blocks.
//   { role: 'user'|'assistant', content: [ {type:'text', text}
//                                        | {type:'tool_use', id, name, input}
//                                        | {type:'tool_result', tool_use_id, content, is_error} ] }
//
// Provider contract: provider.stream(request, { signal }) returns an async iterable of
//   { type:'text_delta', index, text }
//   { type:'tool_use_start', index, id, name }
//   { type:'tool_input_delta', index, partialJson }
//   { type:'opaque_block', index, block }           (provider-specific, kept verbatim)
//   { type:'message_end', stopReason, usage: { inputTokens, outputTokens, costUsd? } | null }
// See sidecar/providers/provider.js for the full description.

import { makeEvent } from '../shared/events.js';

export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_BUDGET_USD = 1;
export const DEFAULT_MAX_REVIEW_RETRIES = 2;

function sequentialIds(prefix) {
  let n = 0;
  return { next: () => `${prefix}:${++n}` };
}

function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function toOutputString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'tool returned no result' };
  if (raw.ok === true) return { ok: true, output: toOutputString(raw.output) };
  return { ok: false, error: toOutputString(raw.error) || 'tool failed' };
}

export function costOf(usage, price) {
  if (!usage || !price) return null;
  const input = (usage.inputTokens / 1_000_000) * price.inputPerMTok;
  const output = (usage.outputTokens / 1_000_000) * price.outputPerMTok;
  return input + output;
}

function isAbort(err, signal) {
  return (signal && signal.aborted) || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

export async function runLoop(options) {
  const {
    runId,
    agentId,
    provider,
    model,
    system = '',
    prompt = '',
    tools,
    emit,
    clock = { now: () => Date.now() },
    signal,
    maxTurns = DEFAULT_MAX_TURNS,
    budgetUsd = DEFAULT_BUDGET_USD,
    price = null,
    ids = sequentialIds(runId),
    tier = null,
    review = null,
    maxReviewRetries = DEFAULT_MAX_REVIEW_RETRIES,
  } = options;

  if (!runId || !agentId || !provider || !model || !tools || typeof emit !== 'function') {
    throw new TypeError('runLoop needs runId, agentId, provider, model, tools and emit');
  }

  const messages = options.messages
    ? options.messages.map((m) => ({ ...m }))
    : [{ role: 'user', content: [{ type: 'text', text: prompt }] }];

  const send = (type, payload) => emit(makeEvent(type, payload, { id: ids.next(), ts: clock.now() }));

  const definitions = tools.definitions();
  const usageTotal = { inputTokens: 0, outputTokens: 0 };
  let spentUsd = 0;
  let turn = 0;
  let finalText = '';
  let reason = null;
  let reviewRetries = 0;

  const askReview = async (ctx) => {
    let verdict = null;
    try {
      verdict = (await review(ctx)) || null;
    } catch (err) {
      verdict = { verdict: 'reject', notes: `review failed: ${err && err.message ? err.message : err}` };
    }
    if (verdict && verdict.verdict !== 'approve' && verdict.verdict !== 'revise' && verdict.verdict !== 'reject') {
      verdict = { verdict: 'reject', notes: `review returned an unknown verdict "${verdict.verdict}"` };
    }
    if (verdict && typeof verdict.usd === 'number' && verdict.usd >= 0) spentUsd += verdict.usd;
    return verdict;
  };

  send('agent.run.start', {
    runId,
    agentId,
    provider: provider.name,
    model,
    prompt,
    maxTurns,
    budgetUsd,
    tools: definitions.map((d) => d.name),
  });

  const finish = (why) => {
    send('agent.run.end', { runId, reason: why, turns: turn, finalText, usage: { ...usageTotal } });
    return { reason: why, turns: turn, finalText, usage: { ...usageTotal }, spentUsd, messages };
  };

  while (true) {
    // Guards: nothing below this line costs money until all three pass.
    if (signal && signal.aborted) return finish('cancelled');
    if (turn >= maxTurns) return finish('max_turns');
    if (spentUsd >= budgetUsd) return finish('budget');

    turn += 1;
    const blocks = []; // accumulated by content-block index
    let stopReason = null;
    let usage = null;

    try {
      const stream = provider.stream({ model, system, messages, tools: definitions }, { signal });
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          const b = blocks[chunk.index] || (blocks[chunk.index] = { type: 'text', text: '' });
          b.text += chunk.text;
          if (chunk.text) send('agent.token', { runId, turn, text: chunk.text });
        } else if (chunk.type === 'tool_use_start') {
          blocks[chunk.index] = { type: 'tool_use', id: chunk.id, name: chunk.name, json: '' };
        } else if (chunk.type === 'tool_input_delta') {
          const b = blocks[chunk.index];
          if (b && b.type === 'tool_use') b.json += chunk.partialJson;
        } else if (chunk.type === 'opaque_block') {
          blocks[chunk.index] = { type: 'opaque', block: chunk.block };
        } else if (chunk.type === 'message_end') {
          stopReason = chunk.stopReason || null;
          usage = chunk.usage || null;
        }
      }
    } catch (err) {
      if (isAbort(err, signal)) {
        // Keep whatever streamed so a resumed transcript is honest about what happened.
        const partial = assemble(blocks);
        if (partial.content.length) messages.push({ role: 'assistant', content: partial.content });
        return finish('cancelled');
      }
      send('agent.run.error', {
        runId,
        turn,
        message: err && err.message ? err.message : String(err),
        code: (err && err.code) || 'PROVIDER_ERROR',
      });
      return { reason: 'error', error: err, turns: turn, finalText, usage: { ...usageTotal }, spentUsd, messages };
    }

    const { content, badInputs } = assemble(blocks);
    messages.push({ role: 'assistant', content });
    finalText = textOf(content) || finalText;

    // Cost for this turn. Reconciled only when the provider reported usage and a price is known.
    const turnUsage = usage ? { inputTokens: usage.inputTokens | 0, outputTokens: usage.outputTokens | 0 } : null;
    if (turnUsage) {
      usageTotal.inputTokens += turnUsage.inputTokens;
      usageTotal.outputTokens += turnUsage.outputTokens;
    }
    // A provider-reported cost (OpenRouter's usage.cost) beats the local price table.
    const usd = usage && typeof usage.costUsd === 'number' && usage.costUsd >= 0 ? usage.costUsd : costOf(turnUsage, price);
    const costPayload = {
      runId,
      turn,
      provider: provider.name,
      model,
      inputTokens: turnUsage ? turnUsage.inputTokens : 0,
      outputTokens: turnUsage ? turnUsage.outputTokens : 0,
      usd,
      reconciled: usd !== null,
    };
    if (tier) costPayload.tier = tier;
    send('cost.estimate', costPayload);
    if (usd !== null) spentUsd += usd;

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Final review (judge) before the run ends: revise/reject sends the notes back as a
      // new user turn, a bounded number of times.
      if (typeof review === 'function' && reviewRetries < maxReviewRetries && !(signal && signal.aborted)) {
        const verdict = await askReview({ runId, turn, content, toolUses, final: true });
        if (verdict && verdict.verdict !== 'approve') {
          reviewRetries += 1;
          const label = verdict.verdict === 'reject' ? 'rejected' : 'sent back for revision';
          messages.push({ role: 'user', content: [{ type: 'text', text: `[Judge review: your answer was ${label}${verdict.notes ? `: ${verdict.notes}` : ''}. Revise and answer again.]` }] });
          continue;
        }
      }
      reason = 'completed';
      break;
    }
    // Even when stopReason is not 'tool_use' (e.g. max_tokens cut the message), every
    // tool_use block gets an answer so the transcript stays well-formed.
    void stopReason;

    // Pre-Gate review hook (judge). Absent hook = approve.
    const verdict = typeof review === 'function' ? await askReview({ runId, turn, content, toolUses, final: false }) : null;
    const blocked = verdict && verdict.verdict !== 'approve' ? verdict : null;
    const reviewCtx = verdict ? { verdict: verdict.verdict, notes: verdict.notes || '', escalate: Boolean(verdict.escalate), reason: verdict.reason || '' } : null;

    const results = [];
    for (const call of toolUses) {
      send('agent.tool_call', { runId, turn, callId: call.id, name: call.name, input: call.input });
      let result;
      if (blocked) {
        result = { ok: false, error: `${blocked.verdict === 'reject' ? 'rejected' : 'sent back for revision'} by review${blocked.notes ? `: ${blocked.notes}` : ''}` };
      } else if (signal && signal.aborted) {
        result = { ok: false, error: 'cancelled before the tool ran' };
      } else if (badInputs.has(call.id)) {
        result = { ok: false, error: 'tool input was not valid JSON' };
      } else {
        try {
          result = normalizeResult(await tools.execute(call, { runId, agentId, turn, signal, turnText: textOf(content), review: reviewCtx }));
        } catch (err) {
          result = { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      const payload = { runId, turn, callId: call.id, name: call.name, ok: result.ok };
      if (result.ok) payload.output = result.output;
      else payload.error = result.error;
      send('agent.tool_result', payload);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.ok ? result.output : result.error,
        is_error: !result.ok,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return finish(reason);
}

// Turns index-accumulated blocks into ordered content; parses tool inputs.
function assemble(blocks) {
  const content = [];
  const badInputs = new Set();
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'opaque') {
      content.push(b.block); // provider-specific block (e.g. thinking); replayed verbatim
    } else if (b.type === 'text') {
      if (b.text) content.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      let input = {};
      const raw = b.json.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
          else badInputs.add(b.id);
        } catch {
          badInputs.add(b.id);
        }
      }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
  }
  return { content, badInputs };
}
