// Phase 3 step 3 (first run) and step 4 (Ollama management) against fakes: the Ollama
// manager (probe, memory sizing, pull with real progress, failure, start, remove), key
// verification, the setup module (candidates, workspace root into config.json with an
// in-process restart, key stored only when not refused, completion), and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { startFakeOllama } from './helpers/fake-ollama.js';
import { startFakeKeyCheck } from './helpers/fake-key-check.js';
import { createOllama, recommend, CANDIDATES, GB } from '../sidecar/ollama.js';
import { createSetup, verifyKey } from '../sidecar/setup.js';
import { createEventBus } from '../sidecar/bus.js';
import { resolveKey } from '../sidecar/providers/keys.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, toolCall, end } from './helpers/fake-provider.js';
import { readJson } from '../sidecar/store.js';

const fakeOs = (totalGb, freeGb) => ({ totalmem: () => totalGb * GB, freemem: () => freeGb * GB });

test('recommend: the largest tool-capable model that fits half the memory, with every candidate\'s fit', () => {
  assert.equal(recommend({ totalBytes: 16 * GB, freeBytes: 2 * GB }).recommended, 'qwen2.5:7b', '16 GB: the 7B model (docs/KICKOFF_BRIEF.md)');
  assert.equal(recommend({ totalBytes: 32 * GB, freeBytes: 2 * GB }).recommended, 'qwen2.5:14b');
  assert.equal(recommend({ totalBytes: 8 * GB, freeBytes: 2 * GB }).recommended, 'qwen2.5:3b');
  assert.equal(recommend({ totalBytes: 2 * GB, freeBytes: 1 * GB }).recommended, null);
  const r = recommend({ totalBytes: 16 * GB, freeBytes: 2 * GB });
  assert.equal(r.budgetBytes, 8 * GB);
  assert.deepEqual(r.candidates.map((c) => c.fits), [false, true, true, true]);
  assert.match(r.note, /qwen2\.5:7b needs about 6\.5 GB/);
  assert.equal(Object.isFrozen(CANDIDATES), true);
});

test('ollama manager: probe, summary, pull with progress events, a failed pull, remove, start when not installed', async () => {
  const fake = await startFakeOllama({ models: [{ name: 'llama3.2:3b', size: 2 * GB }] });
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const spawned = [];
  const mgr = createOllama({ env: { OLLAMA_HOST: fake.url, PATH: '/nowhere' }, bus, osImpl: fakeOs(16, 3), fs: { stat: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } }, spawn: (...a) => { spawned.push(a); return { unref() {} }; }, platform: 'darwin', log: { error() {} } });
  try {
    const before = mgr.summary();
    assert.equal(before.reachable, false);
    assert.equal(before.problem, 'not probed yet');
    const st = await mgr.status();
    assert.equal(st.reachable, true);
    assert.equal(st.version, '0.6.0');
    assert.deepEqual(st.models.map((m) => [m.name, m.sizeBytes, m.family, m.parameters, m.quantization]), [['llama3.2:3b', 2 * GB, 'qwen2', '7.6B', 'Q4_K_M']]);
    assert.equal(st.chosen, 'llama3.2:3b');
    assert.equal(st.memory.recommended, 'qwen2.5:7b');
    assert.equal(st.memory.totalBytes, 16 * GB);
    assert.deepEqual(st.installed, { binary: null, app: null });
    assert.match(st.installHint, /ollama\.com\/download/);
    assert.match(st.worker, /^ready: llama3\.2:3b/);

    const progress = [];
    const r = await mgr.pull('qwen2.5:7b', { onProgress: (p) => progress.push(p) });
    assert.equal(r.ok, true);
    assert.deepEqual(fake.pulls, ['qwen2.5:7b']);
    assert.equal(progress[0].status, 'starting');
    assert.ok(progress.some((p) => p.completed === 4000 && p.total === 4000), 'real byte counts from the stream');
    assert.deepEqual(progress.at(-1), { model: 'qwen2.5:7b', status: 'success', completed: 4000, total: 4000, done: true });
    const pulls = events.filter((e) => e.type === 'ollama.pull');
    assert.ok(pulls.length >= 2);
    assert.equal(pulls.at(-1).payload.done, true);
    assert.deepEqual(r.models.map((m) => m.name), ['llama3.2:3b', 'qwen2.5:7b'], 're-probed after the pull');
    assert.equal(mgr.summary().pulling, null);

    fake.failPull = 'pull model manifest: file does not exist';
    await assert.rejects(mgr.pull('nope:latest'), (e) => e.code === 'PULL_FAILED' && /file does not exist/.test(e.message));
    const failed = events.filter((e) => e.type === 'ollama.pull').at(-1);
    assert.equal(failed.payload.done, true);
    assert.match(failed.payload.error, /file does not exist/);
    fake.failPull = null;
    await assert.rejects(mgr.pull('bad name!'), (e) => e.code === 'BAD_REQUEST');

    const removed = await mgr.remove('llama3.2:3b');
    assert.deepEqual(removed.models.map((m) => m.name), ['qwen2.5:7b']);
    await assert.rejects(mgr.remove('llama3.2:3b'), (e) => e.code === 'REMOVE_FAILED' && e.status === 404);

    assert.deepEqual(await mgr.start(), { started: false, reachable: true, how: 'already running' });
    await fake.close();
    await assert.rejects(mgr.start({ waitMs: 10 }), (e) => e.code === 'NOT_INSTALLED' && /ollama\.com\/download/.test(e.message));
    assert.equal(spawned.length, 0);
    const down = mgr.summary();
    assert.equal(down.reachable, false);
    assert.match(down.worker, /not reachable: runs answer OLLAMA_UNREACHABLE/);
  } finally {
    await fake.close().catch(() => {});
  }
});

test('ollama manager: start opens the macOS app when installed, else `ollama serve`, and one pull at a time', async () => {
  const fake = await startFakeOllama();
  const spawned = [];
  const files = new Set(['/Applications/Ollama.app']);
  const fs = { stat: async (p) => { if (!files.has(p)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return { isFile: () => !p.endsWith('.app'), isDirectory: () => p.endsWith('.app') }; } };
  let reachable = false;
  const mgr = createOllama({ env: { OLLAMA_HOST: fake.url, PATH: '/usr/bin' }, fetch: async (url, opts) => { if (!reachable) throw new Error('ECONNREFUSED'); return fetch(url, opts); }, osImpl: fakeOs(16, 3), fs, spawn: (cmd, args, opts) => { spawned.push([cmd, args, opts.detached]); reachable = true; return { unref() {} }; }, platform: 'darwin', log: { error() {} } });
  try {
    const r = await mgr.start({ waitMs: 2000 });
    assert.deepEqual(spawned, [['open', ['-a', '/Applications/Ollama.app'], true]]);
    assert.equal(r.reachable, true);
    assert.equal(r.how, 'open -a /Applications/Ollama.app');
    files.delete('/Applications/Ollama.app');
    files.add('/opt/homebrew/bin/ollama');
    reachable = false;
    const r2 = await mgr.start({ waitMs: 2000 });
    assert.deepEqual(spawned.at(-1), ['/opt/homebrew/bin/ollama', ['serve'], true]);
    assert.equal(r2.how, '/opt/homebrew/bin/ollama serve');
    const first = mgr.pull('qwen2.5:3b');
    await assert.rejects(mgr.pull('qwen2.5:7b'), (e) => e.code === 'PULL_ACTIVE' && e.status === 409);
    await first;
  } finally {
    await fake.close();
  }
});

test('verifyKey: 200 valid, 401 invalid, 500 and network are "could not verify", unknown provider has no endpoint', async () => {
  const check = await startFakeKeyCheck({ valid: 'sk-good' });
  try {
    assert.deepEqual(await verifyKey('anthropic', 'sk-good', { urls: check.urls }), { verified: true, valid: true, reason: null });
    assert.equal(check.calls[0].headers['x-api-key'], 'sk-good');
    assert.equal(check.calls[0].headers['anthropic-version'], '2023-06-01');
    const bad = await verifyKey('openrouter', 'sk-bad', { urls: check.urls });
    assert.equal(bad.valid, false);
    assert.equal(check.calls[1].headers.authorization, 'Bearer sk-bad');
    check.fail = true;
    assert.deepEqual(await verifyKey('anthropic', 'sk-good', { urls: check.urls }), { verified: false, valid: null, reason: 'anthropic answered HTTP 500; could not verify' });
    check.fail = false;
    await check.close();
    const down = await verifyKey('anthropic', 'sk-good', { urls: check.urls });
    assert.equal(down.verified, false);
    assert.match(down.reason, /could not reach anthropic/);
    assert.equal((await verifyKey('huggingface', 'x', { urls: check.urls })).verified, false);
  } finally {
    await check.close().catch(() => {});
  }
});

test('setup module: candidates with the LaCie first when mounted, the root into config.json with a restart, a refused key, completion persisted', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-setup-'));
  const home = path.join(tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, 'config.json'), JSON.stringify({ reflectAt: '06:30' }));
  const check = await startFakeKeyCheck({ valid: 'sk-good' });
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const restarts = [];
  // A fake fs that pretends /Volumes/LaCie exists (mounted, writable) but delegates the rest.
  const lacie = { mounted: true };
  const fs = { ...fsp, constants: fsp.constants, stat: async (p) => { if (p === '/Volumes/LaCie') { if (!lacie.mounted) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return { isDirectory: () => true }; } return fsp.stat(p); }, access: async (p, mode) => (p === '/Volumes/LaCie' ? undefined : fsp.access(p, mode)) };
  const keystorePath = path.join(home, 'keystore.json');
  const setup = await createSetup({ home, workspaceRoot: path.join(tmp, 'ws'), env: {}, keystorePath, bus, restart: () => restarts.push(1), fetch: globalThis.fetch, fs, platform: 'darwin', verifyUrls: check.urls, providerStatus: async () => ({ anthropic: { configured: false } }), log: { error() {} } }).init();
  try {
    let st = await setup.state();
    assert.equal(st.firstRun, true);
    assert.deepEqual(st.workspace.candidates.map((c) => [c.label, c.mounted, c.default]), [['current root', true, false], ['LaCie external drive', true, true], ['home directory', true, false]]);
    assert.equal(st.workspace.candidates[1].path, '/Volumes/LaCie/Maka/workspace');
    lacie.mounted = false;
    st = await setup.state();
    assert.deepEqual(st.workspace.candidates.map((c) => [c.label, c.mounted, c.default]), [['current root', true, true], ['LaCie external drive', false, false], ['home directory', true, false]]);

    await assert.rejects(setup.setWorkspace('relative/path'), (e) => e.code === 'BAD_REQUEST');
    await fsp.writeFile(path.join(tmp, 'a-file'), 'x');
    await assert.rejects(setup.setWorkspace(path.join(tmp, 'a-file', 'inside')), (e) => e.code === 'WORKSPACE_UNWRITABLE');
    const same = await setup.setWorkspace(path.join(tmp, 'ws'));
    assert.deepEqual([same.changed, same.restarting], [false, false]);
    assert.deepEqual(restarts, []);
    const moved = await setup.setWorkspace(path.join(tmp, 'drive', 'Maka', 'workspace'));
    assert.deepEqual([moved.changed, moved.restarting], [true, true]);
    assert.deepEqual(restarts, [1]);
    assert.deepEqual(await readJson(path.join(home, 'config.json')), { reflectAt: '06:30', workspaceRoot: path.join(tmp, 'drive', 'Maka', 'workspace') }, 'merged, not replaced');
    assert.ok((await fsp.stat(path.join(tmp, 'drive', 'Maka', 'workspace'))).isDirectory());
    assert.deepEqual(events.filter((e) => e.type === 'setup.changed').map((e) => [e.payload.step, e.payload.change]), [['workspace', 'done'], ['workspace', 'done'], ['workspace', 'restarting']]);

    await assert.rejects(setup.setKey('anthropic', 'sk-bad'), (e) => e.code === 'KEY_INVALID');
    assert.equal(await resolveKey('anthropic', { env: {}, keystorePath }), null, 'a refused key is not stored');
    const ok = await setup.setKey('anthropic', ' sk-good ');
    assert.deepEqual([ok.stored, ok.verified, ok.reason], [true, true, null]);
    assert.equal(await resolveKey('anthropic', { env: {}, keystorePath }), 'sk-good');
    await assert.rejects(setup.setKey('huggingface', 'x'), (e) => e.code === 'BAD_REQUEST');
    check.fail = true;
    const unverified = await setup.setKey('openrouter', 'or-1');
    assert.deepEqual([unverified.stored, unverified.verified], [true, false]);
    assert.match(unverified.reason, /HTTP 500/);
    check.fail = false;

    st = await setup.state();
    assert.equal(st.steps.workspace.detail, path.join(tmp, 'drive', 'Maka', 'workspace'));
    assert.match(st.judge.verified, /openrouter: stored, not verified/);
    const done = await setup.complete({});
    assert.equal(done.firstRun, false);
    assert.equal(done.skipped, false);
    const again = await createSetup({ home, workspaceRoot: path.join(tmp, 'ws'), env: {}, keystorePath, providerStatus: async () => ({}), log: { error() {} } }).init();
    assert.equal((await again.state()).firstRun, false, 'persisted in setup.json');
    assert.equal((await again.reset()).firstRun, true);
    assert.equal(events.filter((e) => e.type === 'setup.changed').at(-1).payload.change, 'completed');
  } finally {
    await check.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('setup module: a workspace pinned by MAKA_WORKSPACE is written to config.json but does not restart, and says why', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-setup-'));
  const restarts = [];
  const setup = await createSetup({ home: path.join(tmp, 'home'), workspaceRoot: path.join(tmp, 'ws'), env: { MAKA_WORKSPACE: path.join(tmp, 'ws') }, restart: () => restarts.push(1), providerStatus: async () => ({}), log: { error() {} } }).init();
  try {
    const r = await setup.setWorkspace(path.join(tmp, 'other'));
    assert.deepEqual([r.changed, r.restarting, r.envPinned], [true, false, true]);
    assert.match(r.note, /MAKA_WORKSPACE=/);
    assert.deepEqual(restarts, []);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('over HTTP: the first-run state, the routes, a pull streaming ollama.pull, a mission marking the step, completion', async () => {
  const fake = await startFakeOllama();
  const check = await startFakeKeyCheck({ valid: 'sk-good' });
  const PLAN = { summary: 'One venture.', ventures: [{ id: 'v1', name: 'V1', summary: 'x', budgetUsd: 1, roles: [{ specialty: 'scout' }], tasks: [] }] };
  const chiefProvider = fakeProvider([[...toolCall('p1', 'plan.submit', PLAN), end('tool_use', { inputTokens: 10, outputTokens: 5 })], [text('Planned.'), end()]], { name: 'anthropic' });
  const srv = await startTestServer({ makeProvider: async (name, opts) => ({ provider: chiefProvider, model: opts.model, price: { inputPerMTok: 1, outputPerMTok: 1 } }), withChief: true, ollama: fake.url, setup: { verifyUrls: check.urls, platform: 'linux' } });
  try {
    const state = await srv.get('/api/state');
    assert.equal(state.body.setup.firstRun, true);
    assert.equal(state.body.setup.mission.chief.name.length > 0, true, 'the Chief is already at the Peak');
    assert.equal(state.body.setup.mission.briefed, false);
    assert.equal(state.body.ollama.host, fake.url);
    const o = await srv.get('/api/ollama');
    assert.equal(o.body.reachable, true);
    assert.deepEqual(o.body.models, []);
    assert.match(o.body.worker, /no model pulled/);
    assert.ok(o.body.memory.totalBytes > 0);

    const stream = await srv.sse();
    const pull = await srv.post('/api/ollama/pull', { model: 'qwen2.5:7b' });
    assert.equal(pull.status, 202);
    const done = await stream.waitFor((e) => e.type === 'ollama.pull' && e.payload.done, 5000);
    assert.equal(done.payload.status, 'success');
    assert.equal(done.payload.total, 4000);
    assert.deepEqual((await srv.get('/api/ollama')).body.models.map((m) => m.name), ['qwen2.5:7b']);
    assert.equal((await srv.post('/api/ollama/pull', {})).status, 400);

    const setupState = await srv.get('/api/setup');
    assert.equal(setupState.body.worker.chosen, 'qwen2.5:7b');
    assert.equal(setupState.body.workspace.candidates.some((c) => c.default), true);
    assert.equal((await srv.post('/api/setup/key', { provider: 'anthropic', key: 'sk-bad' })).status, 400);
    const key = await srv.post('/api/setup/key', { provider: 'anthropic', key: 'sk-good' });
    assert.equal(key.status, 200);
    assert.equal(key.body.verified, true);
    assert.equal((await srv.get('/api/setup')).body.judge.anthropic, true);

    const ws = await srv.post('/api/setup/workspace', { root: path.join(srv.home, '..', 'moved') });
    assert.equal(ws.status, 200);
    assert.equal(ws.body.restarting, true);
    assert.equal(srv.restartCalls.length, 1);
    await stream.waitFor((e) => e.type === 'setup.changed' && e.payload.change === 'restarting');

    const m = await srv.post('/api/mission', { text: 'Sell lanterns.', budgetUsd: 2, horizon: '30 days' });
    assert.equal(m.status, 202);
    await srv.runs.waitForIdle();
    assert.equal((await srv.get('/api/setup')).body.mission.briefed, true);
    assert.ok((await srv.get('/api/setup')).body.steps.mission);

    const complete = await srv.post('/api/setup/complete', {});
    assert.equal(complete.body.firstRun, false);
    assert.equal((await srv.get('/api/state')).body.setup.firstRun, false);
    assert.equal((await srv.post('/api/restart', {})).status, 202);
    assert.equal(srv.restartCalls.length, 2);
    assert.equal((await srv.post('/api/setup/reset', {})).body.firstRun, true);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
    await check.close();
  }
});
