import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applySnapshot, applyEvent, grantedTools, currentRun, AGENT_STATES } from '../frontend/state.js';
import { makeEvent } from '../shared/events.js';
import { defaultLayout, OBJECT_KINDS } from '../shared/world.js';

let seq = 0;
const ev = (type, payload, opts = {}) => ({ ...makeEvent(type, payload, { ts: 1000 + seq }), seq: opts.seq ?? ++seq });
const snapshot = (over = {}) => ({
  seq: 0,
  providers: { ollama: { configured: false, local: true, reachable: false, models: [], host: 'http://127.0.0.1:11434', defaultModel: null } },
  keystore: { path: '/x', problem: null },
  layout: defaultLayout(),
  objectKinds: OBJECT_KINDS,
  activeRun: null,
  spend: { totalUsd: 0.5, reconciledTurns: 2, unreconciledTurns: 1 },
  ...over,
});

function reduce(state, events) {
  return events.reduce((s, e) => applyEvent(s, e), state);
}

test('snapshot seeds layout, providers, spend and idle Rangers', () => {
  const s = applySnapshot(initialState(), snapshot());
  assert.equal(s.agentStates.ranger, 'idle');
  assert.equal(s.spend.totalUsd, 0.5);
  assert.equal(s.providers.ollama.reachable, false);
  assert.deepEqual(grantedTools(s, 'ranger'), []);
  assert.equal(currentRun(s), null);
  assert.deepEqual([...AGENT_STATES], ['idle', 'thinking', 'tool-running', 'waiting', 'done', 'error']);
});

test('a full run drives the Ranger through thinking → tool-running → waiting → done and builds the transcript', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot());
  const runId = 'run-1';
  s = reduce(s, [
    ev('agent.run.start', { runId, agentId: 'ranger', provider: 'ollama', model: 'q', prompt: 'go', maxTurns: 4, budgetUsd: 1, tools: ['fs.write'] }),
  ]);
  assert.equal(s.agentStates.ranger, 'thinking');
  assert.equal(s.activeRun.runId, runId);
  s = reduce(s, [ev('agent.token', { runId, turn: 1, text: 'Wri' }), ev('agent.token', { runId, turn: 1, text: 'ting' })]);
  assert.deepEqual(s.runs[runId].items, [{ kind: 'text', turn: 1, text: 'Writing' }]);
  s = reduce(s, [ev('agent.tool_call', { runId, turn: 1, callId: 'c1', name: 'fs.write', input: { path: 'a', content: 'b' } })]);
  assert.equal(s.agentStates.ranger, 'tool-running');
  s = reduce(s, [ev('permission.prompt', { promptId: 'p1', runId, callId: 'c1', tool: 'fs.write', reason: 'r', input: { path: 'a' }, leash: { domain: 'publishing', level: 'draft' } })]);
  assert.equal(s.agentStates.ranger, 'waiting');
  assert.equal(s.pendingPrompts.length, 1);
  assert.equal(s.pendingPrompts[0].leash.level, 'draft');
  s = reduce(s, [ev('permission.response', { promptId: 'p1', runId, allow: true })]);
  assert.equal(s.agentStates.ranger, 'tool-running');
  assert.equal(s.pendingPrompts.length, 0);
  s = reduce(s, [ev('agent.tool_result', { runId, turn: 1, callId: 'c1', name: 'fs.write', ok: true, output: 'wrote' })]);
  assert.equal(s.agentStates.ranger, 'thinking');
  const tool = s.runs[runId].items.find((i) => i.kind === 'tool');
  assert.deepEqual(tool.result, { ok: true, output: 'wrote', error: undefined });
  s = reduce(s, [
    ev('cost.estimate', { runId, turn: 1, provider: 'ollama', model: 'q', inputTokens: 10, outputTokens: 5, usd: 0, reconciled: true, tier: 'worker' }),
    ev('agent.token', { runId, turn: 2, text: 'done' }),
    ev('cost.estimate', { runId, turn: 2, provider: 'ollama', model: 'q', inputTokens: 10, outputTokens: 5, usd: null, reconciled: false }),
    ev('agent.run.end', { runId, reason: 'completed', turns: 2, finalText: 'done', usage: { inputTokens: 20, outputTokens: 10 } }),
  ]);
  assert.equal(s.agentStates.ranger, 'done');
  assert.equal(s.activeRun, null);
  const run = s.runs[runId];
  assert.equal(run.status, 'ended');
  assert.equal(run.reason, 'completed');
  assert.equal(run.spentUsd, 0);
  assert.equal(run.unreconciledTurns, 1);
  assert.deepEqual(run.items.filter((i) => i.kind === 'cost').map((i) => [i.turn, i.tier, i.reconciled]), [[1, 'worker', true], [2, null, false]]);
  // Two text items because they are different turns.
  assert.equal(run.items.filter((i) => i.kind === 'text').length, 2);
  assert.equal(currentRun(s).runId, runId);
  // Global spend: snapshot 0.5 + reconciled 0 => 0.5 with 3 reconciled turns, 2 unreconciled.
  assert.deepEqual(s.spend, { totalUsd: 0.5, reconciledTurns: 3, unreconciledTurns: 2 });
});

test('errors and cancellation: run.error marks error state; prompts pending for that run are dropped', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot());
  s = reduce(s, [
    ev('agent.run.start', { runId: 'r', agentId: 'ranger', provider: 'p', model: 'm', prompt: 'x', maxTurns: 1, budgetUsd: 1, tools: [] }),
    ev('permission.prompt', { promptId: 'p', runId: 'r', callId: 'c', tool: 'fs.write', reason: '', input: {} }),
    ev('agent.run.error', { runId: 'r', turn: 1, message: 'boom', code: 'HTTP_500' }),
  ]);
  assert.equal(s.agentStates.ranger, 'error');
  assert.equal(s.pendingPrompts.length, 0);
  assert.equal(s.runs.r.error.code, 'HTTP_500');
  assert.equal(s.activeRun, null);
});

test('spend never double counts: events at or below the snapshot seq are not re-added', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ seq: 5 }));
  s = reduce(s, [
    ev('agent.run.start', { runId: 'r', agentId: 'ranger', provider: 'p', model: 'm', prompt: 'x', maxTurns: 1, budgetUsd: 1, tools: [] }, { seq: 4 }),
    ev('cost.estimate', { runId: 'r', turn: 1, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, usd: 0.25, reconciled: true }, { seq: 5 }),
    ev('cost.estimate', { runId: 'r', turn: 2, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, usd: 0.25, reconciled: true }, { seq: 6 }),
  ]);
  assert.equal(s.spend.totalUsd, 0.75);
  assert.equal(s.spend.reconciledTurns, 3);
  assert.equal(s.runs.r.spentUsd, 0.5, 'the run view still shows its own full spend');
  assert.equal(s.lastSeq, 6);
});

test('layout events update the park and the grants; invalid events are counted, never applied', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot());
  s = reduce(s, [ev('object.place', { objectId: 'o1', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 })]);
  assert.deepEqual(grantedTools(s, 'ranger'), ['fs.read', 'fs.write']);
  s = reduce(s, [ev('object.place', { objectId: 'o1', kind: 'supply_cache', roomId: 'ranger-station', x: 2, y: 2 })]);
  assert.equal(s.layout.objects.length, 1, 'replayed place is idempotent');
  s = reduce(s, [ev('object.reclaim', { objectId: 'o1', roomId: 'ranger-station' })]);
  assert.deepEqual(grantedTools(s, 'ranger'), []);
  const before = s;
  s = applyEvent(s, { v: 1, id: 'x', type: 'agent.token', ts: 1, payload: {} });
  assert.equal(s.invalidEvents, 1);
  assert.equal(s.agentStates.ranger, before.agentStates.ranger);
  s = applyEvent(s, { nonsense: true });
  assert.equal(s.invalidEvents, 2);
});

test('an active run in the snapshot shows the Ranger thinking until the replay says otherwise', () => {
  const s = applySnapshot(initialState(), snapshot({ activeRun: { runId: 'r', agentId: 'ranger', startedAt: 1 } }));
  assert.equal(s.agentStates.ranger, 'thinking');
  assert.equal(s.agentRuns.ranger, 'r');
});

test('layout.seed and work.handoff update the park inputs', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot());
  s = reduce(s, [ev('layout.seed', { seed: 99 })]);
  assert.equal(s.layout.seed, 99);
  s = reduce(s, [ev('work.handoff', { fromAgentId: 'chief', toAgentId: 'ranger', fromRoomId: 'ranger-station', toRoomId: 'camp', workItemId: 'w1', summary: 'go' })]);
  assert.equal(s.handoffs.ranger.toZone, 'camp');
  assert.equal(typeof s.handoffs.ranger.startedAt, 'number');
});

test('workspace offline/online events update the workspace view', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ workspace: { root: '/w', online: true, known: true, since: 1, reason: null } }));
  assert.equal(s.workspace.online, true);
  s = reduce(s, [ev('workspace.offline', { root: '/w', reason: 'ENOENT' })]);
  assert.equal(s.workspace.online, false);
  assert.equal(s.workspace.reason, 'ENOENT');
  s = reduce(s, [ev('workspace.online', { root: '/w' })]);
  assert.equal(s.workspace.online, true);
});
