import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, costOf } from '../sidecar/loop.js';
import { validateEvent } from '../shared/events.js';
import { fakeProvider, fakeClock, recorder, fakeTools, text, toolCall, end } from './helpers/fake-provider.js';

const PRICE = { inputPerMTok: 3, outputPerMTok: 15 };

function base(overrides = {}) {
  const rec = recorder();
  return {
    rec,
    opts: {
      runId: 'run-1',
      agentId: 'agent-1',
      model: 'fake-model',
      prompt: 'do the thing',
      tools: fakeTools(),
      emit: rec.emit,
      clock: fakeClock(),
      price: PRICE,
      ...overrides,
    },
  };
}

test('single turn, no tools: start, tokens, cost, end(completed)', async () => {
  const provider = fakeProvider([[text('Hel'), text('lo'), end()]]);
  const { rec, opts } = base({ provider });
  const out = await runLoop(opts);

  assert.deepEqual(rec.types(), ['agent.run.start', 'agent.token', 'agent.token', 'cost.estimate', 'agent.run.end']);
  for (const ev of rec.events) assert.equal(validateEvent(ev).ok, true, JSON.stringify(ev));
  assert.equal(out.reason, 'completed');
  assert.equal(out.finalText, 'Hello');
  assert.equal(out.turns, 1);
  const start = rec.ofType('agent.run.start')[0].payload;
  assert.equal(start.provider, 'fake');
  assert.deepEqual(start.tools, []);
  const cost = rec.ofType('cost.estimate')[0].payload;
  assert.equal(cost.reconciled, true);
  assert.equal(cost.usd, costOf({ inputTokens: 10, outputTokens: 5 }, PRICE));
  assert.equal(rec.ofType('agent.run.end')[0].payload.usage.inputTokens, 10);
  // Deterministic ids and timestamps from injected ids/clock.
  assert.equal(rec.events[0].id, 'run-1:1');
  assert.ok(rec.events[1].ts > rec.events[0].ts);
  // The first request carried the prompt as a user message.
  assert.deepEqual(provider.requests[0].messages, [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }]);
});

test('tool round-trip: every tool_call has exactly one tool_result, model sees the result', async () => {
  const provider = fakeProvider([
    [text('Let me read.'), ...toolCall('c1', 'fs.read', { path: 'a.txt' }), end('tool_use')],
    [text('The file says hi.'), end()],
  ]);
  const tools = fakeTools({ 'fs.read': async (input) => ({ ok: true, output: `contents of ${input.path}` }) });
  const { rec, opts } = base({ provider, tools });
  const out = await runLoop(opts);

  assert.equal(out.reason, 'completed');
  assert.equal(out.turns, 2);
  assert.equal(out.finalText, 'The file says hi.');
  const calls = rec.ofType('agent.tool_call');
  const results = rec.ofType('agent.tool_result');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(calls[0].payload.callId, results[0].payload.callId);
  assert.deepEqual(calls[0].payload.input, { path: 'a.txt' });
  assert.equal(results[0].payload.ok, true);
  assert.equal(results[0].payload.output, 'contents of a.txt');
  assert.deepEqual(rec.ofType('agent.run.start')[0].payload.tools, ['fs.read']);
  // Second request contains assistant tool_use then user tool_result.
  const second = provider.requests[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.deepEqual(second[1].content[1], { type: 'tool_use', id: 'c1', name: 'fs.read', input: { path: 'a.txt' } });
  assert.deepEqual(second[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'contents of a.txt', is_error: false }] });
  assert.equal(out.spentUsd, 2 * costOf({ inputTokens: 10, outputTokens: 5 }, PRICE));
});

test('tool calls accumulate by index across interleaved deltas; failures and bad JSON still get one result each', async () => {
  const provider = fakeProvider([
    [
      { type: 'tool_use_start', index: 0, id: 'a', name: 'alpha' },
      { type: 'tool_use_start', index: 1, id: 'b', name: 'beta' },
      { type: 'tool_use_start', index: 2, id: 'c', name: 'gamma' },
      { type: 'tool_input_delta', index: 1, partialJson: '{"x":' },
      { type: 'tool_input_delta', index: 0, partialJson: '{"p":1' },
      { type: 'tool_input_delta', index: 2, partialJson: '{not json' },
      { type: 'tool_input_delta', index: 1, partialJson: '2}' },
      { type: 'tool_input_delta', index: 0, partialJson: '}' },
      end('tool_use'),
    ],
    [text('ok'), end()],
  ]);
  const tools = fakeTools({
    alpha: async (input) => ({ ok: true, output: { got: input } }),
    beta: async () => { throw new Error('beta exploded'); },
    gamma: async () => ({ ok: true, output: 'never called' }),
  });
  const { rec, opts } = base({ provider, tools });
  const out = await runLoop(opts);

  assert.equal(out.reason, 'completed');
  const calls = rec.ofType('agent.tool_call').map((e) => e.payload);
  const results = rec.ofType('agent.tool_result').map((e) => e.payload);
  assert.deepEqual(calls.map((c) => c.callId), ['a', 'b', 'c']);
  assert.deepEqual(results.map((r) => r.callId), ['a', 'b', 'c']);
  assert.deepEqual(calls[0].input, { p: 1 });
  assert.deepEqual(calls[1].input, { x: 2 });
  assert.deepEqual(calls[2].input, {});
  assert.equal(results[0].ok, true);
  assert.equal(results[0].output, JSON.stringify({ got: { p: 1 } }));
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, 'beta exploded');
  assert.equal(results[2].ok, false);
  assert.match(results[2].error, /not valid JSON/);
  assert.equal(tools.calls.length, 2, 'gamma never executed with bad input');
  const toolResultMsg = provider.requests[1].messages[2];
  assert.equal(toolResultMsg.content.length, 3);
  assert.equal(toolResultMsg.content[1].is_error, true);
});

test('max_turns guard stops before another paid call', async () => {
  const provider = fakeProvider([
    [...toolCall('c1', 't', {}), end('tool_use')],
    [...toolCall('c2', 't', {}), end('tool_use')],
    [text('never'), end()],
  ]);
  const tools = fakeTools({ t: async () => ({ ok: true, output: 'x' }) });
  const { rec, opts } = base({ provider, tools, maxTurns: 2 });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'max_turns');
  assert.equal(out.turns, 2);
  assert.equal(provider.requests.length, 2);
  assert.equal(rec.ofType('agent.tool_call').length, 2);
  assert.equal(rec.ofType('agent.tool_result').length, 2);
  assert.equal(rec.ofType('agent.run.end')[0].payload.reason, 'max_turns');
});

test('budget guard: stops once reconciled spend reaches the budget; zero budget makes no call', async () => {
  const costPerTurn = costOf({ inputTokens: 10, outputTokens: 5 }, PRICE);
  const provider = fakeProvider([
    [...toolCall('c1', 't', {}), end('tool_use')],
    [...toolCall('c2', 't', {}), end('tool_use')],
    [text('never'), end()],
  ]);
  const tools = fakeTools({ t: async () => ({ ok: true, output: 'x' }) });
  const { rec, opts } = base({ provider, tools, budgetUsd: costPerTurn * 1.5 });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'budget');
  assert.equal(provider.requests.length, 2);
  assert.equal(rec.ofType('agent.run.end')[0].payload.reason, 'budget');

  const p2 = fakeProvider([[text('never'), end()]]);
  const r2 = base({ provider: p2, budgetUsd: 0 });
  const out2 = await runLoop(r2.opts);
  assert.equal(out2.reason, 'budget');
  assert.equal(out2.turns, 0);
  assert.equal(p2.requests.length, 0);
  assert.deepEqual(r2.rec.types(), ['agent.run.start', 'agent.run.end']);
});

test('unpriced model: cost events are unreconciled with usd null and do not count toward budget', async () => {
  const provider = fakeProvider([[text('hi'), end('end_turn', { inputTokens: 100, outputTokens: 50 })]]);
  const { rec, opts } = base({ provider, price: null });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'completed');
  const cost = rec.ofType('cost.estimate')[0].payload;
  assert.equal(cost.usd, null);
  assert.equal(cost.reconciled, false);
  assert.equal(cost.inputTokens, 100);
  assert.equal(out.spentUsd, 0);

  const p2 = fakeProvider([[text('hi'), { type: 'message_end', stopReason: 'end_turn', usage: null }]]);
  const r2 = base({ provider: p2 });
  await runLoop(r2.opts);
  const c2 = r2.rec.ofType('cost.estimate')[0].payload;
  assert.equal(c2.reconciled, false);
  assert.equal(c2.inputTokens, 0);
});

test('cancel before the first call ends with reason cancelled and no provider request', async () => {
  const ac = new AbortController();
  ac.abort();
  const provider = fakeProvider([[text('never'), end()]]);
  const { rec, opts } = base({ provider, signal: ac.signal });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'cancelled');
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(rec.types(), ['agent.run.start', 'agent.run.end']);
});

test('cancel mid-stream keeps partial text, ends cancelled, no run.error', async () => {
  const ac = new AbortController();
  const provider = fakeProvider([[text('part'), () => ac.abort(), text('never'), end()]]);
  const { rec, opts } = base({ provider, signal: ac.signal });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'cancelled');
  assert.equal(rec.ofType('agent.run.error').length, 0);
  assert.equal(rec.ofType('agent.token').length, 1);
  assert.equal(out.messages.at(-1).role, 'assistant');
  assert.equal(out.messages.at(-1).content[0].text, 'part');
  assert.equal(rec.ofType('agent.run.end')[0].payload.reason, 'cancelled');
});

test('cancel between tool calls: remaining calls are answered with an error result, then cancelled', async () => {
  const ac = new AbortController();
  const provider = fakeProvider([
    [...toolCall('c1', 't', {}, 0), ...toolCall('c2', 't', {}, 1), end('tool_use')],
  ]);
  const tools = fakeTools({ t: async () => { ac.abort(); return { ok: true, output: 'first' }; } });
  const { rec, opts } = base({ provider, tools, signal: ac.signal });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'cancelled');
  const results = rec.ofType('agent.tool_result').map((e) => e.payload);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /cancelled/);
  assert.equal(tools.calls.length, 1);
  assert.equal(provider.requests.length, 1);
});

test('provider failure emits agent.run.error and no agent.run.end', async () => {
  const provider = fakeProvider([() => { const e = new Error('503 overloaded'); e.code = 'HTTP_503'; throw e; }]);
  const { rec, opts } = base({ provider });
  const out = await runLoop(opts);
  assert.equal(out.reason, 'error');
  assert.equal(out.error.message, '503 overloaded');
  assert.deepEqual(rec.types(), ['agent.run.start', 'agent.run.error']);
  assert.equal(rec.ofType('agent.run.error')[0].payload.code, 'HTTP_503');
  assert.equal(rec.ofType('agent.run.error')[0].payload.turn, 1);
});

test('system prompt and prior messages pass through to the provider', async () => {
  const provider = fakeProvider([[text('ok'), end()]]);
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
    { role: 'user', content: [{ type: 'text', text: 'now' }] },
  ];
  const { opts } = base({ provider, system: 'be terse', messages: history });
  await runLoop(opts);
  assert.equal(provider.requests[0].system, 'be terse');
  assert.deepEqual(provider.requests[0].messages, history);
});

test('runLoop rejects missing required options', async () => {
  await assert.rejects(() => runLoop({ runId: 'r' }), TypeError);
});
