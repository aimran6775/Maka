import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createLeashState } from '../sidecar/leash-ledger.js';
import { createAgents, personaLines, PEAK_ROOM_ID, CHIEF_ID } from '../sidecar/agents.js';
import { createToolGate } from '../sidecar/capability/gate.js';
import { TOOLS } from '../sidecar/capability/tools.js';
import { CREW_TOOLS } from '../sidecar/capability/crew.js';
import { defaultLayout, allGrantsFor, roleGrants, freeTile, childrenOf, SPECIALTIES, PARENT_ROLES, LAYOUT_SCHEMA } from '../shared/world.js';
import { defaultLeash, resolveLeash } from '../shared/leash.js';
import { validate } from '../shared/schema.js';
import { fakeClock } from './helpers/fake-provider.js';

async function setup({ layout = defaultLayout() } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-agents-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layoutState = createLayoutState({ initial: layout, store, bus, clock });
  const leashState = createLeashState({ initial: defaultLeash(), store });
  let active = null;
  const agents = createAgents({ layoutState, leashState, bus, clock, activeRunFor: (id) => (active === id ? { runId: 'r' } : null) });
  return { dir, store, bus, events, layoutState, leashState, agents, setActive: (id) => (active = id), cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('world data: parent roles, role grants, specialties, free tiles, layout fields are additive', () => {
  assert.deepEqual(PARENT_ROLES.junior_ranger, ['ranger']);
  assert.deepEqual(roleGrants('ranger'), ['crew.spawn_junior', 'delegate', 'work.check', 'memory.recall', 'memory.write', 'recipe.run']);
  assert.deepEqual(roleGrants('junior_ranger'), ['memory.recall']);
  assert.deepEqual(roleGrants('nobody'), []);
  for (const s of Object.values(SPECIALTIES)) assert.ok(s.persona.length > 20 && s.zoneKind);
  const layout = defaultLayout();
  assert.deepEqual(freeTile(layout, layout.rooms[0]), { x: 1, y: 1 });
  layout.objects.push({ id: 'o', kind: 'supply_cache', roomId: 'ranger-station', x: 1, y: 1 });
  assert.deepEqual(freeTile(layout, layout.rooms[0]), { x: 2, y: 1 });
  assert.deepEqual(freeTile(layout, { id: 'tiny', name: 't', x: 1, y: 1, w: 1, h: 1 }), null);
  layout.agents[0].specialty = 'scout';
  layout.agents[0].persona = 'p';
  layout.agents[0].venture = 'Lantern Co';
  layout.agents[0].policy = { worker: { provider: 'ollama', model: 'qwen2.5:7b' } };
  assert.equal(validate(LAYOUT_SCHEMA, layout).ok, true);
  layout.agents[0].specialty = 'wizard';
  assert.equal(validate(LAYOUT_SCHEMA, layout).ok, false);
  assert.deepEqual(allGrantsFor({ ...defaultLayout(), objects: [{ id: 'o', kind: 'trailhead_sign', roomId: 'ranger-station', x: 1, y: 1 }] }, 'ranger'), ['brief.submit', 'crew.spawn_junior', 'delegate', 'memory.recall', 'memory.write', 'recipe.run', 'web.fetch', 'web.read', 'web.search', 'web.trends', 'work.check']);
  assert.deepEqual(childrenOf(defaultLayout(), 'ranger'), []);
});

test('agents: create / get / update / remove with the hierarchy rules, Chief singleton at the Peak, events and persistence', async () => {
  const h = await setup();
  try {
    assert.equal(h.agents.list().length, 1);
    assert.equal(h.agents.list()[0].role, 'ranger');
    assert.deepEqual(h.agents.list()[0].grants, ['crew.spawn_junior', 'delegate', 'memory.recall', 'memory.write', 'recipe.run', 'work.check']);
    await assert.rejects(h.agents.create({ name: 'X', role: 'superintendent', zoneId: 'ranger-station' }), /role must be one of/);
    await assert.rejects(h.agents.create({ name: '', role: 'ranger', zoneId: 'ranger-station' }), /name is required/);
    await assert.rejects(h.agents.create({ name: 'X', zoneId: 'nowhere' }), /unknown zone/);
    await assert.rejects(h.agents.create({ name: 'J', role: 'junior_ranger', zoneId: 'ranger-station' }), /needs a parentAgentId/);
    await assert.rejects(h.agents.create({ name: 'X', zoneId: 'ranger-station', parentAgentId: 'ghost' }), /unknown parent/);
    await assert.rejects(h.agents.create({ name: 'X', zoneId: 'ranger-station', specialty: 'wizard' }), /specialty must be/);

    // The Chief: singleton, created at the Peak (room made on demand).
    const chief = await h.agents.ensureChief();
    assert.equal(chief.id, CHIEF_ID);
    assert.equal(chief.roomId, PEAK_ROOM_ID);
    assert.equal(chief.zone.kind, 'mountain_peak');
    assert.equal(chief.parentAgentId, 'superintendent');
    assert.equal((await h.agents.ensureChief()).id, CHIEF_ID, 'idempotent');
    await assert.rejects(h.agents.create({ name: 'Second', role: 'chief_ranger' }), /one Chief/);
    await assert.rejects(h.agents.create({ name: 'Trespasser', role: 'ranger', zoneId: PEAK_ROOM_ID }), /only the Chief Ranger sits at the Mountain Peak/);
    assert.equal(h.layoutState.get().rooms.find((r) => r.id === PEAK_ROOM_ID).kind, 'mountain_peak');
    assert.equal(validate(LAYOUT_SCHEMA, h.layoutState.get()).ok, true);

    // A Ranger under the Chief with a specialty gets the specialty persona by default.
    const scout = await h.agents.create({ name: 'Scout', zoneId: 'ranger-station', parentAgentId: CHIEF_ID, specialty: 'scout', venture: 'Lantern Co' }, { by: CHIEF_ID });
    assert.match(scout.id, /^scout-[a-f0-9]{6}$/);
    assert.equal(scout.persona, SPECIALTIES.scout.persona);
    assert.equal(scout.createdBy, CHIEF_ID);
    assert.deepEqual([scout.x, scout.y], [1, 1], 'first free tile');
    assert.equal(scout.leash.money_out.level, 'draft');
    const created = h.events.filter((e) => e.type === 'crew.agent');
    assert.equal(created.length, 2);
    assert.deepEqual(created[1].payload.agent.id, scout.id);
    assert.equal(created[1].payload.by, CHIEF_ID);

    // Juniors: one hop below a Ranger only.
    const junior = await h.agents.create({ name: 'Drafter', role: 'junior_ranger', zoneId: 'ranger-station', parentAgentId: scout.id, persona: 'draft listings' }, { by: scout.id });
    assert.equal(junior.parentAgentId, scout.id);
    assert.deepEqual(junior.grants, ['memory.recall'], 'juniors read their crew\'s memory and nothing else by role');
    await assert.rejects(h.agents.create({ name: 'Deeper', role: 'junior_ranger', zoneId: 'ranger-station', parentAgentId: junior.id }), (e) => e.code === 'DEPTH' && /one hop deep/.test(e.message));
    await assert.rejects(h.agents.create({ name: 'Odd', role: 'junior_ranger', zoneId: 'ranger-station', parentAgentId: CHIEF_ID }), /cannot report to a chief_ranger/);
    await assert.rejects(h.agents.create({ name: 'Odd', role: 'ranger', zoneId: 'ranger-station', parentAgentId: junior.id }), /cannot report to a junior_ranger/);
    assert.deepEqual(h.agents.get(scout.id).reports, [junior.id]);

    // Update: name, venture, persona, policy, leash override, zone move, parent change; role is fixed.
    const upd = await h.agents.update(scout.id, { name: 'Scout Ada', venture: 'Candle Co', policy: { worker: { provider: 'ollama', model: 'qwen2.5:7b' } }, leash: { domains: { publishing: { level: 'act_capped', dailyCapActions: 5 } } } });
    assert.equal(upd.name, 'Scout Ada');
    assert.equal(upd.venture, 'Candle Co');
    assert.deepEqual(upd.policy, { worker: { provider: 'ollama', model: 'qwen2.5:7b' } });
    assert.deepEqual(upd.leash.publishing, { domain: 'publishing', level: 'act_capped', dailyCapUsd: null, dailyCapActions: 5, scope: 'agent' });
    assert.equal(resolveLeash(h.leashState.get(), { agentId: scout.id }, 'publishing').level, 'act_capped');
    await h.agents.update(scout.id, { leash: { domains: { publishing: null } } });
    assert.deepEqual(h.agents.get(scout.id).leashOverrides, {});
    await assert.rejects(h.agents.update(scout.id, { role: 'chief_ranger' }), /cannot change/);
    await assert.rejects(h.agents.update(scout.id, { zoneId: PEAK_ROOM_ID }), /only the Chief Ranger/);
    await assert.rejects(h.agents.update(scout.id, { leash: { domains: { piloting: { level: 'draft' } } } }), /unknown leash domain/);
    await assert.rejects(h.agents.update(junior.id, { parentAgentId: null }), /keeps a parent/);
    await assert.rejects(h.agents.update('ghost', { name: 'x' }), (e) => e.status === 404);
    await h.layoutState.replace({ ...h.layoutState.get(), rooms: [...h.layoutState.get().rooms, { id: 'research', name: 'Research', kind: 'research', x: 20, y: 1, w: 4, h: 4 }] });
    const moved = await h.agents.update(scout.id, { zoneId: 'research' });
    assert.equal(moved.roomId, 'research');
    assert.deepEqual([moved.x, moved.y], [20, 1]);
    await assert.rejects(h.agents.update(scout.id, { x: 99 }), /outside the zone/);
    assert.equal((await h.agents.update(scout.id, { x: 21, y: 2 })).x, 21);
    assert.equal(h.events.filter((e) => e.type === 'crew.agent' && e.payload.change === 'updated').length, 4);

    // Remove: not with reports, not while running, never the last agent.
    await assert.rejects(h.agents.remove(scout.id), /has reports/);
    h.setActive(junior.id);
    await assert.rejects(h.agents.remove(junior.id), /run in progress/);
    h.setActive(null);
    assert.deepEqual(await h.agents.remove(junior.id), { removed: junior.id });
    assert.equal(h.events.at(-1).payload.change, 'removed');
    await h.agents.update(scout.id, { leash: { domains: { money_in: { level: 'observe' } } } });
    await h.agents.remove(scout.id);
    assert.equal(h.leashState.get().agents[scout.id], undefined, 'override removed with the agent');
    await h.agents.remove(CHIEF_ID);
    await assert.rejects(h.agents.remove('ranger'), /at least one Ranger/);
    await assert.rejects(h.agents.remove('ghost'), (e) => e.status === 404);

    // Persisted: the layout on disk has the Peak room.
    const onDisk = JSON.parse(await fsp.readFile(path.join(h.dir, 'layout.json'), 'utf8'));
    assert.ok(onDisk.rooms.some((r) => r.kind === 'mountain_peak'));
    assert.equal(onDisk.agents.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('crew.spawn_junior: a Ranger creates a Junior through the gate; a Junior does not see the tool; personas reach the system prompt', async () => {
  const h = await setup();
  try {
    const registry = { ...TOOLS, ...CREW_TOOLS };
    const gate = createToolGate({ getLayout: h.layoutState.get, agentId: 'ranger', workspaceDir: h.dir, registry, grants: allGrantsFor, toolContext: { agents: h.agents }, leash: defaultLeash() });
    assert.deepEqual(gate.definitions().map((d) => d.name), ['crew.spawn_junior', 'delegate', 'work.check']);
    const r = await gate.execute({ id: 'c1', name: 'crew.spawn_junior', input: { name: 'Lister', persona: 'write listing drafts', venture: 'Lantern Co' } }, { runId: 'r', turn: 1 });
    assert.equal(r.ok, true);
    const out = JSON.parse(r.output);
    assert.equal(out.parentAgentId, 'ranger');
    assert.equal(out.zone, 'ranger-station');
    const junior = h.agents.get(out.agentId);
    assert.equal(junior.role, 'junior_ranger');
    assert.equal(junior.venture, 'Lantern Co');
    assert.equal(junior.createdBy, 'ranger');
    const juniorGate = createToolGate({ getLayout: h.layoutState.get, agentId: out.agentId, workspaceDir: h.dir, registry, grants: allGrantsFor, toolContext: { agents: h.agents }, leash: defaultLeash() });
    assert.deepEqual(juniorGate.definitions(), []);
    const refused = await juniorGate.execute({ id: 'c2', name: 'crew.spawn_junior', input: { name: 'Deeper', persona: 'x' } }, { runId: 'r' });
    assert.match(refused.error, /not granted/);
    const noRegistry = createToolGate({ getLayout: h.layoutState.get, agentId: 'ranger', workspaceDir: h.dir, registry, grants: allGrantsFor, leash: defaultLeash() });
    assert.match((await noRegistry.execute({ id: 'c3', name: 'crew.spawn_junior', input: { name: 'N', persona: 'x' } }, {})).error, /no agents registry/);
    assert.deepEqual(personaLines(junior), [`You are a Junior Ranger on a bounded subtask for ranger; you cannot delegate further.`, 'write listing drafts', 'Your venture: Lantern Co.']);
    assert.deepEqual(personaLines({ id: 'c', role: 'chief_ranger' })[0].slice(0, 29), 'You are the Chief Ranger at t');
    assert.deepEqual(personaLines(null), []);
  } finally {
    await h.cleanup();
  }
});
