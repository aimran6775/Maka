import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applySnapshot, applyEvent, grantedTools, currentRun, AGENT_STATES, pendingGate, recentGate, judgeVerdicts, workInTransit, workFor } from '../frontend/state.js';
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

test('gate.item and agent.waiting: the Ranger waits at the Gate until the item is decided; items upsert by id; snapshot seeds the queue', () => {
  seq = 0;
  const pendingItem = { itemId: 'g0', agentId: 'ranger', kind: 'proposal', domain: 'publishing', tool: 'leash.loosen', summary: 'loosen?', status: 'pending', createdAt: 5 };
  const oldItem = { itemId: 'g-old', agentId: 'ranger', kind: 'action', domain: 'research', tool: 'fs.read', summary: 'read', status: 'allowed', decidedAt: 3 };
  let s = applySnapshot(initialState(), snapshot({ gate: { pending: [pendingItem], recent: [oldItem] }, ledger: { day: '2026-10-10', domains: {}, judge: { usd: 0, calls: 0 } } }));
  assert.deepEqual(pendingGate(s).map((i) => i.itemId), ['g0']);
  assert.deepEqual(recentGate(s).map((i) => i.itemId), ['g-old']);
  assert.equal(s.ledger.day, '2026-10-10');
  s = reduce(s, [
    ev('agent.run.start', { runId: 'r', agentId: 'ranger', provider: 'p', model: 'm', prompt: 'x', maxTurns: 3, budgetUsd: 1, tools: ['fs.read'] }),
    ev('agent.tool_call', { runId: 'r', turn: 1, callId: 'c1', name: 'fs.read', input: { path: 'a' } }),
    ev('gate.item', { itemId: 'g1', agentId: 'ranger', kind: 'action', domain: 'research', tool: 'fs.read', summary: 'read a', status: 'pending', runId: 'r', callId: 'c1', turn: 1, level: 'draft' }),
    ev('agent.waiting', { runId: 'r', agentId: 'ranger', itemId: 'g1' }),
  ]);
  assert.equal(s.agentStates.ranger, 'waiting');
  assert.deepEqual(pendingGate(s).map((i) => i.itemId), ['g0', 'g1']);
  s = reduce(s, [ev('gate.item', { itemId: 'g1', agentId: 'ranger', kind: 'action', domain: 'research', tool: 'fs.read', summary: 'read a', status: 'approved', runId: 'r', callId: 'c1', turn: 1, level: 'draft' })]);
  assert.equal(s.agentStates.ranger, 'tool-running');
  assert.equal(s.gateItems.g1.status, 'approved');
  assert.equal(s.gateOrder.filter((id) => id === 'g1').length, 1, 'upsert, not append');
  assert.deepEqual(pendingGate(s).map((i) => i.itemId), ['g0']);
  assert.match(s.runs.r.items.at(-1).text, /Approved at the Entrance Gate/);
  s = reduce(s, [
    ev('gate.item', { itemId: 'g2', agentId: 'ranger', kind: 'action', domain: 'publishing', tool: 'social.post', summary: 'post', status: 'refused', runId: 'r', level: 'observe' }),
  ]);
  assert.equal(s.agentStates.ranger, 'tool-running', 'a refusal is not a wait');
  assert.equal(recentGate(s)[0].itemId, 'g2');
  s = reduce(s, [ev('gate.item', { itemId: 'g0', agentId: 'ranger', kind: 'proposal', domain: 'publishing', tool: 'leash.loosen', summary: 'loosen?', status: 'rejected' })]);
  assert.equal(pendingGate(s).length, 0);
});

test('judge.verdict lands in the run transcript as a judge item; the snapshot carries judge status', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ judge: { provider: 'anthropic', model: 'claude-sonnet-5-5', caps: { judgeUsdPerDay: 10 }, today: { usd: 0.2, calls: 3 }, wired: true } }));
  assert.equal(s.judge.today.calls, 3);
  s = reduce(s, [
    ev('agent.run.start', { runId: 'r', agentId: 'ranger', provider: 'p', model: 'm', prompt: 'x', maxTurns: 3, budgetUsd: 1, tools: [] }),
    ev('judge.verdict', { agentId: 'ranger', runId: 'r', turn: 1, verdict: 'revise', scope: 'action', provider: 'anthropic', model: 'claude-sonnet-5-5', usd: 0.01, reconciled: true, notes: 'add a price', tools: ['social.post'] }),
    ev('judge.verdict', { agentId: 'ranger', runId: 'r', turn: 2, verdict: 'skipped', scope: 'final', reason: 'cap', usd: null, reconciled: false }),
  ]);
  const v = judgeVerdicts(s.runs.r);
  assert.deepEqual(v.map((x) => [x.turn, x.scope, x.verdict, x.notes, x.reason, x.usd]), [[1, 'action', 'revise', 'add a price', '', 0.01], [2, 'final', 'skipped', '', 'cap', null]]);
  assert.equal(s.agentStates.ranger, 'thinking', 'a verdict does not change the body state');
});

test('crew.agent creates, updates and removes layout agents and their idle state', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ agents: [{ id: 'ranger', role: 'ranger' }] }));
  assert.equal(s.agents.length, 1);
  const rec = { id: 'scout-1', name: 'Scout', roomId: 'ranger-station', x: 1, y: 1, role: 'ranger', parentAgentId: 'chief-ranger' };
  s = reduce(s, [ev('crew.agent', { agentId: 'scout-1', change: 'created', agent: rec, by: 'chief-ranger' })]);
  assert.equal(s.layout.agents.length, 2);
  assert.equal(s.agentStates['scout-1'], 'idle');
  s = reduce(s, [ev('crew.agent', { agentId: 'scout-1', change: 'updated', agent: { ...rec, name: 'Scout Ada' } })]);
  assert.equal(s.layout.agents.find((a) => a.id === 'scout-1').name, 'Scout Ada');
  assert.equal(s.layout.agents.length, 2);
  s = reduce(s, [ev('crew.agent', { agentId: 'scout-1', change: 'removed' })]);
  assert.equal(s.layout.agents.length, 1);
  assert.equal('scout-1' in s.agentStates, false);
});

test('concurrent runs: queued runs, several active runs, and work items from handoff to done', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ activeRuns: [{ runId: 'r0', agentId: 'ranger', startedAt: 1 }], queuedRuns: [], maxConcurrent: 2, work: { inTransit: [{ id: 'w0', fromAgentId: 'chief', toAgentId: 'ranger', toRoomId: 'ranger-station', status: 'running', brief: 'old' }], recent: [] } }));
  assert.equal(s.agentStates.ranger, 'thinking');
  assert.equal(s.maxConcurrent, 2);
  assert.deepEqual(workInTransit(s).map((w) => w.id), ['w0']);
  s = reduce(s, [
    ev('crew.agent', { agentId: 'scout', change: 'created', agent: { id: 'scout', name: 'Scout', roomId: 'ranger-station', x: 5, y: 5, role: 'ranger' } }),
    ev('agent.run.queued', { runId: 'r1', agentId: 'scout', position: 0, workItemId: 'w1' }),
    ev('work.handoff', { fromAgentId: 'chief', toAgentId: 'scout', fromRoomId: 'mountain-peak', toRoomId: 'ranger-station', trailId: 't', workItemId: 'w1', summary: 'find niches' }),
  ]);
  assert.deepEqual(s.queuedRuns.map((r) => r.runId), ['r1']);
  assert.equal(s.agentStates.scout, 'idle', 'queued is not running');
  assert.deepEqual(workInTransit(s, 'ranger-station').map((w) => w.id), ['w0', 'w1']);
  assert.equal(s.handoffs.scout.workItemId, 'w1');
  s = reduce(s, [ev('agent.run.start', { runId: 'r1', agentId: 'scout', provider: 'p', model: 'm', prompt: 'x', maxTurns: 3, budgetUsd: 1, tools: [] })]);
  assert.deepEqual(s.queuedRuns, []);
  assert.deepEqual(s.activeRuns.map((r) => r.runId), ['r0', 'r1']);
  assert.equal(s.agentStates.scout, 'thinking');
  s = reduce(s, [
    ev('agent.run.end', { runId: 'r1', reason: 'completed', turns: 1, finalText: 'done', usage: { inputTokens: 1, outputTokens: 1 } }),
    ev('work.done', { workItemId: 'w1', fromAgentId: 'chief', toAgentId: 'scout', runId: 'r1', status: 'done', reason: 'completed', deliverables: ['outbox/niches.md'], summary: 'three niches', spentUsd: 0 }),
  ]);
  assert.deepEqual(s.activeRuns.map((r) => r.runId), ['r0'], 'the other run stays active');
  assert.equal(s.activeRun.runId, 'r0');
  assert.equal(s.workItems.w1.status, 'done');
  assert.deepEqual(s.workItems.w1.deliverables, ['outbox/niches.md']);
  assert.equal('scout' in s.handoffs, false, 'the walk is over');
  assert.deepEqual(workFor(s, 'scout').map((w) => w.id), ['w1']);
  assert.deepEqual(workInTransit(s).map((w) => w.id), ['w0']);
  s = reduce(s, [ev('agent.run.error', { runId: 'r0', turn: 1, message: 'boom' })]);
  assert.equal(s.activeRun, null);
});

test('plan.updated keeps the mission status and the latest plan at the Peak', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ mission: { mission: { id: 'm1', text: 'sell lanterns', status: 'planning', budgetUsd: 5, horizon: '30 days' }, plan: null } }));
  s = reduce(s, [ev('plan.updated', { missionId: 'm1', change: 'submitted', planId: 'p1', version: 1, status: 'active', summary: 'one venture', by: 'chief-ranger', runId: 'r', ventures: [{ id: 'lantern-co', name: 'Lantern Co', budgetUsd: 4, taskCount: 2 }] })]);
  assert.equal(s.mission.mission.status, 'active');
  assert.equal(s.mission.mission.text, 'sell lanterns');
  assert.equal(s.mission.plan.version, 1);
  assert.equal(s.mission.plan.ventures[0].name, 'Lantern Co');
  s = reduce(s, [ev('plan.updated', { missionId: 'm1', planId: 'p1', version: 1, change: 'status', status: 'paused', reason: 'judge cap' })]);
  assert.equal(s.mission.mission.status, 'paused');
  assert.equal(s.mission.mission.reason, 'judge cap');
  assert.equal(s.mission.plan.version, 1, 'a status change keeps the plan');
  assert.equal(s.planUpdates.length, 2);
  const fresh = reduce(applySnapshot(initialState(), snapshot()), [ev('plan.updated', { missionId: 'm2', change: 'status', status: 'planning', summary: 'new mission text' })]);
  assert.equal(fresh.mission.mission.id, 'm2');
  assert.equal(fresh.mission.mission.text, 'new mission text');
});

test('reflection.posted and budget.threshold reach the Peak view', () => {
  seq = 0;
  let s = applySnapshot(initialState(), snapshot({ reflection: { latest: null, schedule: { daily: '07:00' }, job: { nextRunAt: 5 } } }));
  assert.equal(s.reflection.job.nextRunAt, 5);
  s = reduce(s, [
    ev('budget.threshold', { scope: 'mission', id: 'm1', budgetUsd: 5, spentUsd: 4, threshold: 0.8, fraction: 0.8 }),
    ev('reflection.posted', { reflectionId: 'reflection-1', reason: 'scheduled', status: 'posted', portfolio: 'Fine.', ventures: [{ id: 'v1', planStillRight: false }], briefings: ['research'], usd: 0.01, reconciled: true }),
  ]);
  assert.equal(s.budgetAlerts.length, 1);
  assert.equal(s.reflection.latest.id, 'reflection-1');
  assert.equal(s.reflection.latest.ventures[0].planStillRight, false);
  assert.equal(s.reflection.schedule.daily, '07:00', 'the schedule survives an update');
  s = reduce(s, [ev('reflection.posted', { reflectionId: 'reflection-2', reason: 'manual', status: 'skipped', skipReason: 'cap' })]);
  assert.equal(s.reflection.latest.status, 'skipped');
  assert.equal(s.reflection.latest.skipReason, 'cap');
});

test('step 7: a work.done with files starts a delivery walk to the Visitor Center; spend per agent accumulates from cost events', () => {
  seq = 0;
  const layout = defaultLayout();
  layout.rooms.push({ id: 'visitor-center', name: 'Visitor Center', kind: 'visitor_center', x: 21, y: 1, w: 8, h: 6 });
  let s = applySnapshot(initialState(), snapshot({ layout, reflection: { spentByAgent: { ranger: 0.5 } } }));
  assert.equal(s.spendByAgent.ranger, 0.5);
  s = reduce(s, [
    ev('agent.run.start', { runId: 'r', agentId: 'ranger', provider: 'p', model: 'm', prompt: 'x', maxTurns: 3, budgetUsd: 1, tools: [] }),
    ev('cost.estimate', { runId: 'r', turn: 1, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, usd: 0.25, reconciled: true }),
    ev('cost.estimate', { runId: 'r', turn: 2, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, usd: null, reconciled: false }),
    ev('agent.run.end', { runId: 'r', reason: 'completed', turns: 2, finalText: 'done', usage: { inputTokens: 2, outputTokens: 2 } }),
    ev('work.done', { workItemId: 'w1', fromAgentId: 'superintendent', toAgentId: 'ranger', runId: 'r', status: 'done', deliverables: ['outbox/a.md'], summary: 's' }),
    ev('work.done', { workItemId: 'w2', fromAgentId: 'superintendent', toAgentId: 'ranger', runId: 'r', status: 'done', deliverables: [], summary: 'nothing to deliver' }),
  ]);
  assert.equal(s.spendByAgent.ranger, 0.75);
  assert.equal(s.deliveries.ranger.workItemId, 'w1', 'a work.done without files does not start a walk');
  assert.equal(s.deliveries.ranger.fromZone, 'ranger-station');
  assert.deepEqual(s.deliveries.ranger.deliverables, ['outbox/a.md']);
  s = reduce(s, [ev('crew.agent', { agentId: 'ranger', change: 'updated', agent: { ...layout.agents[0], paused: true } })]);
  assert.equal(s.layout.agents[0].paused, true);
});
