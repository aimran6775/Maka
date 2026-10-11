import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashLedger, createLeashState } from '../sidecar/leash-ledger.js';
import { createGateQueue } from '../sidecar/gate-queue.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { createMcpManager, loadCatalog, validateCatalogEntry, specFromCatalog, validateServerSpec, CATALOG_PATH, SECRET_ARG_PREFIX } from '../sidecar/mcp/manager.js';
import { resolveKey } from '../sidecar/providers/keys.js';
import { DOMAINS, MONEY_DOMAINS } from '../shared/leash.js';
import { defaultLeash } from '../shared/leash.js';
import { defaultLayout } from '../shared/world.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, fakeClock, text, end, waitUntil } from './helpers/fake-provider.js';

const FAKE_SERVER = fileURLToPath(new URL('./helpers/fake-mcp-server.mjs', import.meta.url));
const local = createNetGuard({ allowLocal: true });
const quiet = { warn() {}, error() {} };

test('the catalog file: seven vetted entries, every one validates and builds a valid server spec, proposals use known non-money domains, secrets are names only, sources are https', () => {
  const catalog = loadCatalog(CATALOG_PATH);
  assert.deepEqual(catalog.entries.map((e) => e.id), ['filesystem', 'github', 'gdrive', 'notion', 'slack', 'postgres', 'brave-search']);
  const raw = JSON.parse(JSON.stringify(catalog));
  for (const e of catalog.entries) {
    validateCatalogEntry(e);
    assert.match(e.source, /^https:\/\//);
    for (const [, d] of Object.entries(e.leash)) {
      assert.ok(DOMAINS.includes(d));
      assert.ok(!MONEY_DOMAINS.includes(d), 'the catalog never proposes a money mapping');
    }
    const params = Object.fromEntries(e.params.filter((p) => p.required).map((p) => [p.name, p.kind === 'path' ? '/tmp/x' : 'T123']));
    const secrets = Object.fromEntries(e.secrets.map((s) => [s.name, 'value']));
    const { spec } = specFromCatalog(e, { params, secrets });
    const clean = validateServerSpec(spec);
    assert.equal(clean.source, `catalog:${e.id}`);
    if (e.transport === 'stdio') {
      assert.equal(clean.command, 'npx');
      assert.equal(clean.args[0], '-y');
      assert.match(clean.args[1], /^@?[a-z0-9./_-]+@latest$/);
      assert.deepEqual(clean.secretEnv, e.secrets.map((s) => s.name));
      assert.equal(JSON.stringify(clean).includes('value'), false, 'no secret value in the spec');
    } else assert.match(clean.url, /^https:\/\//);
  }
  assert.equal(JSON.stringify(raw).includes('xoxb-'), true, 'the Slack hint names the token shape only');
  // Entry checks.
  const fs = catalog.entries[0];
  assert.throws(() => validateCatalogEntry({ ...fs, source: 'http://x' }), /https source/);
  assert.throws(() => validateCatalogEntry({ ...fs, leash: { read_file: 'money_out' } }), /no money mapping/);
  assert.throws(() => validateCatalogEntry({ ...fs, args: ['$SECRET:NOPE'] }), /undeclared secret/);
  assert.throws(() => validateCatalogEntry({ ...fs, args: ['{nope}'] }), /unknown param/);
  assert.throws(() => validateCatalogEntry({ ...fs, secrets: [{ name: 'X', label: 'x', value: 'leak' }] }), /other than name/);
  // Spec building: required params, unknown secrets, the version pin, env params, $SECRET args kept for the keystore.
  assert.throws(() => specFromCatalog(fs, {}), /needs Directory/);
  assert.deepEqual(specFromCatalog(fs, { params: { path: '/data', version: '2025.8.21' } }).spec.args, ['-y', '@modelcontextprotocol/server-filesystem@2025.8.21', '/data']);
  const slack = catalog.entries.find((e) => e.id === 'slack');
  assert.throws(() => specFromCatalog(slack, { params: { teamId: 'T1' }, secrets: {} }), /needs Slack bot token/);
  assert.throws(() => specFromCatalog(slack, { params: { teamId: 'T1' }, secrets: { SLACK_BOT_TOKEN: 'x', EXTRA: 'y' } }), /takes no secret named EXTRA/);
  const built = specFromCatalog(slack, { params: { teamId: 'T1' }, secrets: { SLACK_BOT_TOKEN: 'xoxb-1' } });
  assert.deepEqual(built.spec.env, { SLACK_TEAM_ID: 'T1' });
  assert.deepEqual(built.secrets, { SLACK_BOT_TOKEN: 'xoxb-1' });
  const pg = specFromCatalog(catalog.entries.find((e) => e.id === 'postgres'), { secrets: { DATABASE_URL: 'postgresql://u:p@h/db' } });
  assert.deepEqual(pg.spec.args.slice(2), [`${SECRET_ARG_PREFIX}DATABASE_URL`], 'the URL is not in the args; the keystore hands it over at start');
  assert.throws(() => validateServerSpec({ id: 'x', label: 'x', transport: 'stdio', command: 'c', args: ['$SECRET:NOPE'] }), /not declared in secretEnv/);
});

test('addFromCatalog through the Gate with a test catalog pointing at the fake server: the proposed leash lands, the secret arg reaches the child from the keystore and never the config, a second copy needs its own id', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-cat-'));
  const home = path.join(dir, 'home');
  const store = createStore({ root: home });
  await store.init();
  const bus = createEventBus();
  const clock = fakeClock(1_700_000_000_000);
  const layoutState = createLayoutState({ initial: defaultLayout(), store, bus, clock });
  const ledger = await createLeashLedger({ store, clock }).init();
  const leashState = createLeashState({ initial: defaultLeash(), store });
  const gateQueue = await createGateQueue({ bus, store, ledger, leashState, getLayout: layoutState.get, clock }).init();
  const keystorePath = path.join(home, 'keystore.json');
  const registry = {};
  // A test catalog whose "package" is the fake server run by node: npx is replaced by the node binary through the entry's args.
  const catalog = { version: 1, entries: [{ id: 'fakecat', label: 'Fake Catalog Server', description: 'the fake', source: 'https://example.test/fake', license: 'MIT', transport: 'stdio', package: 'fake-pkg', args: ['{flag}', '$SECRET:DB_URL'], params: [{ name: 'flag', label: 'A flag', required: true }], secrets: [{ name: 'DB_URL', label: 'A connection URL', hint: 'has a password' }], env: {}, leash: { send_note: 'publishing', echo: 'research' }, notes: 'test only' }] };
  const mcp = await createMcpManager({ bus, store, gateQueue, env: { PATH: process.env.PATH }, keystorePath, netGuard: local, registry, getLayout: layoutState.get, clock, catalog, log: quiet }).init(); // PATH from the sidecar's environment, never a spec (safety 2026-10-11 L3)
  try {
    assert.deepEqual(mcp.catalog().map((c) => [c.id, c.installed]), [['fakecat', false]]);
    await assert.rejects(mcp.addFromCatalog('nope', {}), (e) => e.code === 'UNKNOWN_ENTRY');
    await assert.rejects(mcp.addFromCatalog('fakecat', { secrets: { DB_URL: 'x' } }), /needs A flag/);
    // The spec from the catalog says npx; the test rewrites the command to run the fake under node, keeping the args.
    const spyAdd = mcp.add;
    mcp.add = (spec) => spyAdd({ ...spec, command: process.execPath, args: [FAKE_SERVER, ...spec.args.slice(2)] });
    await mcp.addFromCatalog('fakecat', { params: { flag: '--flagged' }, secrets: { DB_URL: 'postgresql://u:secret-pw@h/db' } });
    const item = gateQueue.pending()[0];
    assert.equal(item.tool, 'mcp.add');
    assert.match(item.evidence[1].text, /secrets \(values in the keystore\): DB_URL; from the catalog \(fakecat\)/);
    assert.match(item.evidence[2].text, /overrides send_note=publishing, echo=research/);
    assert.equal(JSON.stringify(item).includes('secret-pw'), false);
    await gateQueue.resolve(item.itemId, { decision: 'approve' });
    await waitUntil(() => mcp.status('fakecat') && mcp.status('fakecat').status === 'connected');
    const row = mcp.status('fakecat');
    assert.equal(row.source, 'catalog:fakecat');
    assert.equal(row.tools.find((t) => t.name === 'send_note').domain, 'publishing');
    assert.equal(mcp.catalog()[0].installed, true);
    const argv = JSON.parse((await registry['mcp.fakecat.argv'].run({}, {})).output);
    assert.deepEqual(argv, ['--flagged', 'postgresql://u:secret-pw@h/db'], 'the child got the real URL as its argument');
    const saved = await fsp.readFile(path.join(home, 'mcp-servers.json'), 'utf8');
    assert.equal(saved.includes('secret-pw'), false);
    assert.ok(saved.includes('$SECRET:DB_URL'));
    assert.equal(await resolveKey('mcp.fakecat.DB_URL', { env: {}, keystorePath }), 'postgresql://u:secret-pw@h/db');
    // The same entry again collides on the id unless one is given.
    await assert.rejects(mcp.addFromCatalog('fakecat', { params: { flag: 'x' }, secrets: { DB_URL: 'y' } }), (e) => e.code === 'EXISTS');
    await mcp.addFromCatalog('fakecat', { params: { flag: 'x' }, secrets: { DB_URL: 'y' }, id: 'fakecat-2', label: 'Second' });
    assert.equal(gateQueue.pending()[0].summary, 'add MCP server Second (fakecat-2, stdio)');
    await gateQueue.resolve(gateQueue.pending()[0].itemId, { decision: 'reject' });
    // A server whose secret arg is missing from the keystore fails to connect plainly.
    await mcp.disconnect('fakecat');
    await fsp.writeFile(keystorePath, '{}\n', { mode: 0o600 });
    await mcp.connect('fakecat');
    assert.equal(mcp.status('fakecat').status, 'error');
    assert.equal(mcp.status('fakecat').lastError.code, 'SECRET_MISSING');
  } finally {
    await mcp.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('through the sidecar: GET /api/mcp/catalog lists the vetted entries without values; POST /api/mcp/catalog/:id parks the filled server at the Gate; a bad entry is 404', async () => {
  const srv = await startTestServer({ makeProvider: async (name) => ({ provider: fakeProvider([[text('x'), end()]], { name }), model: 'w', price: null }), withChief: true, mcp: { oauthPort: 0 } });
  try {
    const cat = await srv.get('/api/mcp/catalog');
    assert.equal(cat.status, 200);
    assert.equal(cat.body.length, 7);
    assert.ok(cat.body.every((c) => c.secrets.every((s) => Object.keys(s).every((k) => ['name', 'label', 'hint'].includes(k)))));
    assert.equal((await srv.post('/api/mcp/catalog/nope', {})).status, 404);
    assert.equal((await srv.post('/api/mcp/catalog/brave-search', {})).status, 400, 'the key is required');
    const added = await srv.post('/api/mcp/catalog/brave-search', { secrets: { BRAVE_API_KEY: 'bsk-test' } });
    assert.equal(added.status, 202);
    const item = srv.gateQueue.get(added.body.itemId);
    assert.equal(item.summary, 'add MCP server Brave Search (brave-search, stdio)');
    assert.match(item.evidence[0].text, /npx -y @modelcontextprotocol\/server-brave-search@latest/);
    assert.equal(JSON.stringify(item).includes('bsk-test'), false);
    await srv.post(`/api/gate/${added.body.itemId}`, { decision: 'reject', notes: 'not on this machine' });
    await waitUntil(() => srv.gateQueue.get(added.body.itemId).status === 'rejected');
    assert.deepEqual((await srv.get('/api/mcp')).body, [], 'rejected: nothing configured, npx never ran');
  } finally {
    await srv.close();
  }
});
