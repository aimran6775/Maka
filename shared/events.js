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

const money = { type: ['number', 'null'] };
// One day's figures for the park or a venture (phase 4 step 9). Nulls are "no data".
const resultsRow = {
  type: 'object',
  additionalProperties: false,
  properties: { revenue: money, refunds: money, fees: money, adSpend: money, orders: { type: ['integer', 'null'], minimum: 0 }, modelSpend: num0, mailIn: int0, mailOut: int0, contributionPerOrder: money, modelCostPerOrder: money },
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
      tier: { type: 'string', enum: ['worker', 'judge', 'hosted_worker'] },
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
    server: nonEmpty, // phase 4 step 4 (optional): the MCP server an Outpost grants
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
    mailed: int0, // phase 4 step 6 (optional): briefings delivered into station mail
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
  // Added v1 (phase 2 step 9): the mail domain's DNS at Cloudflare. 'planned' carries the
  // dry-run diff counts; 'applied' what was written; 'failed' why not.
  'mail.dns': payload(['domain', 'change'], {
    domain: nonEmpty,
    change: { type: 'string', enum: ['planned', 'applied', 'failed'] },
    itemId: str,
    create: int0,
    update: int0,
    remove: int0,
    unchanged: int0,
    errors: { type: 'array', items: str },
    message: str,
  }),
  // Added v1 (phase 2 step 10): a mail message entered the local store, inbound (received
  // through Resend) or outbound (sent through Resend). Bodies stay in the store.
  'mail.message': payload(['messageId', 'threadId', 'direction', 'from', 'to', 'subject', 'station'], {
    messageId: nonEmpty,
    threadId: nonEmpty,
    direction: { type: 'string', enum: ['in', 'out'] },
    from: str,
    to: { type: 'array', items: str },
    subject: str,
    station: nonEmpty,
    venture: str,
    agentId: str,
    kind: str,
    resendId: str,
    attachments: int0,
    classification: str,
  }),
  // Added v1 (phase 2 step 10): a delivery lifecycle event for a sent message (from
  // Resend's webhooks or a status poll). A bounce or complaint suppresses the address.
  'mail.event': payload(['resendId', 'event'], {
    resendId: nonEmpty,
    messageId: str,
    event: { type: 'string', enum: ['sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'suppressed'] },
    address: str,
    detail: str,
    suppressed: bool,
  }),
  // Added v1 (phase 2 step 10): an address routing rule was created or removed.
  'mail.address': payload(['address', 'change', 'kind', 'station'], {
    address: nonEmpty,
    change: { type: 'string', enum: ['created', 'removed'] },
    kind: { type: 'string', enum: ['station', 'alias', 'system'] },
    station: nonEmpty,
    agentId: str,
    venture: str,
    by: str,
  }),
  // Added v1 (phase 2 step 12): an inbound message was classified by the worker model (or
  // the judge when the worker was unsure). `by` names the tier; 'none' when no model was
  // reachable and the message stays unclassified.
  'mail.classified': payload(['messageId', 'classification', 'by'], {
    messageId: nonEmpty,
    classification: { type: 'string', enum: ['customer', 'supplier', 'platform_notice', 'spam', 'unclassified'] },
    by: { type: 'string', enum: ['worker', 'judge', 'hosted_worker', 'none'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: str,
  }),
  // Added v1 (phase 2 step 3): an agent record was created, changed or removed. `agent` is
  // the layout record as it now stands (absent on 'removed').
  'crew.agent': payload(['agentId', 'change'], {
    agentId: nonEmpty,
    change: { type: 'string', enum: ['created', 'updated', 'removed'] },
    agent: obj,
    by: str,
  }),
  // Added v1 (phase 2 step 13): BROWSER HANDOFF. A Ranger's browser reached a page that
  // needs a human (login, one-time code, captcha, payment): 'waiting' while the window is
  // the Superintendent's, 'returned' when handed back, 'abandoned' when the run ended first.
  'browser.handoff': payload(['handoffId', 'agentId', 'status', 'kind'], {
    handoffId: nonEmpty,
    agentId: nonEmpty,
    status: { type: 'string', enum: ['waiting', 'returned', 'abandoned'] },
    kind: { type: 'string', enum: ['login', 'two_factor', 'captcha', 'payment'] },
    runId: str,
    url: str,
    title: str,
    reason: str,
    notes: str,
    headless: bool,
  }),
  // Added v1 (phase 2 step 14): a connector sync started / finished / failed / was skipped.
  // `counts` are what the sync brought in (per the connector); nothing is estimated.
  'connector.sync': payload(['connector', 'status'], {
    connector: nonEmpty,
    status: { type: 'string', enum: ['started', 'done', 'failed', 'skipped'] },
    reason: str,
    counts: obj,
    ms: int0,
    message: str,
  }),
  // Added v1 (phase 2 step 14): a connector failed at a stage (connect / auth / sync / action).
  'connector.error': payload(['connector', 'stage', 'message'], {
    connector: nonEmpty,
    stage: { type: 'string', enum: ['connect', 'auth', 'sync', 'action'] },
    message: str,
    code: str,
  }),
  // Added v1 (phase 2 step 14): a connector was connected / disconnected, or an OAuth
  // sign-in is waiting for the Superintendent to open `authorizeUrl`.
  'connector.status': payload(['connector', 'change', 'connected'], {
    connector: nonEmpty,
    change: { type: 'string', enum: ['connected', 'disconnected', 'authorizing'] },
    connected: bool,
    auth: str,
    by: str,
    authorizeUrl: str,
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
  // Added v1 (phase 3 step 3): a local worker model being pulled by Ollama. `completed`
  // and `total` are the bytes Ollama reported for the current layer / the whole pull as
  // it reports them; `done` is true on success or failure (then `error` says why). The
  // UI draws only these numbers.
  'ollama.pull': payload(['model', 'status', 'done'], {
    model: nonEmpty,
    status: str,
    completed: int0,
    total: int0,
    done: bool,
    error: str,
  }),
  // Added v1 (phase 3 step 3): the first-run flow changed (a step done, or the whole
  // setup completed or skipped), so every client re-reads /api/setup.
  'setup.changed': payload(['step', 'change'], {
    step: { type: 'string', enum: ['workspace', 'judge', 'worker', 'mission', 'all'] },
    change: { type: 'string', enum: ['done', 'completed', 'skipped', 'restarting'] },
    detail: str,
  }),
  // Added v1 (phase 3 step 5): an offsite snapshot to R2 started / done / failed /
  // skipped (not wired, no key, disabled), with the object key, the files and bytes it
  // carried, and the reason it ran (scheduled, missed, manual).
  'backup.snapshot': payload(['status', 'reason'], {
    status: { type: 'string', enum: ['started', 'done', 'failed', 'skipped'] },
    reason: nonEmpty,
    key: str,
    files: int0,
    bytes: int0,
    error: str,
  }),
  // Added v1 (phase 3 step 5): a snapshot restored from R2 into a fresh directory (never
  // over live data), or verified (opened and listed without writing).
  'backup.restore': payload(['status', 'key'], {
    status: { type: 'string', enum: ['done', 'failed', 'verified'] },
    key: nonEmpty,
    into: str,
    files: int0,
    error: str,
  }),
  // Added v1 (phase 4 step 4): an MCP server's state. 'configured' when its record was
  // written (added, or a leash mapping changed), 'connected' with its tool count,
  // 'needs_auth' when it answered 401, 'authorizing' with the sign-in URL, 'disconnected',
  // 'error' with the message, 'refused' when the Gate declined, 'removed'.
  'mcp.server': payload(['server', 'status'], {
    server: nonEmpty,
    status: { type: 'string', enum: ['configured', 'connected', 'needs_auth', 'authorizing', 'disconnected', 'error', 'refused', 'removed'] },
    transport: { type: 'string', enum: ['stdio', 'http'] },
    tools: int0,
    message: str,
    authorizeUrl: str,
  }),
  // Added v1 (phase 4 step 1): a message arrived on an owner channel (Telegram, Discord,
  // Slack). `action` is what Maka made of it: 'pair' (the pairing code), 'gate' (a decision
  // on a Gate item, with `itemId` and `decision`), 'notes' (the revise notes that followed),
  // 'ask' (free text for the Peak), 'command' (a slash command), 'ignored'. `paired` says
  // whether the chat was a paired owner chat at the time; `outcome` says what happened
  // (accepted, refused: not paired, refused: unknown item, …). Message text stays out of
  // the event beyond a bounded preview.
  'channel.inbound': payload(['channel', 'chatId', 'userId', 'action', 'paired', 'outcome'], {
    channel: nonEmpty,
    chatId: nonEmpty,
    userId: nonEmpty,
    action: { type: 'string', enum: ['pair', 'gate', 'notes', 'ask', 'command', 'ignored'] },
    paired: bool,
    outcome: nonEmpty,
    text: str,
    itemId: str,
    decision: { type: 'string', enum: ['approve', 'revise', 'reject'] },
    messageId: str,
    runId: str,
  }),
  // Added v1 (phase 4 step 1): a channel adapter came up, went down or failed. `by` says
  // where the bot token came from (env, keystore) or who stopped it.
  'channel.connect': payload(['channel', 'status'], {
    channel: nonEmpty,
    status: { type: 'string', enum: ['up', 'down', 'error', 'not_wired'] },
    message: str,
    by: str,
  }),
  // Added v1 (phase 4 step 1): something Maka sent to an owner chat: a Gate card, a
  // reflection, an away digest, an answer from the Peak, a plain notice. `status` is what
  // the platform answered; nothing is marked sent that the platform did not accept.
  'channel.delivery': payload(['channel', 'chatId', 'kind', 'status'], {
    channel: nonEmpty,
    chatId: nonEmpty,
    kind: { type: 'string', enum: ['gate_card', 'gate_update', 'reflection', 'digest', 'answer', 'notice', 'pairing'] },
    status: { type: 'string', enum: ['sent', 'failed'] },
    itemId: str,
    messageId: str,
    error: str,
    ref: str,
  }),
  // Added v1 (phase 4 step 11): Ranger memory. `memory.recall` is a lookup (a tool call, or
  // the automatic recall into a run's context); `memory.write` a proposed item stored after
  // the judge accepted it or refused with the reason (secrets and personal data are counted
  // as `redactions`, never carried); `memory.forget` a removal; `memory.feedback` the
  // Superintendent's 👍 / 👎 with the running counts.
  'memory.recall': payload(['agentId', 'query', 'count', 'itemIds', 'automatic'], {
    agentId: nonEmpty,
    runId: str,
    query: str,
    count: int0,
    itemIds: { type: 'array', items: nonEmpty },
    automatic: bool,
    turn: int0,
  }),
  'memory.write': payload(['agentId', 'scope', 'owner', 'kind', 'status'], {
    memoryId: str,
    agentId: nonEmpty,
    scope: { type: 'string', enum: ['agent', 'venture', 'station'] },
    owner: nonEmpty,
    kind: { type: 'string', enum: ['fact', 'preference', 'procedure'] },
    status: { type: 'string', enum: ['stored', 'refused'] },
    reason: str,
    verdict: str,
    redactions: int0,
    runId: str,
    text: str,
  }),
  'memory.forget': payload(['memoryId', 'by'], { memoryId: nonEmpty, agentId: str, scope: str, owner: str, by: nonEmpty }),
  'memory.feedback': payload(['memoryId', 'vote', 'by', 'up', 'down'], { memoryId: nonEmpty, agentId: str, vote: { type: 'string', enum: ['up', 'down'] }, by: nonEmpty, up: int0, down: int0, muted: bool }),
  // Added v1 (phase 4 step 10): a venture brief entered the Scout's memory (recorded by
  // brief.submit) or the Chief decided on it (brief.decide); niche and channel are what the
  // brief declared, `estimates` how many checkable figures it gave.
  'scout.brief': payload(['briefId', 'change'], {
    briefId: nonEmpty,
    change: { type: 'string', enum: ['recorded', 'decided'] },
    agentId: str,
    title: str,
    recommendation: { type: 'string', enum: ['go', 'no_go', 'needs_more_evidence'] },
    decision: { type: 'string', enum: ['go', 'no_go', 'needs_more_evidence'] },
    ventureId: str,
    niche: str,
    channel: str,
    estimates: int0,
    by: str,
  }),
  // Added v1 (phase 4 step 9): the results engine rolled a day up from real ledgers and
  // connector syncs. Every money figure is a number only when a source proved it and null
  // when no source has it ("no data", never zero). `proposals` are the Chief rules'
  // scale / hold / kill / no_data verdicts with the numbers that drove them.
  'results.rollup': payload(['day', 'reason', 'park', 'ventures'], {
    day: nonEmpty,
    reason: nonEmpty,
    park: resultsRow,
    ventures: { type: 'array', items: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: nonEmpty, ...resultsRow.properties } } },
    proposals: { type: 'array', items: { type: 'object', required: ['venture', 'verdict', 'because'], additionalProperties: false, properties: { venture: nonEmpty, verdict: { type: 'string', enum: ['scale', 'hold', 'kill', 'no_data'] }, because: { type: 'array', items: str } } } },
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
