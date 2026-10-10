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
