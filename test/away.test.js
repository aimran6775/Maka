import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createAway, digestMarkdown, LOGGED_TYPES } from '../sidecar/away.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { defaultLeash } from '../shared/leash.js';
import { defaultLayout } from '../shared/world.js';
import { makeEvent } from '../shared/events.js';
import { fakeClock } from './helpers/fake-provider.js';

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-away-'));
  const home = path.join(dir, 'home');
  const workspaceRoot = path.join(dir, 'ws');
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock(1_700_000_000_000);
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  let away = null;
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: defaultLayout, clock, isAway: () => Boolean(away && away.state().away) }).init();
  const notified = [];
  away = await createAway({ bus, store, gateQueue, workspaceRoot, clock, notify: async (d) => notified.push(d), log: { error() {} } }).init();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  return { dir, home, workspaceRoot, store, bus, events, clock, gateQueue, away, notified, emit, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('away: evidence log, counters, stamped Gate items, digest on return, persistence across a restart', async () => {
  const h = await setup();
  try {
    assert.deepEqual([...LOGGED_TYPES], ['gate.item', 'work.done', 'plan.updated', 'reflection.posted', 'budget.threshold', 'agent.run.error', 'channel.inbound']);
    assert.equal(h.away.state().away, false);
    await assert.rejects(h.away.set('yes'), /true or false/);
    // Nothing is logged while present.
    await h.gateQueue.log({ agentId: 'ranger', domain: 'publishing', tool: 'social.post', summary: 'post 1', status: 'allowed' });
    await h.away.flushed();
    await assert.rejects(fsp.stat(h.away.logPath));
    assert.equal(h.events.at(-1).payload.away, undefined);

    const on = await h.away.set(true);
    assert.equal(on.state.away, true);
    assert.equal(on.digest, null);
    assert.equal(h.events.at(-1).type, 'away.changed');
    assert.deepEqual((await h.away.set(true)).digest, null, 'idempotent');
    // Decisions while away: logged, stamped, counted.
    await h.gateQueue.log({ agentId: 'ranger', domain: 'publishing', tool: 'social.post', summary: 'post 2', status: 'allowed' });
    const pending = h.gateQueue.submit({ agentId: 'ranger', domain: 'money_out', tool: 'pay.supplier', summary: 'pay $3', runId: 'r1', callId: 'c1', level: 'draft', amountUsd: 3 });
    const waitingId = h.gateQueue.pending()[0].itemId;
    await h.gateQueue.resolve(waitingId, { decision: 'reject', notes: 'not now' });
    await pending;
    h.gateQueue.submit({ agentId: 'scout', domain: 'outbound_messages', tool: 'mail.send', summary: 'reply to a customer', runId: 'r2', callId: 'c2', level: 'draft' });
    h.emit('work.done', { workItemId: 'w1', fromAgentId: 'chief-ranger', toAgentId: 'ranger', runId: 'r1', status: 'done', deliverables: ['outbox/a.md'], summary: 'done' });
    h.emit('work.done', { workItemId: 'w2', fromAgentId: 'chief-ranger', toAgentId: 'ranger', runId: 'r3', status: 'failed', reason: 'error', deliverables: [], summary: 'boom' });
    h.emit('cost.estimate', { runId: 'r1', turn: 1, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, usd: 0.05, reconciled: true });
    h.emit('cost.estimate', { runId: 'r1', turn: 2, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, usd: null, reconciled: false });
    h.emit('plan.updated', { missionId: 'm1', change: 'submitted', planId: 'p1', version: 2, summary: 'revised' });
    h.emit('budget.threshold', { scope: 'venture', id: 'v', budgetUsd: 1, spentUsd: 1, threshold: 1, fraction: 1 });
    h.emit('agent.run.error', { runId: 'r3', turn: 1, message: 'upstream died' });
    h.emit('agent.token', { runId: 'r1', turn: 1, text: 'not logged' });
    await h.away.flushed();
    const st = h.away.state();
    assert.equal(st.actions, 2, 'allowed + rejected; the pending one is not an action yet');
    assert.equal(st.waiting, 1);
    assert.equal(st.spentUsd, 0.05);
    assert.deepEqual([st.workDone, st.workFailed], [1, 1]);
    const stamped = h.events.filter((e) => e.type === 'gate.item' && e.payload.away);
    assert.equal(stamped.length, 4, 'every action item while away is stamped');
    const lines = await h.away.readLog();
    assert.deepEqual(lines.map((l) => l.type), ['gate.item', 'gate.item', 'gate.item', 'gate.item', 'work.done', 'work.done', 'plan.updated', 'budget.threshold', 'agent.run.error']);
    assert.equal(lines[0].payload.summary, 'post 2');
    assert.equal(st.lines, 9);

    // Restart while away: the flag and counters survive (a fresh bus, as a restart would have).
    const again = await createAway({ bus: createEventBus(), store: h.store, gateQueue: h.gateQueue, workspaceRoot: h.workspaceRoot, clock: h.clock }).init();
    assert.equal(again.state().away, true);
    assert.equal(again.state().actions, 2);

    // Return: digest written, emitted, notified.
    const back = await h.away.set(false);
    assert.equal(back.state.away, false);
    const d = back.digest;
    assert.equal(d.actions, 2);
    assert.equal(d.waiting, 1);
    assert.deepEqual(d.byStatus, { allowed: 1, rejected: 1 });
    assert.deepEqual(d.byDomain, { publishing: 1, money_out: 1 });
    assert.deepEqual(d.byAgent, { ranger: 2 });
    assert.equal(d.waitingItems[0].summary, 'reply to a customer');
    assert.deepEqual([d.workDone, d.workFailed, d.spentUsd, d.lines], [1, 1, 0.05, 9]);
    assert.ok(d.notable.some((n) => /plan v2 submitted/.test(n)));
    assert.ok(d.notable.some((n) => /budget: venture v at 100 %/.test(n)));
    assert.ok(d.notable.some((n) => /upstream died/.test(n)));
    const md = await fsp.readFile(path.join(h.workspaceRoot, d.path), 'utf8');
    assert.match(md, /Actions at the Gate: 2 · still waiting on you: 1/);
    assert.match(md, /- \[outbound_messages\] scout: reply to a customer/);
    assert.ok(JSON.parse(await fsp.readFile(path.join(h.workspaceRoot, '_peak', `${d.digestId}.json`), 'utf8')).byStatus.allowed === 1);
    assert.equal(h.events.filter((e) => e.type === 'away.digest').length, 1);
    assert.equal(h.events.at(-1).type, 'away.digest');
    assert.equal(h.notified.length, 1);
    assert.equal(h.away.state().lastDigest.digestId, d.digestId);
    assert.equal(JSON.parse(await fsp.readFile(path.join(h.home, 'away.json'), 'utf8')).away, false);
    // After the return nothing more is logged.
    await h.gateQueue.log({ agentId: 'ranger', domain: 'publishing', tool: 'social.post', summary: 'post 3', status: 'allowed' });
    await h.away.flushed();
    assert.equal((await h.away.readLog()).length, 9);
    assert.match(digestMarkdown(d), /Evidence log: _peak\/away-log.ndjson/);
  } finally {
    await h.cleanup();
  }
});
