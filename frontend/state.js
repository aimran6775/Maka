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
    away: null, // { away, since, actions, waiting, spentUsd, lastDigest } from the snapshot and away.changed / away.digest
    mail: null, // { domain, keys: { resend, cloudflare }, lastPlan, lastApply } from the snapshot; dns kept current by mail.dns
    mailDns: [], // mail.dns payloads this session, oldest first
    mailMessages: [], // mail.message payloads this session, oldest first (bounded)
    mailEvents: [], // mail.event payloads this session, oldest first (bounded)
    connectors: [], // one row per connector from the snapshot; connector.* events patch them
    connectorEvents: [], // connector.sync / connector.error payloads this session, oldest first (bounded)
    research: null, // { search, searchKey, trends, judge } from the snapshot
    channels: null, // { adapters: [row per channel], pairing } from the snapshot; channel.connect patches rows (phase 4 step 1)
    channelEvents: [], // channel.inbound / channel.delivery payloads this session, oldest first (bounded)
    setup: null, // the first-run flow from the snapshot (/api/setup shape); setup.changed asks for a re-read
    setupChanges: [], // setup.changed payloads this session, oldest first
    ollama: null, // the local worker summary from the snapshot (/api/ollama shape without a fresh probe)
    ollamaPull: null, // the latest ollama.pull payload (+ ts), null when nothing is being pulled
    backup: null, // the R2 backup status from the snapshot (/api/backup shape)
    backupEvents: [], // backup.snapshot / backup.restore payloads this session, oldest first (bounded)
    browser: null, // { chromium, wired, headless, sessions, pending } from the snapshot
    browserHandoffs: {}, // handoffId -> latest browser.handoff payload (+ ts)
    browserHandoffOrder: [], // handoffIds, oldest first
    leash: null, // leash policy from the snapshot (shared/leash.js shape)
    keystore: { path: '', problem: null, broker: false },
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
    deliveries: {}, // agentId -> { fromZone, workItemId, deliverables, startedAt } (latest work.done with files; the walk to the Visitor Center)
    spendByAgent: {}, // agentId -> reconciled USD since the last mission (from the snapshot)
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
  next.away = snap.away || null;
  next.mail = snap.mail || null;
  next.browser = snap.browser || null;
  next.connectors = Array.isArray(snap.connectors) ? snap.connectors : [];
  next.research = snap.research || null;
  next.channels = snap.channels || null;
  next.setup = snap.setup || null;
  next.ollama = snap.ollama || null;
  next.backup = snap.backup || null;
  if (next.ollama && !next.ollama.pulling && next.ollamaPull && next.ollamaPull.done) next.ollamaPull = null;
  if (snap.browser && Array.isArray(snap.browser.pending)) {
    const handoffs = { ...next.browserHandoffs };
    const order = [...next.browserHandoffOrder];
    for (const h of snap.browser.pending) {
      if (!handoffs[h.handoffId]) order.push(h.handoffId);
      handoffs[h.handoffId] = { ...h, ts: h.since || 0 };
    }
    next.browserHandoffs = handoffs;
    next.browserHandoffOrder = order;
  }
  next.spendByAgent = (snap.reflection && snap.reflection.spentByAgent) || {};
  next.leash = snap.leash || null;
  next.workspace = snap.workspace || null;
  next.keystore = snap.keystore || { path: '', problem: null, broker: false };
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
      if (!alreadyCounted && p.reconciled && typeof p.usd === 'number' && next.runs[p.runId]) {
        const agentId = next.runs[p.runId].agentId;
        next.spendByAgent = { ...next.spendByAgent, [agentId]: (next.spendByAgent[agentId] || 0) + p.usd };
      }
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
      if (p.status !== 'pending' && next.away && next.away.away) next.away = { ...next.away, actions: (next.away.actions || 0) + 1 };
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
    case 'mail.message': {
      next.mailMessages = [...next.mailMessages, { ...p, ts: event.ts }].slice(-500);
      if (next.mail && next.mail.counts) {
        const byStation = { ...(next.mail.counts.byStation || {}) };
        byStation[p.station] = { ...(byStation[p.station] || { in: 0, out: 0 }) };
        byStation[p.station][p.direction] += 1;
        next.mail = { ...next.mail, counts: { ...next.mail.counts, messages: (next.mail.counts.messages || 0) + 1, unread: next.mail.counts.unread + (p.direction === 'in' ? 1 : 0), byStation } };
      }
      break;
    }
    case 'mail.event': {
      next.mailEvents = [...next.mailEvents, { ...p, ts: event.ts }].slice(-500);
      break;
    }
    case 'mail.address': {
      if (next.mail) next.mail = { ...next.mail, addresses: Math.max(0, (next.mail.addresses || 0) + (p.change === 'created' ? 1 : -1)) };
      break;
    }
    case 'mail.dns': {
      next.mailDns = [...next.mailDns, { ...p, ts: event.ts }];
      break;
    }
    case 'connector.sync':
    case 'connector.error':
    case 'connector.status': {
      next.connectorEvents = [...next.connectorEvents, { type: event.type, ...p, ts: event.ts }].slice(-200);
      next.connectors = next.connectors.map((c) => {
        if (c.kind !== p.connector) return c;
        if (event.type === 'connector.sync') {
          if (p.status === 'started') return { ...c, syncing: true };
          return { ...c, syncing: false, lastSync: { at: event.ts, ok: p.status === 'done', reason: p.reason || '', counts: p.counts || {}, error: p.message || null, ms: p.ms || 0 }, syncedAt: p.status === 'done' ? event.ts : c.syncedAt, connected: p.status === 'done' ? true : c.connected };
        }
        if (event.type === 'connector.error') return { ...c, lastError: { at: event.ts, stage: p.stage, message: p.message, code: p.code || '' } };
        return { ...c, connected: p.connected, auth: p.auth || c.auth, by: p.by || c.by, authorizeUrl: p.change === 'authorizing' ? p.authorizeUrl || null : null, pendingItemId: null };
      });
      break;
    }
    case 'channel.connect': {
      next.channelEvents = [...next.channelEvents, { type: event.type, ...p, ts: event.ts }].slice(-200);
      if (next.channels) next.channels = { ...next.channels, adapters: (next.channels.adapters || []).map((c) => (c.name === p.channel ? { ...c, status: p.status, by: p.by || c.by, detail: p.status === 'up' ? p.message || c.detail : c.detail, lastError: p.status === 'error' ? { at: event.ts, message: p.message || '' } : c.lastError, pendingItemId: null } : c)) };
      break;
    }
    case 'channel.inbound':
    case 'channel.delivery': {
      next.channelEvents = [...next.channelEvents, { type: event.type, ...p, ts: event.ts }].slice(-200);
      if (event.type === 'channel.inbound' && p.action === 'pair' && next.channels) {
        next.channels = { ...next.channels, adapters: (next.channels.adapters || []).map((c) => {
          if (c.name !== p.channel) return c;
          const paired = (c.paired || []).filter((x) => x.chatId !== p.chatId);
          return { ...c, paired: p.paired && p.outcome === 'paired' ? [...paired, { chatId: p.chatId, userId: p.userId, pairedAt: event.ts }] : paired };
        }), pairing: p.outcome === 'paired' ? null : next.channels.pairing };
      }
      break;
    }
    case 'browser.handoff': {
      const prev = next.browserHandoffs[p.handoffId];
      next.browserHandoffs = { ...next.browserHandoffs, [p.handoffId]: { ...(prev || {}), ...p, ts: event.ts } };
      if (!prev) next.browserHandoffOrder = [...next.browserHandoffOrder, p.handoffId].slice(-100);
      const run = p.runId ? next.runs[p.runId] : null;
      if (run && run.status === 'running') {
        if (p.status === 'waiting') next = setAgent(next, p.agentId, 'waiting', p.runId);
        else {
          next = updateRun(next, p.runId, (r) => ({ ...r, items: [...r.items, { kind: 'note', text: `Browser handoff (${p.kind}) ${p.status}${p.notes ? ` — ${p.notes}` : ''}` }] }));
          if (p.status === 'returned') next = setAgent(next, p.agentId, 'tool-running', p.runId);
        }
      }
      break;
    }
    case 'ollama.pull': {
      next.ollamaPull = { ...p, ts: event.ts };
      if (next.ollama) next.ollama = { ...next.ollama, pulling: p.done ? null : { model: p.model, status: p.status, completed: p.completed || 0, total: p.total || 0 } };
      break;
    }
    case 'backup.snapshot':
    case 'backup.restore': {
      next.backupEvents = [...next.backupEvents.slice(-19), { type: event.type, ...p, ts: event.ts }];
      if (next.backup && event.type === 'backup.snapshot') next.backup = { ...next.backup, running: p.status === 'started' ? { startedAt: event.ts, reason: p.reason } : null, last: p.status === 'started' ? next.backup.last : { at: event.ts, reason: p.reason, status: p.status, key: p.key || null, files: p.files ?? null, error: p.error || null } };
      if (next.backup && event.type === 'backup.restore' && p.status === 'done') next.backup = { ...next.backup, lastRestore: { at: event.ts, key: p.key, into: p.into || null, files: p.files ?? null } };
      break;
    }
    case 'setup.changed': {
      next.setupChanges = [...next.setupChanges.slice(-19), { ...p, ts: event.ts }];
      if (next.setup) {
        if (p.change === 'completed' || p.change === 'skipped') next.setup = { ...next.setup, firstRun: false, skipped: p.change === 'skipped', completedAt: event.ts };
        else if (p.change === 'done') next.setup = { ...next.setup, steps: { ...(next.setup.steps || {}), [p.step]: { doneAt: event.ts, detail: p.detail || '' } } };
      }
      break;
    }
    case 'away.changed': {
      next.away = { ...(next.away || {}), away: p.away, since: p.since, actions: p.actions || 0, waiting: p.waiting || 0 };
      break;
    }
    case 'away.digest': {
      next.away = { ...(next.away || {}), lastDigest: { digestId: p.digestId, since: p.since, until: p.until, actions: p.actions, waiting: p.waiting, spentUsd: p.spentUsd || 0, path: p.path, summary: p.summary || '' } };
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
      if (p.status === 'done' && p.deliverables && p.deliverables.length) {
        const agent = next.layout.agents.find((a) => a.id === p.toAgentId);
        if (agent) next.deliveries = { ...next.deliveries, [p.toAgentId]: { fromZone: agent.roomId, workItemId: p.workItemId, deliverables: p.deliverables, startedAt: event.ts } };
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
export function pendingHandoffs(state) {
  return state.browserHandoffOrder.map((id) => state.browserHandoffs[id]).filter((h) => h && h.status === 'waiting');
}

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
