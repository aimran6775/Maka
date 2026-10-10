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
};

test('the contract lists exactly the phase 1 events and is frozen', () => {
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
  assert.equal(validate_('cost.estimate', { ...SAMPLES['cost.estimate'], usd: null, reconciled: false }).ok, true);
  assert.throws(() => assertEvent({ v: 1, id: 'x', type: 'agent.token', ts: 1, payload: {} }), /agent\.token payload failed validation/);
  assert.throws(() => makeEvent('nope', {}), /envelope failed validation/);
});
