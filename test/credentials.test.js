// Phase 3 step 2: the credential broker from the sidecar's side. The shell's Keychain
// code is Rust (src-tauri/src/credentials.rs, broker.rs; `cargo test` in
// src-tauri/host-tests runs it on any host); here the fake broker speaks the same
// socket protocol so keys.js, the providers and the connector registry are exercised
// against the real framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { startFakeBroker } from './helpers/fake-broker.js';
import { brokerFrom, brokerRequest, resolveKey, setKey, keystoreStatus } from '../sidecar/providers/keys.js';
import { createProvider, providerStatus } from '../sidecar/providers/provider.js';
import { startTestServer } from './helpers/test-server.js';
import { startFakeConnector, fakeSpec } from './helpers/fake-connector.js';
import { fakeProvider, text, end } from './helpers/fake-provider.js';

test('brokerFrom reads the session handle from the environment, both parts required', () => {
  assert.equal(brokerFrom({}), null);
  assert.equal(brokerFrom({ MAKA_CREDENTIALS_SOCKET: '/tmp/x.sock' }), null);
  assert.deepEqual(brokerFrom({ MAKA_CREDENTIALS_SOCKET: ' /tmp/x.sock ', MAKA_CREDENTIALS_TOKEN: 'tok' }), { socket: '/tmp/x.sock', token: 'tok' });
});

test('keys through the broker: env wins, GET / SET / DEL / LIST over the socket, the keystore file is never read, failures are reported not hidden', async () => {
  const broker = await startFakeBroker({ initial: { anthropic: 'sk-from-keychain' } });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-cred-'));
  const keystorePath = path.join(dir, 'keystore.json');
  await setKey('anthropic', 'sk-from-file', { env: {}, keystorePath });
  try {
    const env = { ...broker.env };
    assert.equal(await resolveKey('anthropic', { env: { ...env, ANTHROPIC_API_KEY: 'sk-env' }, keystorePath }), 'sk-env', 'the environment still wins');
    assert.equal(await resolveKey('anthropic', { env, keystorePath }), 'sk-from-keychain', 'the broker, not the file');
    assert.equal(await resolveKey('openrouter', { env, keystorePath }), null, 'NONE is null');
    assert.deepEqual(broker.requests.slice(-2), ['test-token GET anthropic', 'test-token GET openrouter']);

    await setKey('resend', 're_123\nwith newline', { env, keystorePath });
    assert.equal(broker.store.get('resend'), 're_123\nwith newline', 'base64 keeps the framing');
    assert.equal(await resolveKey('resend', { env, keystorePath }), 're_123\nwith newline');
    await setKey('resend', null, { env, keystorePath });
    assert.equal(broker.store.has('resend'), false);
    assert.match(broker.requests.at(-1), /^test-token DEL resend$/);
    assert.deepEqual(JSON.parse(await fsp.readFile(keystorePath, 'utf8')), { anthropic: 'sk-from-file' }, 'the file was never touched');

    const status = await keystoreStatus({ env, keystorePath });
    assert.deepEqual(status, { path: broker.socket, broker: true, problem: null, providers: ['anthropic'] });
    assert.equal(JSON.stringify(status).includes('sk-'), false);

    // A wrong token is refused before any store access.
    const warnings = [];
    assert.equal(await resolveKey('anthropic', { env: { ...env, MAKA_CREDENTIALS_TOKEN: 'wrong' }, keystorePath, warn: (m) => warnings.push(m) }), null);
    assert.match(warnings[0], /refused GET anthropic: bad token/);
    await assert.rejects(setKey('anthropic', 'x', { env: { ...env, MAKA_CREDENTIALS_TOKEN: 'wrong' } }), (e) => e.code === 'BROKER_REFUSED');
    assert.equal(await resolveKey('bad name', { env, keystorePath, warn: (m) => warnings.push(m) }), null);
    assert.match(warnings[1], /invalid credential name/);

    // A broker failure is a reported "no key", never a fallback to the file.
    broker.fail = 'keychain locked';
    assert.equal(await resolveKey('anthropic', { env, keystorePath, warn: (m) => warnings.push(m) }), null);
    assert.match(warnings[2], /keychain locked/);
    assert.match((await keystoreStatus({ env, keystorePath })).problem, /keychain locked/);
    broker.fail = null;

    // The socket gone (the session ended): unreachable, reported.
    await broker.close();
    assert.equal(await resolveKey('anthropic', { env, keystorePath, warn: (m) => warnings.push(m) }), null);
    assert.match(warnings[3], /not answering/);
    await assert.rejects(brokerRequest(brokerFrom(env), 'GET', 'anthropic'), (e) => e.code === 'BROKER_UNREACHABLE');
    const st = await keystoreStatus({ env, keystorePath });
    assert.equal(st.broker, true);
    assert.match(st.problem, /not answering/);
  } finally {
    await broker.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a slow broker times out instead of hanging a run', async () => {
  const broker = await startFakeBroker();
  try {
    const connect = () => {
      // A socket that connects and never answers.
      const { EventEmitter } = globalThis.process.getBuiltinModule ? process.getBuiltinModule('node:events') : { EventEmitter: null };
      const s = new EventEmitter();
      s.setEncoding = () => {};
      s.write = () => {};
      s.destroy = () => {};
      setTimeout(() => s.emit('connect'), 1);
      return s;
    };
    await assert.rejects(brokerRequest(brokerFrom(broker.env), 'GET', 'anthropic', undefined, { timeoutMs: 30, connect }), (e) => e.code === 'BROKER_TIMEOUT');
  } finally {
    await broker.close();
  }
});

test('providers resolve their keys through the broker and report status without leaking', async () => {
  const broker = await startFakeBroker({ initial: { anthropic: 'sk-ant-broker' } });
  try {
    const env = { ...broker.env };
    const made = await createProvider('anthropic', { env });
    assert.equal(made.provider.name, 'anthropic');
    await assert.rejects(createProvider('openrouter', { env }), (e) => e.code === 'NO_KEY');
    const status = await providerStatus({ env, probeLocal: false });
    assert.equal(status.anthropic.configured, true);
    assert.equal(status.openrouter.configured, false);
    assert.equal(JSON.stringify(status).includes('sk-ant'), false);
  } finally {
    await broker.close();
  }
});

test('through the sidecar: a connector key approved at the Gate lands in the Keychain via the broker, a disconnect removes it, and the state says secrets live in the Keychain', async () => {
  const broker = await startFakeBroker();
  const fake = await startFakeConnector();
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('ok'), end()]]), model: 'm', price: null }), env: { ...broker.env }, connectors: [fakeSpec({ baseUrl: fake.url })] });
  try {
    const state = await srv.get('/api/state');
    assert.deepEqual(state.body.keystore, { path: broker.socket, problem: null, broker: true });
    const stream = await srv.sse();
    const r = await srv.post('/api/connectors/fakeshop/connect', { apiKey: fake.apiKey });
    assert.equal(r.status, 202);
    const item = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending');
    assert.equal(JSON.stringify(item).includes(fake.apiKey), false, 'the key is not in the Gate item');
    assert.equal((await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve' })).status, 200);
    await stream.waitFor((e) => e.type === 'connector.status' && e.payload.change === 'connected');
    assert.equal(broker.store.get('fakeshop'), fake.apiKey, 'stored through the broker');
    assert.equal(broker.requests.some((l) => /SET fakeshop /.test(l)), true);
    await stream.waitFor((e) => e.type === 'connector.sync' && e.payload.status === 'done', 5000);
    assert.equal((await fsp.readdir(srv.home)).includes('keystore.json'), false, 'no keystore file was written');

    const d = await srv.post('/api/connectors/fakeshop/disconnect', {});
    assert.equal(d.status, 202);
    const dItem = await stream.waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.itemId !== item.payload.itemId);
    await srv.post(`/api/gate/${dItem.payload.itemId}`, { decision: 'approve' });
    await stream.waitFor((e) => e.type === 'connector.status' && e.payload.change === 'disconnected');
    assert.equal(broker.store.has('fakeshop'), false);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
    await broker.close();
  }
});
