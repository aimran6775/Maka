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
import { defaultLayout, allGrantsFor, roleGrants, freeTile, childrenOf, SPECIALTIES, SPECIALTY_NAMES, PARENT_ROLES, LAYOUT_SCHEMA, ZONE_KINDS, ZONE_LABELS, DEPARTMENT_KINDS, departments, departmentOf, departmentOfAgent, specialtiesOf, isDepartmentKind } from '../shared/world.js';
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
  assert.deepEqual(roleGrants('ranger'), ['crew.spawn_junior', 'delegate', 'work.check', 'memory.recall', 'memory.write', 'recipe.run', 'dept.directory', 'dept.request', 'venture.propose', 'venture.list']);
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
  assert.deepEqual(allGrantsFor({ ...defaultLayout(), objects: [{ id: 'o', kind: 'trailhead_sign', roomId: 'ranger-station', x: 1, y: 1 }] }, 'ranger'), ['brief.submit', 'crew.spawn_junior', 'delegate', 'dept.directory', 'dept.request', 'memory.recall', 'memory.write', 'recipe.run', 'venture.list', 'venture.propose', 'web.fetch', 'web.read', 'web.search', 'web.trends', 'work.check']);
  assert.deepEqual(childrenOf(defaultLayout(), 'ranger'), []);
});

test('agents: create / get / update / remove with the hierarchy rules, Chief singleton at the Peak, events and persistence', async () => {
  const h = await setup();
  try {
    assert.equal(h.agents.list().length, 1);
    assert.equal(h.agents.list()[0].role, 'ranger');
    assert.deepEqual(h.agents.list()[0].grants, ['crew.spawn_junior', 'delegate', 'dept.directory', 'dept.request', 'memory.recall', 'memory.write', 'recipe.run', 'venture.list', 'venture.propose', 'work.check']);
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
    await h.layoutState.replace({ ...h.layoutState.get(), rooms: [...h.layoutState.get().rooms, { id: 'research', name: 'Research', kind: 'research', x: 40, y: 20, w: 4, h: 4 }] });
    const moved = await h.agents.update(scout.id, { zoneId: 'research' });
    assert.equal(moved.roomId, 'research');
    assert.deepEqual([moved.x, moved.y], [40, 20]);
    await assert.rejects(h.agents.update(scout.id, { x: 99 }), /outside the zone/);
    assert.equal((await h.agents.update(scout.id, { x: 41, y: 21 })).x, 41);
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
    assert.deepEqual(gate.definitions().map((d) => d.name), ['crew.spawn_junior', 'delegate', 'dept.directory', 'dept.request', 'work.check']);
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

// D177: a zone used to be created bare, so a Ranger hired into a department camp held role
// grants and nothing else. That is why the first venture's market research failed four
// times: no agent in the park had `web.fetch` at all, and the Scout had no way to know
// that — the weak worker invented a fetch result, and a capable one correctly reported
// that the tool was not in its function list.
test('a new zone is born with its own kit, so a Ranger hired into it can do that department\'s work', async () => {
  const h = await setup();
  try {
    const research = await h.agents.ensureZone('research');
    const scout = await h.agents.create({ name: 'Scout', role: 'ranger', zoneId: research.id, specialty: 'scout', parentAgentId: 'superintendent' }, { by: 'superintendent' });

    // The whole point: the research kit is reachable from the Research Camp.
    const grants = h.agents.get(scout.id).grants;
    for (const t of ['web.fetch', 'web.search', 'web.read', 'web.trends', 'brief.submit']) {
      assert.ok(grants.includes(t), `a Scout in the Research Camp needs ${t}`);
    }
    // And it can still write its brief.
    assert.ok(grants.includes('fs.write'));

    // Each fixture is announced, because the park shows only what happened.
    const placements = h.events.filter((e) => e.type === 'object.place' && e.payload.roomId === research.id);
    assert.deepEqual(placements.map((e) => e.payload.kind).sort(), ['supply_cache', 'trailhead_sign']);
    // Two fixtures, two tiles: a kit may not stack on one square.
    const tiles = new Set(placements.map((e) => `${e.payload.x},${e.payload.y}`));
    assert.equal(tiles.size, placements.length, 'each fixture gets its own tile');
    for (const e of placements) {
      assert.ok(e.payload.x >= research.x && e.payload.x < research.x + research.w, 'inside the room');
      assert.ok(e.payload.y >= research.y && e.payload.y < research.y + research.h, 'inside the room');
    }

    // The Finance camp gets the read-only books desk; a Marketing camp gets neither it nor
    // any connector fixture, because those move money or publish and stay the
    // Superintendent's to place.
    const finance = await h.agents.ensureZone('finance');
    const books = await h.agents.create({ name: 'Books', role: 'ranger', zoneId: finance.id, specialty: 'books', parentAgentId: 'superintendent' }, { by: 'superintendent' });
    assert.ok(h.agents.get(books.id).grants.includes('ledger.read'));

    const marketing = await h.agents.ensureZone('marketing');
    const ads = await h.agents.create({ name: 'Ads', role: 'ranger', zoneId: marketing.id, specialty: 'marketing', parentAgentId: 'superintendent' }, { by: 'superintendent' });
    const adGrants = h.agents.get(ads.id).grants;
    assert.ok(adGrants.includes('fs.write'), 'it can still write deliverables');
    for (const t of ['meta_ads.create_campaign', 'google_ads.set_budget', 'stripe.refund', 'mail.send', 'shopify.set_price', 'computer.click']) {
      assert.ok(!adGrants.includes(t), `${t} is never granted by the park itself`);
    }

    // Asking for a zone that exists returns it and places nothing new: a zone the owner
    // has curated is not quietly refitted.
    const before = h.agents.get(scout.id).grants.length;
    const again = await h.agents.ensureZone('research');
    assert.equal(again.id, research.id);
    assert.equal(h.agents.get(scout.id).grants.length, before, 'no second kit');
  } finally {
    await h.cleanup();
  }
});

// D178: the park replicates a company, so every team has a department and every department
// is a real place with a head and a staff. The list is derived from SPECIALTIES so it can
// never drift from the teams that actually exist.
test('every team has a department, every department has a camp and a label, and the list is derived not copied', () => {
  // Nothing homes in a zone kind without being a department, and no team is homeless.
  for (const n of SPECIALTY_NAMES) {
    const kind = SPECIALTIES[n].zoneKind;
    assert.ok(ZONE_KINDS.includes(kind), `${n} wants zone kind "${kind}" which is not a zone kind`);
    assert.ok(ZONE_LABELS[kind], `${kind} has no display label`);
    assert.ok(isDepartmentKind(kind), `${kind} houses ${n} so it is a department`);
    assert.ok(specialtiesOf(kind).includes(n));
  }
  // The infrastructure of the park is not a department: no team lives at the Peak.
  for (const kind of ['ranger_station', 'entrance_gate', 'mountain_peak', 'visitor_center', 'trailhead']) {
    assert.ok(ZONE_KINDS.includes(kind));
    assert.equal(isDepartmentKind(kind), false, `${kind} is not a department`);
  }
  assert.equal(departmentOf(layoutOf([]), 'mountain_peak'), null, 'and asking for one answers nothing');

  // One camp can house more than one team: Ads and Marketing share the Marketing Camp.
  assert.deepEqual(specialtiesOf('marketing'), ['ads', 'marketing']);
  // Every department kind is distinct and every one is reachable from a specialty.
  assert.equal(new Set(DEPARTMENT_KINDS).size, DEPARTMENT_KINDS.length);
  for (const k of DEPARTMENT_KINDS) assert.ok(specialtiesOf(k).length > 0, `${k} has no team`);
  // The five departments D178 added, by name, so a rename or a loss is caught here.
  for (const k of ['sales', 'people', 'business', 'legal', 'infrastructure']) {
    assert.ok(DEPARTMENT_KINDS.includes(k), `${k} is missing`);
  }
});

function layoutOf(rooms, agents = []) {
  return { ...defaultLayout(), rooms, objects: [], agents };
}

test('a department reads its camp, head and staff off the layout, and a camp that was never built reads as absent', () => {
  // A department whose camp does not exist is absent, not empty: the difference matters,
  // because "no camp" and "a camp with nobody in it" call for different answers.
  const bare = departmentOf(layoutOf([]), 'finance');
  assert.equal(bare.roomId, null);
  assert.equal(bare.head, null);
  assert.deepEqual(bare.staff, []);
  assert.equal(bare.label, 'Finance Camp');

  const rooms = [{ id: 'finance', kind: 'finance', x: 1, y: 1, w: 6, h: 6 }];
  const agents = [
    { id: 'books-head', name: 'Head', role: 'ranger', roomId: 'finance', specialty: 'books', head: true, x: 1, y: 1 },
    { id: 'books-2', name: 'Two', role: 'ranger', roomId: 'finance', specialty: 'books', x: 2, y: 1 },
    { id: 'junior', name: 'J', role: 'junior_ranger', roomId: 'finance', parentAgentId: 'books-head', x: 3, y: 1 },
    { id: 'elsewhere', name: 'E', role: 'ranger', roomId: 'research', x: 4, y: 1 },
  ];
  const d = departmentOf(layoutOf(rooms, agents), 'finance');
  assert.equal(d.roomId, 'finance');
  assert.equal(d.head, 'books-head');
  assert.deepEqual(d.staff.sort(), ['books-2', 'junior'], 'everyone in the camp but the head');
  assert.ok(!d.staff.includes('elsewhere'), 'a Ranger in another camp is not this team');

  // Only a Ranger heads a department. A Junior flagged as head is ignored, because a team
  // reporting to a Junior would report to someone who cannot hold its work.
  const juniorHead = departmentOf(layoutOf(rooms, [{ id: 'j', role: 'junior_ranger', roomId: 'finance', head: true, x: 1, y: 1 }]), 'finance');
  assert.equal(juniorHead.head, null);
  assert.deepEqual(juniorHead.staff, ['j'], 'it is still staff');

  // An agent knows its own department, and the Chief at the Peak has none.
  const l = layoutOf([...rooms, { id: 'mountain-peak', kind: 'mountain_peak', x: 20, y: 1, w: 4, h: 4 }], [...agents, { id: 'chief-ranger', role: 'chief_ranger', roomId: 'mountain-peak', x: 20, y: 1 }]);
  assert.equal(departmentOfAgent(l, 'books-2').kind, 'finance');
  assert.equal(departmentOfAgent(l, 'chief-ranger'), null, 'the Chief serves every department and heads none');
  assert.equal(departmentOfAgent(l, 'nobody'), null);

  // departments() answers for all ten whether or not their camps are built.
  const all = departments(l);
  assert.equal(all.length, DEPARTMENT_KINDS.length);
  assert.equal(all.filter((x) => x.roomId).length, 1, 'only Finance is built in this layout');
});

test('the head flag is an optional boolean the layout schema accepts', () => {
  const l = defaultLayout();
  const withHead = { ...l, agents: l.agents.map((a) => ({ ...a, head: true })) };
  assert.equal(validate(LAYOUT_SCHEMA, withHead).ok, true);
  assert.equal(validate(LAYOUT_SCHEMA, l).ok, true, 'and absent is still valid');
  const bad = { ...l, agents: l.agents.map((a) => ({ ...a, head: 'yes' })) };
  assert.equal(validate(LAYOUT_SCHEMA, bad).ok, false, 'but not a string');
});
