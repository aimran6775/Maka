// Maka event contract. FROZEN and ADDITIVE-ONLY.
//
// Every state transition in the harness is one of these events. The sidecar validates an
// event before emitting it; the frontend validates it again on receipt; the HTTP API
// validates client-originated events (permission.response, object.place, object.reclaim)
// before acting on them.
//
// Rules for changing this file:
//   - never rename or remove an event type, a field, or an enum value;
//   - new fields are optional; new events are new entries;
//   - bump CONTRACT_VERSION only for an additive change that a receiver might care about.
//
// Envelope: { v, id, type, ts, seq?, payload }
//   v       contract version (CONTRACT_VERSION)
//   id      unique id for the event
//   type    one of EVENT_TYPES
//   ts      milliseconds since epoch, from the emitter's clock
//   seq     monotonic position in the sidecar event log (assigned by the log, optional)
//   payload shape given by PAYLOAD_SCHEMAS[type]

import { validate, assertValid, deepFreeze } from './schema.js';

export const CONTRACT_VERSION = 1;

const str = { type: 'string' };
const nonEmpty = { type: 'string', minLength: 1 };
const int0 = { type: 'integer', minimum: 0 };
const int1 = { type: 'integer', minimum: 1 };
const num0 = { type: 'number', minimum: 0 };
const bool = { type: 'boolean' };
const obj = { type: 'object' };

const usage = {
  type: 'object',
  required: ['inputTokens', 'outputTokens'],
  additionalProperties: false,
  properties: { inputTokens: int0, outputTokens: int0 },
};

function payload(required, properties) {
  return { type: 'object', required, additionalProperties: false, properties };
}

export const RUN_END_REASONS = deepFreeze(['completed', 'cancelled', 'max_turns', 'budget']);

// Gate item lifecycle (phase 2 step 1). An item is emitted once per status change with the
// same itemId, so a receiver upserts by id:
//   pending   waiting on the Superintendent (level 'draft', or 'act_capped' over its cap)
//   approved / revised / rejected   the Superintendent's decision on a pending item
//   allowed   the leash let the action through ('act_free', or 'act_capped' under cap)
//   refused   the leash blocked it outright ('observe')
//   expired   the run ended (or the sidecar restarted) before a decision
export const GATE_ITEM_STATUSES = deepFreeze(['pending', 'approved', 'revised', 'rejected', 'allowed', 'refused', 'expired']);
// 'action' is a tool call under a leash domain; 'proposal' is the ledger asking to loosen a
// leash after a streak of approvals (approve applies it, reject resets the streak).
export const GATE_ITEM_KINDS = deepFreeze(['action', 'proposal']);
const LEASH_LEVEL_ENUM = deepFreeze(['observe', 'draft', 'act_capped', 'act_free']);

export const PAYLOAD_SCHEMAS = deepFreeze({
  // A run began. `tools` lists the tool names the agent was granted by its room layout.
  'agent.run.start': payload(
    ['runId', 'agentId', 'provider', 'model', 'prompt', 'maxTurns', 'budgetUsd', 'tools'],
    {
      runId: nonEmpty,
      agentId: nonEmpty,
      provider: nonEmpty,
      model: nonEmpty,
      prompt: str,
      maxTurns: int1,
      budgetUsd: num0,
      tools: { type: 'array', items: nonEmpty },
    },
  ),
  // A streamed text delta from the model, in order.
  'agent.token': payload(['runId', 'turn', 'text'], { runId: nonEmpty, turn: int1, text: str }),
  // The model asked for a tool. Exactly one agent.tool_result with the same callId follows.
  'agent.tool_call': payload(['runId', 'turn', 'callId', 'name', 'input'], {
    runId: nonEmpty,
    turn: int1,
    callId: nonEmpty,
    name: nonEmpty,
    input: obj,
  }),
  // The outcome of a tool call. ok=false carries `error`; ok=true carries `output`.
  'agent.tool_result': payload(['runId', 'turn', 'callId', 'name', 'ok'], {
    runId: nonEmpty,
    turn: int1,
    callId: nonEmpty,
    name: nonEmpty,
    ok: bool,
    output: str,
    error: str,
  }),
  // The run finished without a harness error. `reason` says why the loop stopped.
  'agent.run.end': payload(['runId', 'reason', 'turns', 'finalText', 'usage'], {
    runId: nonEmpty,
    reason: { type: 'string', enum: RUN_END_REASONS },
    turns: int0,
    finalText: str,
    usage,
  }),
  // The run stopped because the harness or provider failed. No agent.run.end follows.
  'agent.run.error': payload(['runId', 'turn', 'message'], {
    runId: nonEmpty,
    turn: int0,
    message: str,
    code: str,
  }),
  // Token usage and cost for one turn. `reconciled` is true only when the token counts
  // came from the provider's own usage report AND a price is known for the model (or the
  // provider reported the cost itself; a local model's cost is a known $0). The spend
  // readout sums reconciled events only. `tier` (added v1, optional) says whether the
  // worker or the judge model ran the turn.
  'cost.estimate': payload(
    ['runId', 'turn', 'provider', 'model', 'inputTokens', 'outputTokens', 'usd', 'reconciled'],
    {
      runId: nonEmpty,
      turn: int1,
      provider: nonEmpty,
      model: nonEmpty,
      inputTokens: int0,
      outputTokens: int0,
      usd: { type: ['number', 'null'], minimum: 0 },
      reconciled: bool,
      tier: { type: 'string', enum: ['worker', 'judge'] },
    },
  ),
  // The harness needs the user's yes/no before a tool call proceeds. `leash` (added v1,
  // optional) carries the domain and current leash level the tool falls under.
  'permission.prompt': payload(['promptId', 'runId', 'callId', 'tool', 'reason', 'input'], {
    promptId: nonEmpty,
    runId: nonEmpty,
    callId: nonEmpty,
    tool: nonEmpty,
    reason: str,
    input: obj,
    leash: {
      type: 'object',
      required: ['domain', 'level'],
      additionalProperties: false,
      properties: { domain: nonEmpty, level: { type: 'string', enum: ['observe', 'draft', 'act_capped', 'act_free'] } },
    },
  }),
  // The user's answer to a permission.prompt. Also accepted from the client via the API.
  'permission.response': payload(['promptId', 'runId', 'allow'], {
    promptId: nonEmpty,
    runId: nonEmpty,
    allow: bool,
  }),
  // An object was placed in a room. Placing is a tool grant for every agent in that room.
  'object.place': payload(['objectId', 'kind', 'roomId', 'x', 'y'], {
    objectId: nonEmpty,
    kind: nonEmpty,
    roomId: nonEmpty,
    x: int0,
    y: int0,
  }),
  // An object was removed from a room. The matching grant ends.
  'object.reclaim': payload(['objectId', 'roomId'], { objectId: nonEmpty, roomId: nonEmpty }),
  // Added v1 (additive): a work item was handed from one agent to another along a trail.
  // Phase 1 emits none of these; the park animates the walk between zones from it in phase 2.
  'work.handoff': payload(['fromAgentId', 'toAgentId', 'fromRoomId', 'toRoomId', 'workItemId', 'summary'], {
    fromAgentId: nonEmpty,
    toAgentId: nonEmpty,
    fromRoomId: nonEmpty,
    toRoomId: nonEmpty,
    trailId: str,
    workItemId: nonEmpty,
    summary: str,
  }),
  // Added v1 (additive): the Superintendent re-rolled the park seed.
  'layout.seed': payload(['seed'], { seed: int1 }),
  // Added v1 (additive): the workspace root (an external drive, say) became unreachable.
  // Runs are stopped and no new run starts until workspace.online follows.
  'workspace.offline': payload(['root', 'reason'], { root: nonEmpty, reason: str }),
  'workspace.online': payload(['root'], { root: nonEmpty }),
  // Added v1 (phase 2 step 1): a leash decision at the Entrance Gate. See GATE_ITEM_STATUSES.
  // `summary` is a one-line description of the action; `evidence` carries what the Ranger
  // said and did around it; `amountUsd` is the action's money-out amount when it has one;
  // `level` is the leash level that applied; `proposal` is set on kind 'proposal'.
  'gate.item': payload(['itemId', 'agentId', 'kind', 'domain', 'tool', 'summary', 'status'], {
    itemId: nonEmpty,
    agentId: nonEmpty,
    kind: { type: 'string', enum: GATE_ITEM_KINDS },
    domain: nonEmpty,
    tool: nonEmpty,
    summary: str,
    status: { type: 'string', enum: GATE_ITEM_STATUSES },
    runId: nonEmpty,
    callId: nonEmpty,
    turn: int1,
    level: { type: 'string', enum: LEASH_LEVEL_ENUM },
    amountUsd: num0,
    evidence: { type: 'array', items: { type: 'object', required: ['kind', 'text'], additionalProperties: false, properties: { kind: nonEmpty, text: str, ref: str } } },
    notes: str,
    reason: str,
    proposal: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: { type: 'string', enum: LEASH_LEVEL_ENUM }, to: { type: 'string', enum: LEASH_LEVEL_ENUM } } },
    away: bool,
  }),
  // Added v1 (phase 2 step 2): the judge model reviewed a worker turn. `scope` is 'action'
  // (before the turn's tool calls run) or 'final' (before the run ends). 'skipped' means no
  // judge call was made (cap reached or judge not wired) and says why in `reason`; the
  // action then falls back to Draft for review at the Gate.
  'judge.verdict': payload(['agentId', 'runId', 'turn', 'verdict', 'scope'], {
    agentId: nonEmpty,
    runId: nonEmpty,
    turn: int1,
    verdict: { type: 'string', enum: ['approve', 'revise', 'reject', 'skipped'] },
    scope: { type: 'string', enum: ['action', 'final'] },
    provider: str,
    model: str,
    usd: { type: ['number', 'null'], minimum: 0 },
    reconciled: bool,
    notes: str,
    reason: str,
    tools: { type: 'array', items: nonEmpty },
  }),
  // Added v1 (phase 2 step 4): a delegated work item finished. `status` is done when the
  // receiver's run completed, failed otherwise (error, cancelled, out of turns or budget);
  // `deliverables` are the outbox files (workspace-relative) the run produced.
  'work.done': payload(['workItemId', 'fromAgentId', 'toAgentId', 'runId', 'status', 'deliverables', 'summary'], {
    workItemId: nonEmpty,
    fromAgentId: nonEmpty,
    toAgentId: nonEmpty,
    runId: nonEmpty,
    status: { type: 'string', enum: ['done', 'failed'] },
    reason: str,
    deliverables: { type: 'array', items: str },
    summary: str,
    spentUsd: num0,
  }),
  // Added v1 (phase 2 step 4): a run was accepted but waits for its agent (one run per
  // agent at a time) or for a free slot (global concurrency cap). agent.run.start follows
  // when it begins; agent.run.end { cancelled } if it is cancelled while queued.
  'agent.run.queued': payload(['runId', 'agentId', 'position'], {
    runId: nonEmpty,
    agentId: nonEmpty,
    position: int0,
    workItemId: str,
  }),
  // Added v1 (phase 2 step 5): the Chief Ranger's plan changed. `change` is 'submitted'
  // (a new version from plan.submit), or 'status' (the mission's status moved: planning,
  // active, paused, done, with `reason`). Ventures are summarised; the full plan is in
  // GET /api/mission.
  'plan.updated': payload(['missionId', 'change'], {
    missionId: nonEmpty,
    planId: str,
    version: int0,
    change: { type: 'string', enum: ['submitted', 'status'] },
    status: { type: 'string', enum: ['planning', 'active', 'paused', 'done'] },
    reason: str,
    summary: str,
    by: str,
    runId: str,
    ventures: { type: 'array', items: { type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: nonEmpty, name: nonEmpty, budgetUsd: num0, taskCount: int0, summary: str } } },
  }),
  // Added v1 (phase 2 step 6): spend crossed a budget threshold. `scope` says whose budget
  // (a venture's model spend, the mission's, or the judge's daily cap); `fraction` is
  // spent / budget at the moment of the crossing; emitted once per threshold per scope.
  'budget.threshold': payload(['scope', 'id', 'budgetUsd', 'spentUsd', 'threshold'], {
    scope: { type: 'string', enum: ['venture', 'mission', 'judge'] },
    id: nonEmpty,
    budgetUsd: num0,
    spentUsd: num0,
    threshold: { type: 'number', minimum: 0 },
    fraction: num0,
  }),
  // Added v1 (phase 2 step 6): the Chief Ranger's reflection ran (or could not). A posted
  // reflection names the document, the ventures it covered and the stations briefed.
  'reflection.posted': payload(['reflectionId', 'reason', 'status'], {
    reflectionId: nonEmpty,
    reason: str,
    status: { type: 'string', enum: ['posted', 'skipped'] },
    skipReason: str,
    missionId: str,
    provider: str,
    model: str,
    usd: { type: ['number', 'null'], minimum: 0 },
    reconciled: bool,
    portfolio: str,
    ventures: { type: 'array', items: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: nonEmpty, planStillRight: bool, spentUsd: num0, budgetUsd: num0, itemsDone: int0, itemsFailed: int0 } } },
    briefings: { type: 'array', items: nonEmpty },
    path: str,
  }),
  // Added v1 (phase 2 step 8): the Superintendent left or came back. While away, every
  // Gate item and the other decisions below are appended to the evidence log and the Peak
  // shows "Away since …, N actions, M waiting".
  'away.changed': payload(['away', 'since'], {
    away: bool,
    since: int0,
    actions: int0,
    waiting: int0,
  }),
  // Added v1 (phase 2 step 8): the digest written when the Superintendent returns.
  'away.digest': payload(['digestId', 'since', 'until', 'actions', 'waiting', 'path'], {
    digestId: nonEmpty,
    since: int0,
    until: int0,
    actions: int0,
    waiting: int0,
    spentUsd: num0,
    path: str,
    summary: str,
  }),
  // Added v1 (phase 2 step 3): an agent record was created, changed or removed. `agent` is
  // the layout record as it now stands (absent on 'removed').
  'crew.agent': payload(['agentId', 'change'], {
    agentId: nonEmpty,
    change: { type: 'string', enum: ['created', 'updated', 'removed'] },
    agent: obj,
    by: str,
  }),
  // Added v1 (phase 2 step 1): a run is parked on a pending Gate item; the Ranger waits at
  // the Gate until a gate.item with that itemId leaves 'pending'.
  'agent.waiting': payload(['runId', 'agentId', 'itemId'], {
    runId: nonEmpty,
    agentId: nonEmpty,
    itemId: nonEmpty,
    domain: str,
    tool: str,
  }),
});

export const EVENT_TYPES = deepFreeze(Object.keys(PAYLOAD_SCHEMAS));

export const ENVELOPE_SCHEMA = deepFreeze({
  type: 'object',
  required: ['v', 'id', 'type', 'ts', 'payload'],
  additionalProperties: false,
  properties: {
    v: { const: CONTRACT_VERSION },
    id: nonEmpty,
    type: { type: 'string', enum: EVENT_TYPES },
    ts: int0,
    seq: int0,
    payload: obj,
  },
});

export function isEventType(type) {
  return EVENT_TYPES.includes(type);
}

// Full validation: envelope first, then the payload schema for the event's type.
export function validateEvent(event) {
  const env = validate(ENVELOPE_SCHEMA, event);
  if (!env.ok) return env;
  return validate(PAYLOAD_SCHEMAS[event.type], event.payload);
}

export function assertEvent(event) {
  assertValid(ENVELOPE_SCHEMA, event, 'event envelope');
  assertValid(PAYLOAD_SCHEMAS[event.type], event.payload, `event ${event.type} payload`);
  return event;
}

function defaultId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Builds and validates an event. `ts` and `id` are injectable for deterministic tests.
export function makeEvent(type, payload, { id = defaultId(), ts = Date.now(), seq } = {}) {
  const event = { v: CONTRACT_VERSION, id, type, ts, payload };
  if (seq !== undefined) event.seq = seq;
  return assertEvent(event);
}
