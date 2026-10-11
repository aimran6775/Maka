// Computer control (phase 4 step 18): the policy (sensitive apps, chords, the locate
// matcher, the wire format), the Control desk and the computer_control domain (Observe by
// default, never at the Peak), the control over a fake shell on the broker socket (not
// wired without it, every action through the leash and the Gate, the frontmost app checked
// first, screenshots before and after, the trace, the events, the session and its banner,
// sensitive apps handing off and never driven, the halt and the resume), and the HTTP routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { createComputerControl, TRACE_DIR } from '../sidecar/computer/control.js';
import { COMPUTER_TOOL_NAMES, SENSITIVE_APPS, isSensitiveApp, parseChord, locateMatches, encodeRequest, decodeReply, HALT_HOTKEY } from '../sidecar/computer/policy.js';
import { needsActionReview } from '../sidecar/judge.js';
import { defaultLayout, allGrantsFor, OBJECT_KINDS, PEAK_REFUSED_KINDS, peakConnectorProblem } from '../shared/world.js';
import { defaultLeash, DOMAINS, TOOL_DOMAINS } from '../shared/leash.js';
import { makeEvent } from '../shared/events.js';
import { startFakeShell, TINY_PNG } from './helpers/fake-shell.js';
import { startTestServer } from './helpers/test-server.js';

const waitUntil = async (fn, { tries = 200, ms = 10 } = {}) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error('condition not met');
};

function layoutWithDesk() {
  const layout = defaultLayout();
  layout.objects.push({ id: 'desk', kind: 'control_desk', roomId: 'ranger-station', x: 2, y: 2 });
  return layout;
}

async function harness({ shell = null, leashLevel = 'observe', capActions = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-computer-'));
  const store = createStore({ root: path.join(dir, 'home') });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  let t = Date.UTC(2026, 9, 11, 10);
  const clock = { now: () => (t += 1) };
  const layoutState = createLayoutState({ initial: layoutWithDesk(), store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leash = defaultLeash();
  leash.domains.computer_control = capActions === null ? { level: leashLevel } : { level: leashLevel, dailyCapActions: capActions };
  const leashState = createLeashState({ initial: leash, store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const workspaceRoot = path.join(dir, 'ws');
  await fsp.mkdir(path.join(workspaceRoot, 'ranger'), { recursive: true });
  const computer = await createComputerControl({ bus, env: shell ? shell.env : {}, workspaceRoot, clock, log: { error() {} } }).init();
  const registry = { ...computer.tools };
  const gateFor = (agentId, { runId = 'run-1', signal } = {}) => ({
    gate: createToolGate({ getLayout: layoutState.get, agentId, workspaceDir: path.join(workspaceRoot, agentId), registry, grants: allGrantsFor, toolContext: {}, getLeash: () => leashState.get(), ledger, submit: { submit: (item) => gateQueue.submit({ ...item, runId, agentId }), log: (item) => gateQueue.log({ ...item, runId, agentId }) } }),
    ctx: { runId, signal, turn: 1 },
  });
  const ofType = (type) => events.filter((e) => e.type === type).map((e) => e.payload);
  return { dir, bus, events, ofType, clock, ledger, leashState, gateQueue, workspaceRoot, computer, gateFor, cleanup: async () => { await computer.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('policy: the sensitive list, key chords, the locate matcher and the wire format', () => {
  assert.equal(isSensitiveApp({ bundleId: 'com.apple.systempreferences', name: 'System Settings' }).sensitive, true);
  assert.equal(isSensitiveApp({ bundleId: 'com.apple.Terminal', name: 'Terminal' }).sensitive, true);
  assert.equal(isSensitiveApp({ bundleId: 'com.1password.1password', name: '1Password' }).sensitive, true, 'a bundle id prefix');
  assert.equal(isSensitiveApp({ bundleId: 'com.example.mybank', name: 'My Bank' }).sensitive, true, 'a name word');
  assert.equal(isSensitiveApp({ bundleId: 'com.apple.Safari', name: 'Safari' }).sensitive, false);
  assert.equal(isSensitiveApp({ bundleId: 'com.apple.finder', name: 'Finder' }).sensitive, false);
  assert.equal(isSensitiveApp({ bundleId: 'com.walletwise.notes', name: 'Walletwise Notes' }).sensitive, false, 'a word inside another word is not a match');
  assert.equal(isSensitiveApp({}).sensitive, false);
  assert.ok(SENSITIVE_APPS.names.includes('keychain access') && SENSITIVE_APPS.bundleIds.includes('com.apple.keychainaccess'));
  assert.deepEqual(parseChord('cmd+shift+s'), { modifiers: ['command', 'shift'], key: 's' });
  assert.deepEqual(parseChord('Return'), { modifiers: [], key: 'return' });
  assert.deepEqual(parseChord('ctrl+alt+enter'), { modifiers: ['control', 'option'], key: 'return' });
  assert.deepEqual(parseChord('cmd+cmd+a'), { modifiers: ['command'], key: 'a' });
  assert.throws(() => parseChord('hyper+s'), /not a modifier/);
  assert.throws(() => parseChord('cmd+eject'), /not a key/);
  assert.throws(() => parseChord(''), /required/);
  const nodes = [{ id: 'n1', role: 'AXButton', title: 'Save', x: 100, y: 200, w: 80, h: 30 }, { id: 'n2', role: 'AXTextField', title: 'Search', value: 'lanterns', x: 300, y: 40, w: 200, h: 24 }, { id: 'n3', role: 'AXStaticText', description: 'Save the file', x: 0, y: 0, w: 10, h: 10 }];
  assert.deepEqual(locateMatches(nodes, 'save').map((m) => m.id), ['n1', 'n3']);
  assert.deepEqual(locateMatches(nodes, 'save')[0].centre, { x: 140, y: 215 });
  assert.deepEqual(locateMatches(nodes, 'lanterns').map((m) => m.id), ['n2']);
  assert.deepEqual(locateMatches(nodes, 'AXButton').map((m) => m.id), ['n1'], 'a role matches by name');
  assert.deepEqual(locateMatches(nodes, ''), []);
  assert.equal(locateMatches(nodes, 'a', { max: 1 }).length, 1);
  assert.equal(encodeRequest('click', { x: 1, y: 2 }), '{"action":"click","x":1,"y":2}');
  assert.throws(() => encodeRequest('format', {}), /unknown computer action/);
  assert.deepEqual(decodeReply({ ok: true, value: '{"app":{"name":"Safari"}}' }), { ok: true, result: { app: { name: 'Safari' } } });
  assert.deepEqual(decodeReply({ ok: true, value: '{"ok":false,"code":"HALTED","error":"halted"}' }), { ok: false, code: 'HALTED', error: 'halted', app: null });
  assert.deepEqual(decodeReply({ ok: false, error: 'bad token' }), { ok: false, code: 'SHELL', error: 'bad token' });
  assert.equal(decodeReply({ ok: true, value: 'not json' }).code, 'BAD_REPLY');
  assert.deepEqual(decodeReply({ ok: true }), { ok: true, result: {} });
});

test('the Control desk grants the seven computer tools under computer_control, Observe by default, never at the Peak; every tool asks the judge even at Draft', () => {
  assert.ok(DOMAINS.includes('computer_control'));
  assert.deepEqual(defaultLeash().domains.computer_control, { level: 'observe' });
  assert.deepEqual(OBJECT_KINDS.control_desk.grants, [...COMPUTER_TOOL_NAMES]);
  for (const name of COMPUTER_TOOL_NAMES) assert.equal(TOOL_DOMAINS[name], 'computer_control', name);
  assert.ok(PEAK_REFUSED_KINDS.includes('control_desk'));
  const layout = defaultLayout();
  layout.rooms.push({ id: 'peak', name: 'Mountain Peak', kind: 'mountain_peak', x: 21, y: 1, w: 6, h: 6 });
  layout.objects.push({ id: 'desk', kind: 'control_desk', roomId: 'peak', x: 22, y: 2 });
  assert.equal(peakConnectorProblem(layout).id, 'desk');
  assert.match(OBJECT_KINDS.control_desk.hint, /starts at Observe/);
  assert.match(OBJECT_KINDS.control_desk.hint, new RegExp(HALT_HOTKEY.replace(/[⌃⌥⌘]/g, (c) => c)));
});

test('not wired without the shell: status says so and every tool fails with NOT_WIRED after the leash let it through', async () => {
  const h = await harness({ shell: null, leashLevel: 'act_free' });
  try {
    const st = await h.computer.status();
    assert.equal(st.wired, false);
    assert.match(st.reason, /macOS app is not running/);
    const { gate, ctx } = h.gateFor('ranger');
    assert.deepEqual(gate.definitions().map((d) => d.name), [...COMPUTER_TOOL_NAMES].sort());
    const r = await gate.execute({ id: 'c1', name: 'computer.screenshot', input: {} }, ctx);
    assert.equal(r.code, 'NOT_WIRED');
    assert.equal(h.ofType('computer.action').at(-1).status, 'refused');
    assert.equal(h.ofType('computer.action').at(-1).code, 'NOT_WIRED');
  } finally {
    await h.cleanup();
  }
});

test('the leash: Observe refuses before the shell is asked; Draft waits at the Gate and names the judge; Act with an action cap runs through the shell with a session, the banner, screenshots before and after, a trace line and the events, and the cap sends the next one to the Gate', async () => {
  const shell = await startFakeShell();
  const o = await harness({ shell, leashLevel: 'observe' });
  try {
    const { gate, ctx } = o.gateFor('ranger');
    const r = await gate.execute({ id: 'c1', name: 'computer.click', input: { x: 10, y: 10 } }, ctx);
    assert.equal(r.code, 'LEASH_OBSERVE');
    assert.deepEqual(shell.state.actions, [], 'nothing reached the shell');
    assert.equal(o.ofType('computer.action').length, 0);
  } finally {
    await o.cleanup();
  }
  const d = await harness({ shell, leashLevel: 'draft' });
  try {
    const { gate, ctx } = d.gateFor('ranger');
    assert.deepEqual(needsActionReview(gate, [{ name: 'computer.type', input: { text: 'hi' } }]).map((n) => n.name), ['computer.type'], 'the judge reviews it at Draft too');
    const pending = gate.execute({ id: 'c1', name: 'computer.type', input: { text: 'hello' } }, ctx);
    const item = await waitUntil(() => d.gateQueue.pending()[0]);
    assert.equal(item.domain, 'computer_control');
    assert.equal(item.summary, 'type 5 character(s) on the Mac');
    await d.gateQueue.resolve(item.itemId, { decision: 'reject', notes: 'not now' });
    assert.equal((await pending).code, 'GATE_REJECT');
    assert.deepEqual(shell.state.actions, []);
  } finally {
    await d.cleanup();
  }
  const a = await harness({ shell, leashLevel: 'act_capped', capActions: 2 });
  try {
    const { gate, ctx } = a.gateFor('ranger', { runId: 'run-7' });
    assert.deepEqual(needsActionReview(gate, [{ name: 'computer.click', input: { x: 1, y: 1 } }]).map((n) => n.level), ['act_capped'], 'the judge reviews every action at Act');
    const st = await a.computer.status();
    assert.equal(st.wired, true);
    assert.deepEqual(st.permissions, { accessibility: true, screenRecording: true });
    assert.equal(shell.state.banner, false);
    const r1 = await gate.execute({ id: 'c1', name: 'computer.locate', input: { query: 'save' } }, ctx);
    assert.equal(r1.ok, true, r1.error);
    const out = JSON.parse(r1.output);
    assert.equal(out.matches.length, 1);
    assert.deepEqual(out.matches[0].centre, { x: 140, y: 215 });
    assert.equal(out.app, 'Safari (com.apple.Safari)');
    assert.match(out.before, new RegExp(`ranger/${TRACE_DIR}/\\d+-locate-before\\.png$`));
    assert.match(out.after, /locate-after\.png$/);
    assert.equal(shell.state.banner, true, 'the banner is up while the session lasts');
    assert.deepEqual(shell.state.actions.map((x) => x.action), ['status', 'begin', 'frontmost', 'screenshot', 'locate', 'screenshot']);
    assert.equal(shell.state.actions[1].params.agentId, 'ranger');
    const png = await fsp.readFile(path.join(a.workspaceRoot, out.before));
    assert.ok(png.equals(TINY_PNG));
    const trace = await a.computer.trace('ranger');
    assert.equal(trace.length, 1);
    assert.equal(trace[0].action, 'locate');
    assert.equal(trace[0].ok, true);
    assert.equal(trace[0].app, 'Safari (com.apple.Safari)');
    assert.deepEqual(trace[0].result, { matches: 1, scanned: 2 });
    const ev = a.ofType('computer.action');
    assert.deepEqual(ev.map((e) => e.status), ['session_start', 'done']);
    assert.equal(ev[1].before, out.before);
    assert.equal(ev[1].runId, 'run-7');
    assert.deepEqual(a.ledger.spentToday('computer_control'), { usd: 0, actions: 1 });
    // A bad chord is refused by the policy after the checks and counts as no action.
    const bad = await gate.execute({ id: 'c1b', name: 'computer.key', input: { chord: 'hyper+s' } }, ctx);
    assert.equal(bad.code, 'BAD_INPUT');
    assert.ok(!shell.state.actions.some((x) => x.action === 'key'));
    assert.deepEqual(a.ledger.spentToday('computer_control'), { usd: 0, actions: 1 });
    const r2 = await gate.execute({ id: 'c2', name: 'computer.click', input: { x: 140, y: 215 } }, ctx);
    assert.equal(r2.ok, true, r2.error);
    assert.deepEqual(shell.state.actions.find((x) => x.action === 'click').params, { x: 140, y: 215, button: 'left', double: false });
    assert.equal(shell.state.actions.filter((x) => x.action === 'begin').length, 1, 'one session per run');
    const third = gate.execute({ id: 'c3', name: 'computer.key', input: { chord: 'cmd+s' } }, ctx);
    const item = await waitUntil(() => a.gateQueue.pending()[0]);
    assert.match(item.reason, /daily cap for computer_control is 2 action\(s\); 2 used today/);
    await a.gateQueue.resolve(item.itemId, { decision: 'approve' });
    const r3 = await third;
    assert.equal(r3.ok, true, r3.error);
    assert.deepEqual(shell.state.actions.find((x) => x.action === 'key').params, { modifiers: ['command'], key: 's' });
    // The run ends: the session ends and the banner goes.
    a.bus.emit(makeEvent('agent.run.end', { runId: 'run-7', reason: 'completed', turns: 3, finalText: 'done', usage: { inputTokens: 10, outputTokens: 5 } }, { ts: a.clock.now() }));
    await waitUntil(() => !shell.state.banner);
    assert.equal(a.ofType('computer.action').at(-1).status, 'session_end');
    assert.deepEqual(a.computer.sessions(), []);
  } finally {
    await a.cleanup();
    await shell.close();
  }
});

test('a sensitive app in front hands off to the Superintendent and is never driven: the action waits, the hand-back refuses it with the notes, the next action in the same app is refused outright, and focus on a sensitive app is refused before the shell', async () => {
  const shell = await startFakeShell();
  const h = await harness({ shell, leashLevel: 'act_free' });
  try {
    shell.state.frontmost = { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 120 };
    const { gate, ctx } = h.gateFor('ranger', { runId: 'run-2' });
    const typing = gate.execute({ id: 'c1', name: 'computer.type', input: { text: 'rm -rf' } }, ctx);
    const waiting = await waitUntil(() => h.computer.handoffs({ pendingOnly: true })[0]);
    assert.equal(waiting.kind, 'sensitive_app');
    assert.equal(waiting.app, 'Terminal (com.apple.Terminal)');
    assert.equal(waiting.action, 'type');
    assert.match(waiting.reason, /never drives/);
    assert.equal(h.ofType('computer.handoff').at(-1).status, 'waiting');
    assert.equal((await h.computer.status()).pending, 1);
    h.computer.returnHandoff(waiting.handoffId, { notes: 'I ran it myself' });
    const r = await typing;
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SENSITIVE_APP');
    assert.match(r.error, /handed to the Superintendent \(returned: I ran it myself\); the Ranger's type did not run/);
    assert.ok(!shell.state.actions.some((x) => x.action === 'type'), 'the shell never typed');
    assert.ok(!shell.state.actions.some((x) => x.action === 'screenshot'), 'no screenshot of a sensitive app either');
    assert.equal(h.ofType('computer.handoff').at(-1).status, 'returned');
    assert.equal(h.ofType('computer.action').at(-1).status, 'handoff');
    assert.equal(h.ofType('computer.action').at(-1).handoffId, waiting.handoffId);
    const again = await gate.execute({ id: 'c2', name: 'computer.click', input: { x: 1, y: 1 } }, ctx);
    assert.equal(again.code, 'SENSITIVE_APP');
    assert.match(again.error, /already handled it/);
    assert.equal(h.computer.handoffs().length, 1, 'no second handoff for the same app');
    shell.state.frontmost = { bundleId: 'com.apple.Safari', name: 'Safari', pid: 100 };
    const focus = await gate.execute({ id: 'c3', name: 'computer.focus', input: { name: 'Terminal' } }, ctx);
    assert.equal(focus.code, 'BAD_INPUT');
    assert.match(focus.error, /never brings it to the front/);
    assert.ok(!shell.state.actions.some((x) => x.action === 'focus'), 'the shell was not asked to focus it');
    const ok = await gate.execute({ id: 'c4', name: 'computer.apps', input: {} }, ctx);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(JSON.parse(ok.output).apps.length, 3);
    // An abandoned run abandons the handoff.
    const ac = new AbortController();
    shell.state.frontmost = { bundleId: 'com.1password.1password', name: '1Password', pid: 7 };
    const g2 = h.gateFor('ranger', { runId: 'run-3', signal: ac.signal });
    const p = g2.gate.execute({ id: 'c5', name: 'computer.screenshot', input: {} }, g2.ctx);
    await waitUntil(() => h.computer.handoffs({ pendingOnly: true })[0]);
    ac.abort();
    const r5 = await p;
    assert.match(r5.error, /abandoned/);
  } finally {
    await h.cleanup();
    await shell.close();
  }
});

test('the halt: the hotkey (the shell answers HALTED) or the Peak stops everything until the Superintendent resumes; sessions end and waiting handoffs are abandoned', async () => {
  const shell = await startFakeShell();
  const h = await harness({ shell, leashLevel: 'act_free' });
  try {
    const { gate, ctx } = h.gateFor('ranger', { runId: 'run-4' });
    assert.equal((await gate.execute({ id: 'c1', name: 'computer.screenshot', input: {} }, ctx)).ok, true);
    shell.halt(); // the hotkey, in the shell
    const r = await gate.execute({ id: 'c2', name: 'computer.click', input: { x: 1, y: 1 } }, ctx);
    assert.equal(r.code, 'HALTED');
    assert.match(r.error, /halted by the hotkey/);
    assert.equal(h.ofType('computer.action').at(-1).status, 'halted');
    assert.ok(h.computer.isHalted());
    const r2 = await gate.execute({ id: 'c3', name: 'computer.apps', input: {} }, ctx);
    assert.equal(r2.code, 'HALTED', 'stays halted on the sidecar side even if the shell forgot');
    assert.deepEqual((await h.computer.resume({ by: 'superintendent' })), { resumed: true, shell: 'resumed' });
    assert.equal(h.computer.isHalted(), null);
    assert.equal((await gate.execute({ id: 'c4', name: 'computer.apps', input: {} }, ctx)).ok, true);
    // The Peak's halt ends the session and abandons a waiting handoff.
    shell.state.frontmost = { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 120 };
    const p = gate.execute({ id: 'c5', name: 'computer.click', input: { x: 1, y: 1 } }, ctx);
    await waitUntil(() => h.computer.handoffs({ pendingOnly: true })[0]);
    await h.computer.halt({ by: 'superintendent' });
    const r5 = await p;
    assert.match(r5.error, /abandoned/);
    assert.equal(shell.state.banner, false);
    assert.deepEqual(h.computer.sessions(), []);
    assert.equal(shell.state.halted, true, 'the shell is told');
    assert.equal(h.ofType('computer.action').filter((e) => e.status === 'session_end').at(-1).reason, 'halted by superintendent');
  } finally {
    await h.cleanup();
    await shell.close();
  }
});

test('over HTTP: the snapshot carries computer control, the routes return status, handoffs, the hand-back, the halt from the hotkey and the resume; the trace route reads the Ranger\'s lines', async () => {
  const shell = await startFakeShell();
  const leash = defaultLeash();
  leash.domains.computer_control = { level: 'act_free' };
  const srv = await startTestServer({ makeProvider: async () => { throw new Error('none'); }, env: shell.env, layout: layoutWithDesk(), leash });
  try {
    const state = await srv.get('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.computer.wired, true);
    assert.equal(state.body.computer.hotkey, HALT_HOTKEY);
    assert.deepEqual(state.body.computer.sessions, []);
    assert.equal(state.body.objectKinds.control_desk.label, 'Control desk');
    const st = await srv.get('/api/computer');
    assert.equal(st.body.halted, null);
    assert.deepEqual(st.body.handoffs, []);
    const halted = await srv.post('/api/computer/halt', { by: 'hotkey' });
    assert.equal(halted.status, 200);
    assert.equal(halted.body.halted.by, 'the hotkey');
    assert.equal((await srv.get('/api/computer')).body.halted.by, 'the hotkey');
    const resumed = await srv.post('/api/computer/resume', {});
    assert.deepEqual(resumed.body, { resumed: true, shell: 'resumed' });
    const none = await srv.post('/api/computer/handoff/chand-none/return', { notes: 'x' });
    assert.equal(none.status, 404);
    assert.deepEqual((await srv.get('/api/computer/trace/ranger')).body, []);
    assert.equal((await srv.get('/api/computer/handoffs')).status, 200);
    const noShell = await startTestServer({ makeProvider: async () => { throw new Error('none'); } });
    try {
      const s2 = await noShell.get('/api/computer');
      assert.equal(s2.body.wired, false);
      assert.match(s2.body.reason, /macOS app/);
    } finally {
      await noShell.close();
    }
  } finally {
    await srv.close();
    await shell.close();
  }
});
