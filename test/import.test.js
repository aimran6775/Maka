// Import from OpenClaw and Hermes homes (phase 4 step 19): the homes are read for the
// persona, the instructions, the memory and the model; the key files are never opened; the
// owner's profile stays out; every text is redacted; the Ranger is created with the mapped
// worker and its memory goes through the judge or to a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readHome, candidates, modelFromConfig, splitModel, mapModel, memoryItems, neverRead, NEVER_READ, KNOWN_HOMES } from '../sidecar/import/homes.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, end } from './helpers/fake-provider.js';

async function makeHomes() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-import-'));
  const oc = path.join(base, '.openclaw');
  await fsp.mkdir(path.join(oc, 'workspace', 'memory'), { recursive: true });
  await fsp.mkdir(path.join(oc, 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(oc, 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace: '~/.openclaw/workspace'.replace('~', base), model: 'anthropic/claude-sonnet-5-5' } }, auth: { anthropic: { apiKey: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE' } }, telegram: { token: '123456789:FAKEfakeFAKEfake' } }));
  await fsp.writeFile(path.join(oc, 'credentials.json'), '{"never": "read"}');
  await fsp.writeFile(path.join(oc, 'sessions', 'last.json'), '{"never": "read"}');
  await fsp.writeFile(path.join(oc, 'workspace', 'SOUL.md'), '# Soul\n\nYou are Pip, a careful and cheerful helper. Boundaries: never invent numbers.\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'AGENTS.md'), '# Operating instructions\n\n- Check memory before answering.\n- Keep replies short.\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'IDENTITY.md'), '# Pip\n\nname: Pip\nvibe: cheerful\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'USER.md'), 'The user is Ada Lovelace, ada@example.com, lives at 1 Analytical Lane.\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'TOOLS.md'), 'Use the ssh alias "lacie" for the drive.\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'HEARTBEAT.md'), '- check the inbox\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'MEMORY.md'), '# Facts\n\n- Etsy charges a $0.20 listing fee per item.\n- The park card is sk_live_fakeFAKE12 (never say this)\n- Always reconcile fees against the Stripe export before the close.\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'memory', '2026-10-09.md'), '# 2026-10-09\n\n- Shipped the lantern batch; breakage fell below two per cent with flat boxes.\n');
  await fsp.writeFile(path.join(oc, 'workspace', 'memory', '2026-10-10.md'), '- Supplier replies within a day; order by Thursday for a Monday delivery.\n');
  const he = path.join(base, '.hermes');
  await fsp.mkdir(path.join(he, 'memories'), { recursive: true });
  await fsp.writeFile(path.join(he, 'config.yaml'), 'model: openrouter/anthropic/claude-sonnet-5-5\nprovider: openrouter\napi_key: not-really-here\nterminal:\n  shell: zsh\n');
  await fsp.writeFile(path.join(he, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-fakeFAKEfake\n');
  await fsp.writeFile(path.join(he, 'auth.json'), '{"never": "read"}');
  await fsp.writeFile(path.join(he, 'SOUL.md'), 'You are Hermes, dry and precise.\n');
  await fsp.writeFile(path.join(he, 'memories', 'MEMORY.md'), '- The repo uses node --test, never jest.\n- Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnopqrstuvwxyz0123456789 is the token\n');
  await fsp.writeFile(path.join(he, 'memories', 'USER.md'), 'Ada, +1 555 0100.\n');
  return { base, oc, he, cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

// An fs that records every file opened, to prove the key files never are.
function spyFs(opened) {
  return {
    readFile: async (f, enc) => { opened.push(f); return fsp.readFile(f, enc); },
    stat: (f) => fsp.stat(f),
    readdir: (d) => fsp.readdir(d),
  };
}

test('pure: the never-read list, model parsing and mapping, memory items from markdown with redaction', () => {
  for (const f of ['.env', '.env.local', 'auth.json', 'credentials.json', 'id.key', 'cert.pem', 'sessions', 'state.db', 'hermes.sqlite', 'secrets.yaml', 'token.txt']) assert.ok(neverRead(f), `${f} is never read`);
  for (const f of ['SOUL.md', 'config.yaml', 'openclaw.json', 'MEMORY.md']) assert.ok(!neverRead(f), `${f} may be read`);
  assert.equal(NEVER_READ.length, 10);
  assert.deepEqual(KNOWN_HOMES.map((k) => k.kind), ['openclaw', 'hermes']);
  assert.deepEqual(splitModel('anthropic/claude-sonnet-5-5'), { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.deepEqual(splitModel('claude-opus-5-5'), { provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepEqual(splitModel('gpt-5'), { provider: null, model: 'gpt-5' });
  assert.deepEqual(modelFromConfig('{"agents":{"defaults":{"model":{"primary":"anthropic/claude-x"}}},"auth":{"apiKey":"sk-nope"}}', 'json'), { provider: 'anthropic', model: 'claude-x' });
  assert.deepEqual(modelFromConfig('{"model":"ollama/qwen2.5:7b"}', 'json'), { provider: 'ollama', model: 'qwen2.5:7b' });
  assert.equal(modelFromConfig('{"auth":{"model":"x"}}', 'json'), null, 'nothing under an auth key is read');
  assert.equal(modelFromConfig('not json', 'json'), null);
  assert.deepEqual(modelFromConfig('provider: OpenRouter\nmodel: "anthropic/claude-sonnet-5-5"\napi_key: x\n', 'yaml'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' });
  assert.deepEqual(modelFromConfig('model: gpt-5\n', 'yaml'), { provider: null, model: 'gpt-5' });
  assert.equal(modelFromConfig('terminal: zsh\n', 'yaml'), null);
  assert.deepEqual(mapModel({ provider: 'anthropic', model: 'claude-x' }), { policy: { worker: { provider: 'anthropic', model: 'claude-x' } }, warning: null });
  assert.deepEqual(mapModel({ provider: 'local', model: 'llama3' }).policy, { worker: { provider: 'ollama', model: 'llama3' } });
  assert.match(mapModel({ provider: 'openai', model: 'gpt-5' }).warning, /no Maka provider for "openai"/);
  assert.match(mapModel(null).warning, /no model named/);
  const items = memoryItems('# Facts\n\n- Etsy charges $0.20 per listing.\n- key sk_live_fakeFAKE12\n\n## Rules\nAlways reconcile fees first.\nshort\n', { source: 'MEMORY.md' });
  assert.equal(items.length, 2, 'the bare key line is dropped, the short line too');
  assert.equal(items[0].text, 'Facts: Etsy charges $0.20 per listing.');
  assert.equal(items[0].kind, 'fact');
  assert.equal(items[1].text, 'Rules: Always reconcile fees first.');
  assert.equal(items[1].kind, 'procedure');
  assert.equal(memoryItems('- a\n- b\n- c', { max: 2, source: 'x' }).length, 0, 'lines under 8 characters are not items');
  assert.equal(memoryItems('- first item here\n- second item here\n- third item here', { max: 2, source: 'x' }).length, 2);
});

test('readHome: an OpenClaw home (config for the model only, the workspace files, daily logs) and a Hermes home (config.yaml, SOUL.md, memories); the key files are never opened, the owner\'s profile is skipped, secrets are redacted', async () => {
  const h = await makeHomes();
  try {
    const opened = [];
    const oc = await readHome(h.oc, { fs: spyFs(opened) });
    assert.equal(oc.kind, 'openclaw');
    assert.equal(oc.workspace, path.join(h.base, '.openclaw', 'workspace'));
    assert.equal(oc.name, 'Pip');
    assert.match(oc.persona, /^# Soul\n\nYou are Pip, a careful and cheerful helper/);
    assert.match(oc.persona, /Operating instructions \(imported\):\n# Operating instructions/);
    assert.match(oc.persona, /Tool notes:\nUse the ssh alias "lacie"/);
    assert.ok(!/Ada Lovelace|ada@example\.com/.test(oc.persona), 'the owner\'s profile is not in the persona');
    assert.deepEqual(oc.model, { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    assert.deepEqual(oc.policy, { worker: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    assert.deepEqual(oc.memories.map((m) => m.source), ['MEMORY.md', 'MEMORY.md', 'memory/2026-10-10.md', 'memory/2026-10-09.md'], 'the line with the key is dropped whole; the newest log first');
    assert.equal(oc.memories[0].text, 'Facts: Etsy charges a $0.20 listing fee per item.');
    assert.equal(oc.memories[1].kind, 'procedure');
    assert.ok(oc.memories.every((m) => !/sk_live|card/.test(m.text)));
    assert.ok(oc.skipped.some((s) => /1 memory line\(s\) that carried a key or a token/.test(s)), JSON.stringify(oc.skipped));
    assert.deepEqual(oc.redactions, [{ kind: 'api key', count: 1 }], 'the dropped line still counts as redacted');
    assert.ok(oc.skipped.some((s) => /USER\.md/.test(s)) && oc.skipped.some((s) => /HEARTBEAT/.test(s)) && oc.skipped.some((s) => /credentials\.json/.test(s)) && oc.skipped.some((s) => /sessions/.test(s)) && oc.skipped.some((s) => /openclaw\.json \(only the model/.test(s)), JSON.stringify(oc.skipped));
    assert.deepEqual(oc.warnings, []);
    const basenames = opened.map((f) => path.relative(h.oc, f));
    assert.ok(!basenames.some((f) => /credentials|sessions|USER\.md|HEARTBEAT/.test(f)), `never opened: ${basenames.join(', ')}`);
    assert.ok(basenames.includes('openclaw.json') && basenames.includes(path.join('workspace', 'SOUL.md')));
    for (const f of oc.read) assert.ok(basenames.includes(f), `${f} was read through the fs`);
    // The same workspace given directly (no config): the kind is still told, the model unknown.
    const ws = await readHome(path.join(h.oc, 'workspace'));
    assert.equal(ws.kind, 'openclaw');
    assert.equal(ws.model, null);
    assert.match(ws.warnings[0], /no model named/);

    const opened2 = [];
    const he = await readHome(h.he, { fs: spyFs(opened2) });
    assert.equal(he.kind, 'hermes');
    assert.equal(he.name, null);
    assert.equal(he.persona, 'You are Hermes, dry and precise.');
    assert.deepEqual(he.model, { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' });
    assert.deepEqual(he.policy, { worker: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' } });
    assert.deepEqual(he.memories.map((m) => m.text), ['The repo uses node --test, never jest.']);
    assert.ok(he.skipped.some((s) => /^\.env \(never opened/.test(s)) && he.skipped.some((s) => /^auth\.json \(never opened/.test(s)) && he.skipped.some((s) => /memories\/USER\.md/.test(s)), JSON.stringify(he.skipped));
    assert.ok(!opened2.some((f) => /\.env|auth\.json|USER\.md/.test(f)), `never opened: ${opened2.join(', ')}`);
    assert.ok(he.redactions.some((r) => r.kind === 'jwt' || r.kind === 'bearer token'), JSON.stringify(he.redactions));
    assert.ok(he.skipped.some((s) => /1 memory line\(s\) that carried/.test(s)));
    assert.deepEqual(await candidates({ home: h.base }), [{ kind: 'openclaw', label: 'OpenClaw (~/.openclaw)', path: h.oc }, { kind: 'hermes', label: 'Hermes (~/.hermes)', path: h.he }]);
    assert.deepEqual(await candidates({ home: path.join(h.base, 'nowhere') }), []);
    await assert.rejects(readHome(path.join(h.base, 'nope')), /no such directory/);
    const empty = await fsp.mkdtemp(path.join(h.base, 'empty-'));
    const unknown = await readHome(empty);
    assert.equal(unknown.kind, 'unknown');
    assert.equal(unknown.persona, '');
    assert.match(unknown.warnings.join(' '), /no SOUL\.md/);
  } finally {
    await h.cleanup();
  }
});

test('over HTTP: preview, then import creates the Ranger with the persona and the worker policy, memory through the judge, the report in the import folder, the import.home event; without a judge the items go to a file', async () => {
  const h = await makeHomes();
  const judge = fakeProvider(Array(20).fill([text('{"verdict":"approve","notes":"durable"}'), end()]), { name: 'anthropic' });
  const srv = await startTestServer({ makeProvider: async (name, opts) => ({ provider: judge, model: opts.model || 'm', price: { inputPerMTok: 1, outputPerMTok: 1 } }), judgeProvider: async () => ({ provider: judge, model: 'judge', price: { inputPerMTok: 1, outputPerMTok: 1 } }), env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, importHome: h.base });
  const events = [];
  srv.bus.listen((e) => events.push(e));
  try {
    const cands = await srv.get('/api/import/candidates');
    assert.equal(cands.status, 200);
    assert.deepEqual(cands.body.map((c) => c.kind), ['openclaw', 'hermes']);
    const bad = await srv.post('/api/import/preview', {});
    assert.equal(bad.status, 400);
    const missing = await srv.post('/api/import/preview', { path: path.join(h.base, 'nope') });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'NO_HOME');
    const pv = await srv.post('/api/import/preview', { path: h.oc });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.kind, 'openclaw');
    assert.equal(pv.body.memoryCount, 4);
    assert.match(pv.body.personaPreview, /^# Soul/);
    const r = await srv.post('/api/import', { path: h.oc, specialty: 'books' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.agent.name, 'Pip');
    assert.equal(r.body.agent.specialty, 'books');
    assert.deepEqual(r.body.agent.policy, { worker: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    assert.match(r.body.agent.persona, /You are Pip/);
    assert.equal(r.body.memoriesStored.length, 4);
    assert.equal(r.body.memoriesSkipped, 0);
    const mem = await srv.get(`/api/memory?agentId=${r.body.agent.id}`);
    assert.equal(mem.status, 200);
    const items = mem.body.items || mem.body;
    assert.equal(items.length, 4);
    assert.ok(items.every((it) => it.tags.includes('imported') && it.tags.includes('openclaw') && it.by === 'superintendent'));
    const report = await fsp.readFile(path.join(srv.workspaceRoot, r.body.agent.id, 'import', 'README.md'), 'utf8');
    assert.match(report, /Imported from a openclaw home/);
    assert.match(report, /Memory: 4 item\(s\) stored through the judge, 0 not stored/);
    assert.match(report, /Keys were never transferred/);
    assert.match(report, /Redacted before anything was kept: 1 api key/);
    const ev = events.filter((e) => e.type === 'import.home').map((e) => e.payload);
    assert.deepEqual(ev, [{ kind: 'openclaw', agentId: r.body.agent.id, persona: true, instructions: true, memoriesStored: 4, memoriesSkipped: 0, model: 'anthropic/claude-sonnet-5-5', redactions: 1, skipped: ev[0].skipped }]);
    assert.ok(ev[0].skipped >= 4);
    assert.ok(events.some((e) => e.type === 'crew.agent' && e.payload.change === 'created' && e.payload.agentId === r.body.agent.id));
    const r2 = await srv.post('/api/import', { path: h.he, name: 'Herm' });
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.equal(r2.body.agent.name, 'Herm');
    assert.deepEqual(r2.body.agent.policy, { worker: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' } });
  } finally {
    await srv.close();
  }
  // No judge wired: the Ranger is created, nothing enters memory, the items go to a file.
  const plain = await startTestServer({ makeProvider: async () => { throw new Error('none'); }, importHome: h.base });
  try {
    const r = await plain.post('/api/import', { path: h.he });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.agent.name, 'Hermes Ranger');
    assert.deepEqual(r.body.memoriesStored, []);
    assert.equal(r.body.memoriesSkipped, 1);
    const file = await fsp.readFile(path.join(plain.workspaceRoot, r.body.agent.id, 'import', 'memory.md'), 'utf8');
    assert.match(file, /not stored \(no judge is wired/);
    assert.match(file, /node --test, never jest/);
    assert.ok(!/eyJhbGci/.test(file), 'the token never reaches the file');
    const none = (await plain.get(`/api/memory?agentId=${r.body.agent.id}`)).body;
    assert.equal((none.items || none).length, 0);
  } finally {
    await plain.close();
    await h.cleanup();
  }
});
