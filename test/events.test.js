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
  'connector.sync': { connector: 'stripe', status: 'done', reason: 'scheduled', counts: { charges: 3 }, ms: 120 },
  'connector.error': { connector: 'stripe', stage: 'sync', message: 'HTTP 401', code: 'HTTP_401' },
  'connector.status': { connector: 'shopify', change: 'authorizing', connected: false, auth: 'oauth2', by: 'superintendent', authorizeUrl: 'https://example/authorize?x' },
  'ollama.pull': { model: 'qwen2.5:7b', status: 'pulling manifest', completed: 1024, total: 4096, done: false },
  'setup.changed': { step: 'workspace', change: 'done', detail: '/Volumes/LaCie/Maka/workspace' },
  'backup.snapshot': { status: 'done', reason: 'scheduled', key: 'maka/mac/2026-10-10T03-00-00Z.tar.gz.enc', files: 12, bytes: 4096 },
  'backup.restore': { status: 'done', key: 'maka/mac/2026-10-10T03-00-00Z.tar.gz.enc', into: '/ws/_restore/2026', files: 12 },
  'mcp.server': { server: 'github', status: 'connected', transport: 'stdio', tools: 12 },
  'channel.inbound': { channel: 'telegram', chatId: '12345', userId: '777', action: 'gate', paired: true, outcome: 'accepted', itemId: 'gate-1', decision: 'approve', messageId: '42' },
  'channel.connect': { channel: 'telegram', status: 'up', message: 'long polling as @maka_bot', by: 'env' },
  'channel.delivery': { channel: 'telegram', chatId: '12345', kind: 'gate_card', status: 'sent', itemId: 'gate-1', messageId: '43' },
  'voice.transcript': { via: 'huggingface', chars: 34, accepted: false, bytes: 48000, ms: 820, model: 'openai/whisper-large-v3' },
  'computer.action': { agentId: 'ranger', action: 'click', status: 'done', runId: 'run-1', app: 'Safari (com.apple.Safari)', before: 'ranger/computer-trace/1-click-before.png', after: 'ranger/computer-trace/2-click-after.png', ms: 120 },
  'computer.handoff': { handoffId: 'chand-1', agentId: 'ranger', status: 'waiting', kind: 'sensitive_app', runId: 'run-1', app: 'Terminal (com.apple.Terminal)', action: 'type', reason: 'Terminal is on the list of apps a Ranger never drives' },
  'purchase.update': { purchaseId: 'buy-1', status: 'paid', venture: 'lantern-co', amountUsd: 42, currency: 'USD', supplierHost: 'supplier.example', workItemId: 'work-1', agentId: 'driver', runId: 'run-2', by: 'superintendent', paidUsd: 42.5, receiptPath: 'outbox/purchases/buy-1.json', reconciliation: 'no_source' },
  'recipe.run': { recipeRunId: 'recipe-run-1', recipeId: 'launch-etsy-listing', version: 1, status: 'step', by: 'superintendent', ventureId: 'lantern-co', stepId: 'copy', workItemId: 'work-1', agentId: 'sam', steps: 6, done: 1 },
  'memory.recall': { agentId: 'a1', runId: 'r1', query: 'etsy fees', count: 1, itemIds: ['mem-1'], automatic: true, turn: 0 },
  'memory.write': { memoryId: 'mem-1', agentId: 'a1', scope: 'venture', owner: 'lantern-co', kind: 'fact', status: 'stored', redactions: 1, runId: 'r1', verdict: 'approve', text: 'Etsy charges $0.20 per listing' },
  'memory.forget': { memoryId: 'mem-1', agentId: 'a1', scope: 'venture', owner: 'lantern-co', by: 'superintendent' },
  'memory.feedback': { memoryId: 'mem-1', agentId: 'a1', vote: 'down', by: 'superintendent', up: 0, down: 1, muted: true },
  'scout.brief': { briefId: 'brief-2026-10-11-abc', change: 'decided', agentId: 'scout-1', title: 'Garden lanterns', recommendation: 'go', decision: 'go', ventureId: 'lantern-co', niche: 'garden lanterns', channel: 'etsy', by: 'chief-ranger' },
  'results.rollup': { day: '2026-10-11', reason: 'sync', park: { revenue: 120.5, refunds: 10, fees: null, adSpend: 24, orders: 3, modelSpend: 0.12, mailIn: 2, mailOut: 1, contributionPerOrder: 28.83, modelCostPerOrder: 0.04 }, ventures: [{ id: 'lantern-co', revenue: null, refunds: null, fees: null, adSpend: null, orders: null, modelSpend: 0.12, mailIn: 0, mailOut: 0, contributionPerOrder: null, modelCostPerOrder: null }], proposals: [{ venture: 'lantern-co', verdict: 'no_data', because: ['no connector has synced'] }] },
  'browser.handoff': { handoffId: 'hand-1', agentId: 'ranger-1', status: 'waiting', kind: 'login', runId: 'run-1', url: 'https://shop.example/login', title: 'Sign in', reason: 'the page asks for a password', headless: false },
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
  bad('ollama.pull', { model: 'm', status: 's', done: 'yes' });
  bad('ollama.pull', { model: 'm', status: 's', done: true, completed: -1 });
  bad('setup.changed', { step: 'coffee', change: 'done' });
  bad('backup.snapshot', { status: 'done' });
  bad('backup.restore', { status: 'done', key: '' });
  bad('mcp.server', { server: 'github', status: 'sleeping' });
  bad('channel.inbound', { channel: 'telegram', chatId: '1', userId: '2', action: 'wave', paired: true, outcome: 'x' });
  bad('channel.connect', { channel: 'telegram', status: 'maybe' });
  bad('channel.delivery', { channel: 'telegram', chatId: '1', kind: 'gate_card', status: 'queued' });
  bad('results.rollup', { day: '2026-10-11', reason: 'sync', park: { revenue: 'none' }, ventures: [] });
  bad('scout.brief', { briefId: 'b', change: 'scored' });
  bad('memory.write', { agentId: 'a1', scope: 'global', owner: 'x', kind: 'fact', status: 'stored' });
  bad('recipe.run', { recipeRunId: 'r', recipeId: 'x', version: 1, status: 'paused', by: 'me' });
  bad('purchase.update', { purchaseId: 'b', status: 'shipped', venture: 'v', amountUsd: 1 });
  bad('computer.action', { agentId: 'r', action: 'format', status: 'done' });
  bad('computer.action', { agentId: 'r', action: 'click', status: 'maybe' });
  bad('computer.handoff', { handoffId: 'h', agentId: 'r', status: 'waiting', kind: 'login' });
  bad('purchase.update', { purchaseId: 'b', status: 'paid', venture: 'v', amountUsd: -1 });
  bad('purchase.update', { purchaseId: 'b', status: 'paid', venture: 'v', amountUsd: 1, reconciliation: 'maybe' });
  bad('voice.transcript', { via: 'phone', chars: 1, accepted: false });
  bad('voice.transcript', { via: 'shell', chars: 1, accepted: false, text: 'never the words' });
  bad('memory.feedback', { memoryId: 'm', vote: 'meh', by: 'x', up: 0, down: 0 });
  bad('results.rollup', { day: '2026-10-11', reason: 'sync', park: {}, ventures: [], proposals: [{ venture: 'v', verdict: 'maybe', because: [] }] });
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
