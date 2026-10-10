// Frontend state: a pure reducer over validated events plus the /api/state snapshot.
// No DOM here, so it is tested with node --test (test/frontend-state.test.js).
//
// Truthful telemetry rules enforced in this file:
//   - an agent's visual state changes only on an event about a run of that agent;
//   - spend sums reconciled cost events only, and never counts an event twice;
//   - nothing is marked "done" or "error" without the matching run.end / run.error.

import { validateEvent } from '../shared/events.js';

export const AGENT_STATES = Object.freeze(['idle', 'thinking', 'tool-running', 'waiting', 'done', 'error']);

export function initialState() {
  return {
    connected: false,
    snapshotSeq: 0,
    lastSeq: 0,
    providers: {},
    policy: null, // router policy from the snapshot (worker / judge tiers)
    judge: null, // { provider, model, caps, today: { usd, calls }, wired } from the snapshot
    agents: [], // agent records from the snapshot (zone, reports, grants, resolved leash)
    mission: null, // { mission, plan, chief, caps, judgeToday } from the snapshot; status/plan kept current by plan.updated
    planUpdates: [], // plan.updated payloads this session, oldest first
    reflection: null, // { latest, schedule, job } from the snapshot; latest kept current by reflection.posted
    budgetAlerts: [], // budget.threshold payloads this session, oldest first
    leash: null, // leash policy from the snapshot (shared/leash.js shape)
    keystore: { path: '', problem: null },
    layout: { version: 1, rooms: [], objects: [], agents: [] },
    objectKinds: {},
    activeRun: null, // { runId, agentId, startedAt } the first active run (compat)
    activeRuns: [], // every active run
    queuedRuns: [], // runs waiting for their agent or a slot
    maxConcurrent: 0,
    workItems: {}, // workItemId -> item (snapshot + work.handoff / work.done)
    workOrder: [],
    runs: {}, // runId -> run view (see newRunView)
    runOrder: [], // newest last
    agentStates: {}, // agentId -> AGENT_STATES
    agentRuns: {}, // agentId -> runId of the run that last touched it
    pendingPrompts: [], // [{ promptId, runId, callId, tool, reason, input }]
    gateItems: {}, // itemId -> latest gate.item payload (+ ts)
    gateOrder: [], // itemIds, oldest first
    ledger: null, // today's per-domain totals from the sidecar's leash ledger
    handoffs: {}, // agentId -> { fromZone, toZone, workItemId, startedAt } (latest work.handoff per walker)
    workspace: null, // { root, online, known, since, reason } from the sidecar's watcher
    spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 },
    invalidEvents: 0,
  };
}

function newRunView(payload) {
  return {
    runId: payload.runId,
    agentId: payload.agentId,
    provider: payload.provider,
    model: payload.model,
    prompt: payload.prompt,
    tools: payload.tools,
    maxTurns: payload.maxTurns,
    budgetUsd: payload.budgetUsd,
    status: 'running', // running | ended | error
    reason: null,
    turns: 0,
    items: [], // ordered transcript items: {kind:'text', text} | {kind:'tool', callId, name, input, result?} | {kind:'note', text} | {kind:'cost', ...}
    usage: { inputTokens: 0, outputTokens: 0 },
    spentUsd: 0,
    unreconciledTurns: 0,
    error: null,
  };
}

// Applies the /api/state snapshot. Replaces layout/providers/spend and marks the seq the
// snapshot already accounts for, so replayed cost events are not summed twice.
export function applySnapshot(state, snap) {
  const next = { ...state };
  next.snapshotSeq = snap.seq || 0;
  next.lastSeq = Math.max(state.lastSeq, next.snapshotSeq);
  next.providers = snap.providers || {};
  next.policy = snap.policy || null;
  next.judge = snap.judge || null;
  next.agents = snap.agents || [];
  next.mission = snap.mission || null;
  next.reflection = snap.reflection || null;
  next.leash = snap.leash || null;
  next.workspace = snap.workspace || null;
  next.keystore = snap.keystore || { path: '', problem: null };
  next.layout = snap.layout;
  next.objectKinds = snap.objectKinds || {};
  next.ledger = snap.ledger || null;
  if (snap.gate) {
    const items = { ...state.gateItems };
    const order = [...state.gateOrder];
    for (const it of [...(snap.gate.recent || [])].reverse().concat(snap.gate.pending || [])) {
      if (!items[it.itemId]) order.push(it.itemId);
      items[it.itemId] = { ...it, ts: it.decidedAt || it.createdAt || 0 };
    }
    next.gateItems = items;
    next.gateOrder = order;
  }
  next.activeRun = snap.activeRun || null;
  next.activeRuns = snap.activeRuns || (snap.activeRun ? [snap.activeRun] : []);
  next.queuedRuns = snap.queuedRuns || [];
  next.maxConcurrent = snap.maxConcurrent || 0;
  if (snap.work) {
    const items = { ...state.workItems };
    const order = [...state.workOrder];
    for (const it of [...(snap.work.recent || [])].reverse().concat(snap.work.inTransit || [])) {
      if (!items[it.id]) order.push(it.id);
      items[it.id] = it;
    }
    next.workItems = items;
    next.workOrder = order;
  }
  next.spend = {
    totalUsd: snap.spend ? snap.spend.totalUsd : 0,
    reconciledTurns: snap.spend ? snap.spend.reconciledTurns : 0,
    unreconciledTurns: snap.spend ? snap.spend.unreconciledTurns : 0,
  };
  next.agentStates = { ...state.agentStates };
  for (const a of next.layout.agents) {
    if (!next.agentStates[a.id]) next.agentStates[a.id] = 'idle';
  }
  // The snapshot only knows that a run is active, not what it has done; the SSE replay
  // fills the detail. Until then the agent is "thinking" because a run.start happened.
  next.agentRuns = { ...state.agentRuns };
  for (const r of next.activeRuns) {
    if (next.agentStates[r.agentId] === 'idle') {
      next.agentStates[r.agentId] = 'thinking';
      next.agentRuns[r.agentId] = r.runId;
    }
  }
  return next;
}

function setAgent(state, agentId, agentState, runId) {
  return {
    ...state,
    agentStates: { ...state.agentStates, [agentId]: agentState },
    agentRuns: { ...state.agentRuns, [agentId]: runId },
  };
}

// A run is over: it leaves the active and queued lists and its prompts are dropped.
function dropRun(state, runId) {
  const activeRuns = state.activeRuns.filter((r) => r.runId !== runId);
  return {
    ...state,
    activeRuns,
    activeRun: state.activeRun && state.activeRun.runId === runId ? activeRuns[0] || null : state.activeRun,
    queuedRuns: state.queuedRuns.filter((r) => r.runId !== runId),
    pendingPrompts: state.pendingPrompts.filter((q) => q.runId !== runId),
  };
}

function updateRun(state, runId, fn) {
  const run = state.runs[runId];
  if (!run) return state;
  return { ...state, runs: { ...state.runs, [runId]: fn(run) } };
}

export function applyEvent(state, event) {
  const v = validateEvent(event);
  if (!v.ok) return { ...state, invalidEvents: state.invalidEvents + 1 };
  const seq = typeof event.seq === 'number' ? event.seq : state.lastSeq + 1;
  const alreadyCounted = seq <= state.snapshotSeq; // the snapshot's spend already includes it
  let next = { ...state, lastSeq: Math.max(state.lastSeq, seq) };
  const p = event.payload;

  switch (event.type) {
    case 'agent.run.start': {
      const run = newRunView(p);
      next.runs = { ...next.runs, [p.runId]: run };
      next.runOrder = [...next.runOrder.filter((id) => id !== p.runId), p.runId];
      next.activeRun = { runId: p.runId, agentId: p.agentId, startedAt: event.ts };
      next.activeRuns = [...next.activeRuns.filter((r) => r.runId !== p.runId), { runId: p.runId, agentId: p.agentId, startedAt: event.ts }];
      next.queuedRuns = next.queuedRuns.filter((r) => r.runId !== p.runId);
      next = setAgent(next, p.agentId, 'thinking', p.runId);
      break;
    }
    case 'agent.run.queued': {
      if (!next.queuedRuns.some((r) => r.runId === p.runId)) next.queuedRuns = [...next.queuedRuns, { runId: p.runId, agentId: p.agentId, position: p.position, workItemId: p.workItemId || null }];
      break;
    }
    case 'agent.token': {
      next = updateRun(next, p.runId, (run) => {
        const items = [...run.items];
        const last = items[items.length - 1];
        if (last && last.kind === 'text' && last.turn === p.turn) items[items.length - 1] = { ...last, text: last.text + p.text };
        else items.push({ kind: 'text', turn: p.turn, text: p.text });
        return { ...run, items, turns: Math.max(run.turns, p.turn) };
      });
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'thinking', p.runId);
      break;
    }
    case 'agent.tool_call': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        turns: Math.max(run.turns, p.turn),
        items: [...run.items, { kind: 'tool', turn: p.turn, callId: p.callId, name: p.name, input: p.input, result: null }],
      }));
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'tool-running', p.runId);
      break;
    }
    case 'agent.tool_result': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        items: run.items.map((it) => (it.kind === 'tool' && it.callId === p.callId ? { ...it, result: { ok: p.ok, output: p.output, error: p.error } } : it)),
      }));
      const run = next.runs[p.runId];
      if (run) {
        const stillRunning = run.items.some((it) => it.kind === 'tool' && !it.result);
        next = setAgent(next, run.agentId, stillRunning ? 'tool-running' : 'thinking', p.runId);
      }
      break;
    }
    case 'agent.run.end': {
      next = updateRun(next, p.runId, (run) => ({ ...run, status: 'ended', reason: p.reason, turns: p.turns, usage: p.usage }));
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'done', p.runId);
      next = dropRun(next, p.runId);
      break;
    }
    case 'agent.run.error': {
      next = updateRun(next, p.runId, (run) => ({ ...run, status: 'error', reason: 'error', error: { message: p.message, code: p.code || null } }));
      const run = next.runs[p.runId];
      if (run) next = setAgent(next, run.agentId, 'error', p.runId);
      next = dropRun(next, p.runId);
      break;
    }
    case 'cost.estimate': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        spentUsd: p.reconciled && typeof p.usd === 'number' ? run.spentUsd + p.usd : run.spentUsd,
        unreconciledTurns: p.reconciled ? run.unreconciledTurns : run.unreconciledTurns + 1,
        items: [...run.items, { kind: 'cost', turn: p.turn, tier: p.tier || null, provider: p.provider, model: p.model, inputTokens: p.inputTokens, outputTokens: p.outputTokens, usd: p.usd, reconciled: p.reconciled }],
      }));
      if (!alreadyCounted) {
        next.spend = p.reconciled && typeof p.usd === 'number'
          ? { ...next.spend, totalUsd: next.spend.totalUsd + p.usd, reconciledTurns: next.spend.reconciledTurns + 1 }
          : { ...next.spend, unreconciledTurns: next.spend.unreconciledTurns + 1 };
      }
      break;
    }
    case 'permission.prompt': {
      if (!next.pendingPrompts.some((q) => q.promptId === p.promptId)) {
        next.pendingPrompts = [...next.pendingPrompts, { ...p }];
      }
      const run = next.runs[p.runId];
      if (run && run.status === 'running') next = setAgent(next, run.agentId, 'waiting', p.runId);
      break;
    }
    case 'permission.response': {
      next.pendingPrompts = next.pendingPrompts.filter((q) => q.promptId !== p.promptId);
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        items: [...run.items, { kind: 'note', text: `${p.allow ? 'Allowed' : 'Denied'} at the Entrance Gate` }],
      }));
      const run = next.runs[p.runId];
      if (run && run.status === 'running' && !next.pendingPrompts.some((q) => q.runId === p.runId)) {
        next = setAgent(next, run.agentId, 'tool-running', p.runId);
      }
      break;
    }
    case 'object.place': {
      if (!next.layout.objects.some((o) => o.id === p.objectId)) {
        next.layout = { ...next.layout, objects: [...next.layout.objects, { id: p.objectId, kind: p.kind, roomId: p.roomId, x: p.x, y: p.y }] };
      }
      break;
    }
    case 'object.reclaim': {
      next.layout = { ...next.layout, objects: next.layout.objects.filter((o) => o.id !== p.objectId) };
      break;
    }
    case 'layout.seed': {
      next.layout = { ...next.layout, seed: p.seed };
      break;
    }
    case 'workspace.offline': {
      next.workspace = { ...(next.workspace || {}), root: p.root, online: false, known: true, since: event.ts, reason: p.reason };
      break;
    }
    case 'workspace.online': {
      next.workspace = { ...(next.workspace || {}), root: p.root, online: true, known: true, since: event.ts, reason: null };
      break;
    }
    case 'gate.item': {
      const prev = next.gateItems[p.itemId];
      next.gateItems = { ...next.gateItems, [p.itemId]: { ...(prev || {}), ...p, ts: event.ts } };
      if (!prev) next.gateOrder = [...next.gateOrder, p.itemId];
      const run = p.runId ? next.runs[p.runId] : null;
      if (run && run.status === 'running') {
        if (p.status === 'pending') next = setAgent(next, run.agentId, 'waiting', p.runId);
        else if (['approved', 'revised', 'rejected', 'expired'].includes(p.status)) {
          next = updateRun(next, p.runId, (r) => ({ ...r, items: [...r.items, { kind: 'note', text: `${p.status[0].toUpperCase()}${p.status.slice(1)} at the Entrance Gate (${p.domain}: ${p.summary})${p.notes ? ` — ${p.notes}` : ''}` }] }));
          if (!pendingGate(next).some((it) => it.runId === p.runId) && !next.pendingPrompts.some((q) => q.runId === p.runId)) next = setAgent(next, run.agentId, 'tool-running', p.runId);
        }
      }
      break;
    }
    case 'judge.verdict': {
      next = updateRun(next, p.runId, (run) => ({
        ...run,
        items: [...run.items, { kind: 'judge', turn: p.turn, scope: p.scope, verdict: p.verdict, notes: p.notes || '', reason: p.reason || '', provider: p.provider || '', model: p.model || '', usd: typeof p.usd === 'number' ? p.usd : null, reconciled: Boolean(p.reconciled), tools: p.tools || [] }],
      }));
      break;
    }
    case 'plan.updated': {
      next.planUpdates = [...next.planUpdates, { ...p, ts: event.ts }];
      const m = next.mission ? { ...next.mission } : { mission: null, plan: null };
      if (m.mission && m.mission.id === p.missionId && p.status) m.mission = { ...m.mission, status: p.status, reason: p.reason || '' };
      if (!m.mission || m.mission.id !== p.missionId) m.mission = { id: p.missionId, text: m.mission && m.mission.id === p.missionId ? m.mission.text : p.change === 'status' && p.summary ? p.summary : '', status: p.status || 'planning', reason: p.reason || '', budgetUsd: null, horizon: '' };
      if (p.change === 'submitted') m.plan = { ...(m.plan || {}), id: p.planId, missionId: p.missionId, version: p.version, summary: p.summary || '', ventures: p.ventures || [], by: p.by, runId: p.runId, submittedAt: event.ts };
      next.mission = m;
      break;
    }
    case 'reflection.posted': {
      const latest = { id: p.reflectionId, at: event.ts, reason: p.reason, status: p.status, skipReason: p.skipReason || null, missionId: p.missionId || null, model: p.model || null, usd: typeof p.usd === 'number' ? p.usd : null, portfolio: p.portfolio || '', ventures: p.ventures || [], briefings: p.briefings || [], path: p.path || null };
      next.reflection = { ...(next.reflection || {}), latest };
      break;
    }
    case 'budget.threshold': {
      next.budgetAlerts = [...next.budgetAlerts, { ...p, ts: event.ts }];
      break;
    }
    case 'crew.agent': {
      const others = next.layout.agents.filter((a) => a.id !== p.agentId);
      if (p.change === 'removed') {
        next.layout = { ...next.layout, agents: others };
        const states = { ...next.agentStates };
        delete states[p.agentId];
        next.agentStates = states;
      } else if (p.agent && p.agent.id === p.agentId) {
        const idx = next.layout.agents.findIndex((a) => a.id === p.agentId);
        const agents = idx === -1 ? [...next.layout.agents, p.agent] : next.layout.agents.map((a) => (a.id === p.agentId ? p.agent : a));
        next.layout = { ...next.layout, agents };
        if (!next.agentStates[p.agentId]) next.agentStates = { ...next.agentStates, [p.agentId]: 'idle' };
      }
      break;
    }
    case 'agent.waiting': {
      const run = next.runs[p.runId];
      if (run && run.status === 'running') next = setAgent(next, p.agentId, 'waiting', p.runId);
      break;
    }
    case 'work.handoff': {
      next.handoffs = { ...next.handoffs, [p.toAgentId]: { fromZone: p.fromRoomId, toZone: p.toRoomId, workItemId: p.workItemId, summary: p.summary, startedAt: event.ts } };
      const prev = next.workItems[p.workItemId];
      next.workItems = { ...next.workItems, [p.workItemId]: { ...(prev || {}), id: p.workItemId, fromAgentId: p.fromAgentId, toAgentId: p.toAgentId, fromRoomId: p.fromRoomId, toRoomId: p.toRoomId, trailId: p.trailId || null, brief: prev ? prev.brief : p.summary, status: prev && prev.status !== 'queued' ? prev.status : 'running', createdAt: prev ? prev.createdAt : event.ts } };
      if (!prev) next.workOrder = [...next.workOrder, p.workItemId];
      break;
    }
    case 'work.done': {
      const prev = next.workItems[p.workItemId];
      next.workItems = { ...next.workItems, [p.workItemId]: { ...(prev || { id: p.workItemId, fromAgentId: p.fromAgentId, toAgentId: p.toAgentId, brief: '' }), status: p.status, reason: p.reason || null, runId: p.runId, deliverables: p.deliverables, summary: p.summary, spentUsd: p.spentUsd || 0, endedAt: event.ts } };
      if (!prev) next.workOrder = [...next.workOrder, p.workItemId];
      if (next.handoffs[p.toAgentId] && next.handoffs[p.toAgentId].workItemId === p.workItemId) {
        const handoffs = { ...next.handoffs };
        delete handoffs[p.toAgentId];
        next.handoffs = handoffs;
      }
      break;
    }
    default:
      break;
  }
  return next;
}

// Work items in flight (queued or running), oldest first; optionally only those bound for a zone.
export function workInTransit(state, toRoomId = null) {
  return state.workOrder.map((id) => state.workItems[id]).filter((it) => it && (it.status === 'queued' || it.status === 'running') && (!toRoomId || it.toRoomId === toRoomId));
}

// Work items an agent sent or received, newest first.
export function workFor(state, agentId) {
  return state.workOrder.map((id) => state.workItems[id]).filter((it) => it && (it.fromAgentId === agentId || it.toAgentId === agentId)).reverse();
}

// Gate items still waiting on the Superintendent, oldest first.
export function pendingGate(state) {
  return state.gateOrder.map((id) => state.gateItems[id]).filter((it) => it && it.status === 'pending');
}

// Decided or logged Gate items, newest first.
export function recentGate(state, n = 20) {
  return state.gateOrder.map((id) => state.gateItems[id]).filter((it) => it && it.status !== 'pending').slice(-n).reverse();
}

// Tools granted to an agent by the current layout (mirrors shared/world.js grantsFor, but
// uses the snapshot's objectKinds so the frontend never hardcodes the mapping).
export function grantedTools(state, agentId) {
  const agent = state.layout.agents.find((a) => a.id === agentId);
  if (!agent) return [];
  const out = new Set();
  for (const o of state.layout.objects) {
    if (o.roomId !== agent.roomId) continue;
    const kind = state.objectKinds[o.kind];
    if (kind) for (const t of kind.grants || []) out.add(t);
  }
  return [...out].sort();
}

export function currentRun(state) {
  const id = state.activeRun ? state.activeRun.runId : state.runOrder[state.runOrder.length - 1];
  return id ? state.runs[id] || null : null;
}

// Tool calls seen this session through the given tools (for a fixture's inspect card).
export function toolUses(state, toolNames) {
  const out = [];
  for (const id of state.runOrder) {
    const run = state.runs[id];
    for (const it of run.items) {
      if (it.kind === 'tool' && toolNames.includes(it.name)) out.push({ runId: id, callId: it.callId, name: it.name, ok: it.result ? it.result.ok : null, input: it.input });
    }
  }
  return out;
}

// Judge verdicts of a run, in order.
export function judgeVerdicts(run) {
  return run ? run.items.filter((it) => it.kind === 'judge') : [];
}

// The most recent cost line of a run, i.e. which model last ran a turn for it.
export function lastModel(run) {
  if (!run) return null;
  for (let i = run.items.length - 1; i >= 0; i--) if (run.items[i].kind === 'cost') return run.items[i];
  return null;
}
