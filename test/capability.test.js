import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { validate } from '../shared/schema.js';
import { OBJECT_KINDS, LAYOUT_SCHEMA, ZONE_KINDS, AGENT_ROLES, defaultLayout, grantsFor, tileInRoom } from '../shared/world.js';
import { TOOLS, TOOL_NAMES, resolveInWorkspace, htmlToText, READ_LIMIT_BYTES, inputProblem } from '../sidecar/capability/tools.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { createNetGuard } from '../sidecar/netguard.js';
import { runLoop } from '../sidecar/loop.js';
import { fakeProvider, fakeClock, recorder, text, toolCall, end } from './helpers/fake-provider.js';

async function tmpWorkspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-ws-'));
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

function layoutWith(kinds) {
  const layout = defaultLayout();
  layout.objects = kinds.map((kind, i) => ({ id: `o${i}`, kind, roomId: 'ranger-station', x: 2 + i, y: 2 }));
  return layout;
}

test('world: default layout validates; grants derive from objects in the agent room only', async () => {
  const layout = defaultLayout();
  assert.equal(validate(LAYOUT_SCHEMA, layout).ok, true);
  assert.deepEqual(grantsFor(layout, 'ranger'), []);
  assert.deepEqual(grantsFor(layoutWith(['trailhead_sign', 'supply_cache', 'trailhead_sign']), 'ranger'), ['brief.submit', 'fs.read', 'fs.write', 'web.fetch', 'web.read', 'web.search', 'web.trends']);
  const other = layoutWith(['supply_cache']);
  other.rooms.push({ id: 'annex', name: 'Annex', x: 20, y: 1, w: 4, h: 4 });
  other.objects[0].roomId = 'annex';
  assert.deepEqual(grantsFor(other, 'ranger'), []);
  assert.deepEqual(grantsFor(other, 'nobody'), []);
  const { MAIL_TOOLS } = await import('../sidecar/capability/../mail/tools.js');
  const { BROWSER_TOOLS } = await import('../sidecar/browser/tools.js');
  const CONNECTOR_TOOL_NAMES = ['connector.status', 'connector.sync']; // the framework's own tools (sidecar/connectors/registry.js)
  const { CONNECTOR_SPECS } = await import('../sidecar/connectors/kinds.js');
  const connectorTools = Object.assign({}, ...CONNECTOR_SPECS.map((spec) => spec.tools || {}));
  const RESEARCH_TOOL_NAMES = ['web.search', 'web.read', 'web.trends', 'brief.submit']; // sidecar/research/index.js
  const { LEDGER_DESK_TOOL_NAMES } = await import('../sidecar/ledger-desk.js'); // phase 4 step 16
  const { PURCHASE_TOOL_NAMES } = await import('../sidecar/purchases.js'); // phase 4 step 17
  const { COMPUTER_TOOL_NAMES } = await import('../sidecar/computer/policy.js'); // phase 4 step 18
  const { CREATIVE_TOOL_NAMES } = await import('../sidecar/creative/index.js');
  for (const kind of Object.values(OBJECT_KINDS)) for (const t of kind.grants) assert.ok(TOOL_NAMES.includes(t) || t in MAIL_TOOLS || t in BROWSER_TOOLS || CONNECTOR_TOOL_NAMES.includes(t) || t in connectorTools || RESEARCH_TOOL_NAMES.includes(t) || LEDGER_DESK_TOOL_NAMES.includes(t) || PURCHASE_TOOL_NAMES.includes(t) || COMPUTER_TOOL_NAMES.includes(t) || CREATIVE_TOOL_NAMES.includes(t), `${t} exists`);
  assert.equal(tileInRoom(layout.rooms[0], 1, 1), true);
  assert.equal(tileInRoom(layout.rooms[0], 13, 1), false);
  const bad = layoutWith(['piano']);
  assert.equal(validate(LAYOUT_SCHEMA, bad).ok, false);
  assert.ok(ZONE_KINDS.includes('mountain_peak') && ZONE_KINDS.includes('operations_support'));
  assert.equal(layout.rooms[0].kind, 'ranger_station');
  const badKind = defaultLayout();
  badKind.rooms[0].kind = 'casino';
  assert.equal(validate(LAYOUT_SCHEMA, badKind).ok, false);
  const withRole = defaultLayout();
  withRole.agents[0].role = 'chief_ranger';
  withRole.agents[0].parentAgentId = 'superintendent';
  assert.equal(validate(LAYOUT_SCHEMA, withRole).ok, true);
  assert.deepEqual([...AGENT_ROLES], ['superintendent', 'chief_ranger', 'ranger', 'junior_ranger']);
});

test('sandbox: dotdot, absolute and symlink escapes are refused; inside paths resolve', async () => {
  const { dir, cleanup } = await tmpWorkspace();
  try {
    await fsp.mkdir(path.join(dir, 'sub'));
    await fsp.writeFile(path.join(dir, 'sub', 'ok.txt'), 'fine');
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-outside-'));
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'nope');
    await fsp.symlink(outside, path.join(dir, 'link'));
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'filelink'));

    assert.equal(await resolveInWorkspace(dir, 'sub/ok.txt'), path.join(await fsp.realpath(dir), 'sub', 'ok.txt'));
    assert.equal(await resolveInWorkspace(dir, './new/deep/file.md'), path.join(await fsp.realpath(dir), 'new', 'deep', 'file.md'));
    await assert.rejects(resolveInWorkspace(dir, '../x'), /escapes/);
    await assert.rejects(resolveInWorkspace(dir, 'sub/../../x'), /escapes/);
    await assert.rejects(resolveInWorkspace(dir, '/etc/passwd'), /escapes/);
    await assert.rejects(resolveInWorkspace(dir, 'link/secret.txt'), /escapes the workspace via a link/);
    await assert.rejects(resolveInWorkspace(dir, 'link/newfile.txt'), /via a link/);
    await assert.rejects(resolveInWorkspace(dir, 'filelink'), /via a link/);
    await assert.rejects(resolveInWorkspace(dir, ''), /required/);
    await assert.rejects(resolveInWorkspace(dir, 'a\0b'), /NUL/);
    await fsp.rm(outside, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test('fs.read and fs.write: round trip, truncation, size limit, directories', async () => {
  const { dir, cleanup } = await tmpWorkspace();
  try {
    const ctx = { workspaceDir: dir };
    const w = await TOOLS['fs.write'].run({ path: 'outbox/report.md', content: '# hi\n' }, ctx);
    assert.equal(w.ok, true);
    assert.match(w.output, /wrote 5 bytes to outbox\/report.md/);
    assert.equal(await fsp.readFile(path.join(dir, 'outbox', 'report.md'), 'utf8'), '# hi\n');
    const r = await TOOLS['fs.read'].run({ path: 'outbox/report.md' }, ctx);
    assert.deepEqual(r, { ok: true, output: '# hi\n' });
    assert.equal((await fsp.readdir(path.join(dir, 'outbox'))).length, 1, 'no temp file left behind');

    await fsp.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(READ_LIMIT_BYTES + 10));
    const big = await TOOLS['fs.read'].run({ path: 'big.txt' }, ctx);
    assert.equal(big.ok, true);
    assert.match(big.output, /\[truncated: showing 204800 of 204810 bytes\]$/);
    assert.equal(big.output.length, READ_LIMIT_BYTES + '\n[truncated: showing 204800 of 204810 bytes]'.length);

    const dirRead = await TOOLS['fs.read'].run({ path: 'outbox' }, ctx);
    assert.equal(dirRead.ok, false);
    await assert.rejects(TOOLS['fs.read'].run({ path: 'missing.txt' }, ctx), /ENOENT/);
    const tooBig = await TOOLS['fs.write'].run({ path: 'x', content: 'y'.repeat(1024 * 1024 + 1) }, ctx);
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.error, /limit/);
    assert.equal(inputProblem(TOOLS['fs.write'], { path: 'a' }), '$.content: required');
    assert.equal(inputProblem(TOOLS['fs.read'], { path: 'a', extra: 1 }), '$.extra: unexpected property');
    assert.equal(inputProblem(TOOLS['fs.read'], { path: 'a' }), null);
  } finally {
    await cleanup();
  }
});

test('web.fetch: scheme check, html to text, truncation, timeout, non-2xx, cancel', async () => {
  const calls = [];
  const netGuard = createNetGuard({ allowLocal: true }); // the made-up .test hosts never resolve; the guard has its own suite
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://slow.test')) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
    }
    if (url.startsWith('https://big.test')) return new Response('a'.repeat(600 * 1024), { headers: { 'content-type': 'text/plain' } });
    if (url.startsWith('https://missing.test')) return new Response('<h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response('<html><head><style>x{}</style><script>bad()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const ok = await TOOLS['web.fetch'].run({ url: 'https://example.test/page' }, { fetch: fetchImpl, netGuard });
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'HTTP 200 text/html; charset=utf-8\n\nTitle\nHello & welcome');
  assert.equal(calls[0].init.method, 'GET');
  const bad = await TOOLS['web.fetch'].run({ url: 'file:///etc/passwd' }, { fetch: fetchImpl, netGuard });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /only http and https/);
  assert.equal((await TOOLS['web.fetch'].run({ url: 'not a url' }, { fetch: fetchImpl, netGuard })).ok, false);
  const big = await TOOLS['web.fetch'].run({ url: 'https://big.test/' }, { fetch: fetchImpl, netGuard });
  assert.match(big.output, /\[truncated: showing 512000 of 614400 bytes\]$/);
  const slow = await TOOLS['web.fetch'].run({ url: 'https://slow.test/' }, { fetch: fetchImpl, netGuard, fetchTimeoutMs: 20 });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out after 20 ms/);
  const missing = await TOOLS['web.fetch'].run({ url: 'https://missing.test/' }, { fetch: fetchImpl, netGuard });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HTTP 404/);
  const ac = new AbortController();
  const pending = TOOLS['web.fetch'].run({ url: 'https://slow.test/' }, { fetch: fetchImpl, netGuard, signal: ac.signal, fetchTimeoutMs: 5000 });
  ac.abort();
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
});

test('gate: definitions follow the layout, ungranted tools are refused at call time, confirm flow', async () => {
  const { dir, cleanup } = await tmpWorkspace();
  try {
    let layout = layoutWith(['trailhead_sign']);
    const asks = [];
    let answer = true;
    const gate = createToolGate({ getLayout: () => layout, agentId: 'ranger', workspaceDir: dir, ask: async (q) => { asks.push(q); return answer; } });
    assert.deepEqual(gate.definitions().map((d) => d.name), ['web.fetch']);
    assert.ok(gate.definitions()[0].inputSchema.properties.url);

    const denied = await gate.execute({ id: 'c1', name: 'fs.write', input: { path: 'a.txt', content: 'x' } }, { runId: 'r' });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /not granted/);
    assert.equal(asks.length, 0, 'no prompt for an ungranted tool');

    layout = layoutWith(['trailhead_sign', 'supply_cache']);
    assert.deepEqual(gate.definitions().map((d) => d.name), ['fs.read', 'fs.write', 'web.fetch']);
    const written = await gate.execute({ id: 'c2', name: 'fs.write', input: { path: 'a.txt', content: 'x' } }, { runId: 'r' });
    assert.equal(written.ok, true);
    assert.deepEqual(asks[0], { runId: 'r', callId: 'c2', tool: 'fs.write', reason: TOOLS['fs.write'].description, input: { path: 'a.txt', content: 'x' }, leash: undefined });

    answer = false;
    const refused = await gate.execute({ id: 'c3', name: 'fs.write', input: { path: 'b.txt', content: 'y' } }, { runId: 'r' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /denied by the user/);
    await assert.rejects(fsp.stat(path.join(dir, 'b.txt')));

    const read = await gate.execute({ id: 'c4', name: 'fs.read', input: { path: 'a.txt' } }, { runId: 'r' });
    assert.deepEqual(read, { ok: true, output: 'x' });
    assert.equal(asks.length, 2, 'fs.read never prompts');

    const invalid = await gate.execute({ id: 'c5', name: 'fs.read', input: { nope: 1 } }, { runId: 'r' });
    assert.match(invalid.error, /invalid input for fs.read/);
    const unknown = await gate.execute({ id: 'c6', name: 'teleport', input: {} }, { runId: 'r' });
    assert.match(unknown.error, /unknown tool/);
    const escape = await gate.execute({ id: 'c7', name: 'fs.read', input: { path: '../../etc/passwd' } }, { runId: 'r' });
    assert.equal(escape.ok, false);
    assert.match(escape.error, /escapes/);

    const noAsk = createToolGate({ getLayout: () => layout, agentId: 'ranger', workspaceDir: dir });
    const noChannel = await noAsk.execute({ id: 'c8', name: 'fs.write', input: { path: 'c.txt', content: 'z' } }, {});
    assert.match(noChannel.error, /no prompt channel/);
    assert.throws(() => createToolGate({ agentId: 'x', workspaceDir: dir }), TypeError);
  } finally {
    await cleanup();
  }
});

test('gate through the loop: the model only sees granted tools and an ungranted call still gets a result', async () => {
  const { dir, cleanup } = await tmpWorkspace();
  try {
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'remember the milk');
    const layout = layoutWith(['supply_cache']);
    const gate = createToolGate({ getLayout: () => layout, agentId: 'ranger', workspaceDir: dir });
    const provider = fakeProvider([
      [...toolCall('c1', 'fs.read', { path: 'notes.txt' }, 0), ...toolCall('c2', 'web.fetch', { url: 'https://example.test/' }, 1), end('tool_use')],
      [text('done'), end()],
    ]);
    const rec = recorder();
    const out = await runLoop({ runId: 'r', agentId: 'ranger', provider, model: 'm', prompt: 'go', tools: gate, emit: rec.emit, clock: fakeClock() });
    assert.equal(out.reason, 'completed');
    assert.deepEqual(rec.ofType('agent.run.start')[0].payload.tools, ['fs.read', 'fs.write']);
    assert.deepEqual(provider.requests[0].tools.map((t) => t.name), ['fs.read', 'fs.write']);
    const results = rec.ofType('agent.tool_result').map((e) => e.payload);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].output, 'remember the milk');
    assert.equal(results[1].ok, false);
    assert.match(results[1].error, /not granted/);
  } finally {
    await cleanup();
  }
});
