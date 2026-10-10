import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION, EVENT_TYPES, PAYLOAD_SCHEMAS, ENVELOPE_SCHEMA, RUN_END_REASONS,
  validateEvent, assertEvent, makeEvent, isEventType,
} from '../shared/events.js';

const SAMPLES = {
  'agent.run.start': { runId: 'r1', agentId: 'a1', provider: 'fake', model: 'm', prompt: 'hi', maxTurns: 4, budgetUsd: 1, tools: ['fs.read'] },
  'agent.token': { runId: 'r1', turn: 1, text: 'hel' },
  'agent.tool_call': { runId: 'r1', turn: 1, callId: 'c1', name: 'fs.read', input: { path: 'a.txt' } },
  'agent.tool_result': { runId: 'r1', turn: 1, callId: 'c1', name: 'fs.read', ok: true, output: 'x' },
  'agent.run.end': { runId: 'r1', reason: 'completed', turns: 1, finalText: 'done', usage: { inputTokens: 1, outputTokens: 2 } },
  'agent.run.error': { runId: 'r1', turn: 1, message: 'boom', code: 'PROVIDER' },
  'cost.estimate': { runId: 'r1', turn: 1, provider: 'fake', model: 'm', inputTokens: 1, outputTokens: 2, usd: 0.001, reconciled: true },
  'permission.prompt': { promptId: 'p1', runId: 'r1', callId: 'c1', tool: 'fs.write', reason: 'writes a file', input: { path: 'a' } },
  'permission.response': { promptId: 'p1', runId: 'r1', allow: true },
  'object.place': { objectId: 'o1', kind: 'trailhead_sign', roomId: 'room-1', x: 2, y: 3 },
  'object.reclaim': { objectId: 'o1', roomId: 'room-1' },
  'work.handoff': { fromAgentId: 'chief', toAgentId: 'ranger', fromRoomId: 'ranger-station', toRoomId: 'camp', trailId: 't1', workItemId: 'w1', summary: 'draft listings' },
  'layout.seed': { seed: 42 },
  'workspace.offline': { root: '/Volumes/LaCie/Maka/workspace', reason: 'ENOENT' },
  'workspace.online': { root: '/Volumes/LaCie/Maka/workspace' },
  'gate.item': { itemId: 'g1', agentId: 'ranger', kind: 'action', domain: 'money_out', tool: 'pay.supplier', summary: 'pay $12', status: 'pending', runId: 'r1', callId: 'c1', turn: 2, level: 'draft', amountUsd: 12, evidence: [{ kind: 'said', text: 'ordering stock', ref: 'r1' }], reason: 'leash is draft' },
  'agent.waiting': { runId: 'r1', agentId: 'ranger', itemId: 'g1', domain: 'money_out', tool: 'pay.supplier' },
  'work.done': { workItemId: 'w1', fromAgentId: 'chief', toAgentId: 'ranger', runId: 'r1', status: 'done', reason: 'completed', deliverables: ['outbox/brief.md'], summary: 'wrote the brief', spentUsd: 0 },
  'agent.run.queued': { runId: 'r2', agentId: 'ranger', position: 0, workItemId: 'w1' },
  'plan.updated': { missionId: 'mission-1', planId: 'plan-1', version: 2, change: 'submitted', status: 'active', summary: 'two ventures', by: 'chief-ranger', runId: 'r1', ventures: [{ id: 'lantern-co', name: 'Lantern Co', budgetUsd: 3, taskCount: 4, summary: 'lanterns' }] },
  'budget.threshold': { scope: 'venture', id: 'lantern-co', budgetUsd: 3, spentUsd: 2.5, threshold: 0.8, fraction: 0.8333 },
  'reflection.posted': { reflectionId: 'reflection-2026-10-10-abc123', reason: 'scheduled', status: 'posted', missionId: 'mission-1', provider: 'anthropic', model: 'claude-opus-5-5', usd: 0.02, reconciled: true, portfolio: 'On track.', ventures: [{ id: 'lantern-co', planStillRight: true, spentUsd: 2.5, budgetUsd: 3, itemsDone: 2, itemsFailed: 0 }], briefings: ['research'], path: 'chief-ranger/outbox/reflection.md' },
  'mail.message': { messageId: 'msg-1', threadId: 'thread-1', direction: 'in', from: 'Customer <c@example.com>', to: ['support@makapark.com'], subject: 'Order 12', station: 'operations-support', venture: 'lantern-co', kind: 'inbound', resendId: 'rcv_1', attachments: 1 },
  'mail.event': { resendId: 'em_1', messageId: 'msg-2', event: 'bounced', address: 'gone@example.com', detail: 'Permanent Suppressed', suppressed: true },
  'mail.address': { address: 'sales-lantern-co@makapark.com', change: 'created', kind: 'alias', station: 'sales', agentId: 'ben-1', venture: 'lantern-co', by: 'chief-ranger' },
  'mail.classified': { messageId: 'msg-1', classification: 'customer', by: 'worker', confidence: 0.92, reason: 'asks about an order' },
  'mail.dns': { domain: 'makapark.com', change: 'applied', itemId: 'gate-1', create: 4, update: 1, remove: 0, unchanged: 2, errors: [], message: '5 change(s) written' },
  'away.changed': { away: true, since: 1700000000000, actions: 0, waiting: 2 },
  'away.digest': { digestId: 'digest-1', since: 1700000000000, until: 1700003600000, actions: 4, waiting: 1, spentUsd: 0.12, path: '_peak/digest-1.md', summary: '4 actions' },
  'crew.agent': { agentId: 'scout-1', change: 'created', agent: { id: 'scout-1', name: 'Scout', roomId: 'research', x: 1, y: 1, role: 'ranger' }, by: 'chief-ranger' },
  'judge.verdict': { agentId: 'ranger', runId: 'r1', turn: 2, verdict: 'revise', scope: 'action', provider: 'anthropic', model: 'claude-sonnet-5-5', usd: 0.004, reconciled: true, notes: 'quote first', tools: ['pay.supplier'] },
};

test('the contract lists exactly the known events and is frozen', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), Object.keys(SAMPLES).sort());
  assert.equal(Object.isFrozen(PAYLOAD_SCHEMAS), true);
  assert.equal(Object.isFrozen(PAYLOAD_SCHEMAS['agent.token'].properties), true);
  assert.equal(Object.isFrozen(ENVELOPE_SCHEMA), true);
  assert.equal(Object.isFrozen(RUN_END_REASONS), true);
  assert.equal(CONTRACT_VERSION, 1);
  assert.equal(isEventType('agent.token'), true);
  assert.equal(isEventType('agent.nope'), false);
});

test('every sample payload validates and round-trips through JSON', () => {
  let ts = 1000;
  for (const [type, payload] of Object.entries(SAMPLES)) {
    const ev = makeEvent(type, payload, { id: `id-${type}`, ts: ts++, seq: 7 });
    assert.equal(ev.v, CONTRACT_VERSION);
    assert.equal(ev.seq, 7);
    const back = JSON.parse(JSON.stringify(ev));
    assert.equal(validateEvent(back).ok, true, type);
    assert.deepEqual(back, ev);
  }
});

test('makeEvent fills id and ts when not supplied', () => {
  const ev = makeEvent('agent.token', SAMPLES['agent.token']);
  assert.equal(typeof ev.id, 'string');
  assert.ok(ev.id.length > 0);
  assert.equal(Number.isInteger(ev.ts), true);
  assert.equal('seq' in ev, false);
});

test('envelope rejects unknown types, wrong version, extra keys', () => {
  const good = makeEvent('agent.token', SAMPLES['agent.token'], { id: 'x', ts: 1 });
  assert.equal(validateEvent({ ...good, type: 'agent.unknown' }).ok, false);
  assert.equal(validateEvent({ ...good, v: 2 }).ok, false);
  assert.equal(validateEvent({ ...good, extra: 1 }).ok, false);
  assert.equal(validateEvent({ ...good, ts: -1 }).ok, false);
  assert.equal(validateEvent({ ...good, id: '' }).ok, false);
  assert.equal(validateEvent(null).ok, false);
});

test('payloads reject missing required fields, unknown fields and bad enums', () => {
  const bad = (type, payload) => {
    const r = validate_(type, payload);
    assert.equal(r.ok, false, `${type} should reject ${JSON.stringify(payload)}`);
    return r;
  };
  const validate_ = (type, payload) => validateEvent({ v: 1, id: 'x', type, ts: 1, payload });
  bad('agent.token', { runId: 'r1', turn: 0, text: 'x' });
  bad('agent.token', { runId: 'r1', turn: 1 });
  bad('agent.token', { runId: 'r1', turn: 1, text: 'x', surprise: true });
  bad('agent.run.end', { ...SAMPLES['agent.run.end'], reason: 'gave_up' });
  bad('agent.run.end', { ...SAMPLES['agent.run.end'], usage: { inputTokens: 1 } });
  bad('cost.estimate', { ...SAMPLES['cost.estimate'], usd: -1 });
  bad('cost.estimate', { ...SAMPLES['cost.estimate'], usd: 'free' });
  bad('object.place', { ...SAMPLES['object.place'], x: 1.5 });
  bad('permission.response', { promptId: 'p', runId: 'r', allow: 'yes' });
  bad('agent.tool_call', { ...SAMPLES['agent.tool_call'], input: 'string' });
  bad('gate.item', { ...SAMPLES['gate.item'], status: 'maybe' });
  bad('gate.item', { ...SAMPLES['gate.item'], kind: 'wish' });
  bad('gate.item', { ...SAMPLES['gate.item'], evidence: [{ text: 'no kind' }] });
  bad('agent.waiting', { runId: 'r1', agentId: 'a' });
  bad('judge.verdict', { ...SAMPLES['judge.verdict'], verdict: 'shrug' });
  bad('crew.agent', { agentId: 'x', change: 'cloned' });
  bad('plan.updated', { missionId: 'm', change: 'dreamt' });
  bad('budget.threshold', { scope: 'galaxy', id: 'x', budgetUsd: 1, spentUsd: 1, threshold: 1 });
  bad('away.changed', { away: 'yes', since: 1 });
  bad('mail.dns', { domain: 'makapark.com', change: 'dreamt' });
  bad('mail.message', { ...SAMPLES['mail.message'], direction: 'sideways' });
  bad('mail.event', { resendId: 'x', event: 'vanished' });
  bad('mail.address', { address: 'a@b', change: 'created', kind: 'royal', station: 's' });
  bad('mail.classified', { messageId: 'm', classification: 'royalty', by: 'worker' });
  assert.equal(validate_('cost.estimate', { ...SAMPLES['cost.estimate'], tier: 'hosted_worker' }).ok, true);
  bad('away.digest', { digestId: 'd', since: 1, until: 2, actions: 1, waiting: 0 });
  bad('reflection.posted', { reflectionId: 'r', reason: 'x', status: 'dreamt' });
  assert.equal(validate_('reflection.posted', { reflectionId: 'r', reason: 'manual', status: 'skipped', skipReason: 'cap', usd: null, reconciled: false }).ok, true);
  bad('plan.updated', { missionId: 'm', change: 'submitted', ventures: [{ id: 'v' }] });
  bad('work.done', { ...SAMPLES['work.done'], status: 'maybe' });
  bad('agent.run.queued', { runId: 'r', agentId: 'a', position: -1 });
  assert.equal(validate_('judge.verdict', { agentId: 'a', runId: 'r', turn: 1, verdict: 'skipped', scope: 'final', reason: 'cap', usd: null, reconciled: false }).ok, true);
  assert.equal(validate_('gate.item', { itemId: 'g2', agentId: 'ranger', kind: 'proposal', domain: 'publishing', tool: 'leash.loosen', summary: 'loosen?', status: 'pending', proposal: { from: 'draft', to: 'act_capped' } }).ok, true);
  assert.equal(validate_('cost.estimate', { ...SAMPLES['cost.estimate'], usd: null, reconciled: false }).ok, true);
  assert.throws(() => assertEvent({ v: 1, id: 'x', type: 'agent.token', ts: 1, payload: {} }), /agent\.token payload failed validation/);
  assert.throws(() => makeEvent('nope', {}), /envelope failed validation/);
});
