import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, hash2, newSeed } from '../frontend/park/random.js';
import { heightAt, fbm, isWater, riverCenterZ, TERRAIN } from '../frontend/park/terrain.js';
import { catmullRom, arcLengthTable, pointAtFraction, trailBetween } from '../frontend/park/spline.js';
import { buildParkModel, clearingsFor, trailsFor, scatterFoliage, zoneCenter, tileToWorld } from '../frontend/park/placement.js';
import { clipFor, placeFor, badgeFor, WALK_SPEED, STATE_CLIPS } from '../frontend/park/clips.js';
import { sunFor } from '../frontend/park/sun.js';
import { defaultLayout } from '../shared/world.js';
import { AGENT_STATES } from '../frontend/state.js';

test('random: deterministic streams and hashes, seeds never zero', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
  assert.notEqual(mulberry32(43)(), seqA[0]);
  assert.equal(hash2(3, 4, 5), hash2(3, 4, 5));
  assert.notEqual(hash2(3, 4, 5), hash2(4, 3, 5));
  for (let i = 0; i < 20; i++) assert.ok(newSeed() > 0);
  assert.equal(newSeed(() => 0), 1);
});

test('terrain: same seed same heights, bounded, flattened in clearings, lowered at the river', () => {
  const seed = 1234;
  assert.equal(heightAt(10.5, -3.25, seed), heightAt(10.5, -3.25, seed));
  assert.notEqual(heightAt(10.5, -3.25, seed), heightAt(10.5, -3.25, seed + 1));
  for (let i = 0; i < 200; i++) {
    const x = (hash2(i, 1, 9) * 2 - 1) * 100;
    const z = (hash2(i, 2, 9) * 2 - 1) * 100;
    const h = heightAt(x, z, seed);
    assert.ok(Number.isFinite(h) && Math.abs(h) < TERRAIN.amplitude + 45, `${x},${z} -> ${h}`);
    assert.ok(Math.abs(fbm(x, z, seed)) <= 1);
  }
  const c = { x: 20, z: 15, radius: 10, height: 3 };
  assert.ok(Math.abs(heightAt(21, 16, seed, [c]) - 3) < 1e-9, 'flat inside');
  assert.ok(Math.abs(heightAt(20 + 9.9, 15, seed, [c]) - 3) < 1e-9, 'flat to the radius');
  const rz = riverCenterZ(0, seed);
  assert.ok(isWater(0, rz, seed));
  assert.ok(!isWater(0, rz + 30, seed));
  assert.ok(heightAt(0, rz, seed) < TERRAIN.waterLevel, 'river bed is below water');
  const edge = heightAt(TERRAIN.size / 2 - 2, 0, 999);
  assert.ok(edge > TERRAIN.amplitude, 'ridgeline at the edge');
});

test('spline: endpoints exact, arc length monotonic, constant-speed sampling', () => {
  const pts = [{ x: 0, z: 0 }, { x: 10, z: 5 }, { x: 20, z: 0 }];
  assert.deepEqual(catmullRom(pts, 0), { x: 0, z: 0 });
  assert.deepEqual(catmullRom(pts, 1), { x: 20, z: 0 });
  const table = arcLengthTable(pts, 32);
  for (let i = 1; i < table.samples.length; i++) assert.ok(table.samples[i].dist >= table.samples[i - 1].dist);
  assert.ok(table.length > 20 && table.length < 30);
  const half = pointAtFraction(table, 0.5);
  assert.ok(Math.abs(half.x - 10) < 1.5);
  assert.deepEqual([pointAtFraction(table, 0).x, pointAtFraction(table, 1).x], [0, 20]);
  assert.ok(Number.isFinite(half.heading));
  assert.equal(pointAtFraction(table, 2).x, 20, 'clamped');
  const tr = trailBetween({ x: 0, z: 0 }, { x: 10, z: 0 }, 0.5);
  assert.equal(tr.length, 3);
  assert.equal(tr[1].z, 5, 'bowed sideways');
  assert.deepEqual(catmullRom([], 0.5), { x: 0, z: 0 });
  assert.deepEqual(catmullRom([{ x: 1, z: 2 }], 0.5), { x: 1, z: 2 });
});

test('placement: default layout gives one zone clearing, a gate clearing, one trail, scattered foliage off clearings and trails', () => {
  const layout = { ...defaultLayout(), seed: 77 };
  const model = buildParkModel(layout);
  assert.equal(model.clearings.length, 3);
  assert.equal(model.clearings[0].id, 'ranger-station');
  assert.equal(model.clearings[1].kind, 'gate');
  assert.ok(model.clearings[1].z > model.clearings[0].z, 'gate is south of the station');
  const peak = model.clearings[2];
  assert.equal(peak.kind, 'peak');
  assert.ok(peak.height > model.clearings[0].height + 15, 'the Peak is a visible high point');
  assert.ok(Math.abs(model.heightAt(peak.x + 2, peak.z - 2) - peak.height) < 1e-6, 'flat on top');
  assert.ok(model.heightAt(peak.x + peak.radius * 3, peak.z) > model.clearings[0].height, 'ground rises toward the Peak');
  assert.equal(model.trails.length, 2);
  assert.equal(model.trails[0].from, 'ranger-station');
  assert.equal(model.trails[1].to, 'mountain-peak');
  assert.equal(model.visitorCenter, null);
  assert.ok(model.trails[0].table.length > 20);
  assert.ok(model.foliage.filter((f) => f.kind === 'tree').length > 300);
  assert.ok(model.foliage.filter((f) => f.kind === 'rock').length > 50);
  for (const f of model.foliage) {
    for (const c of model.clearings) assert.ok(Math.hypot(c.x - f.x, c.z - f.z) >= c.radius, 'foliage stays out of clearings');
    assert.ok(Number.isFinite(f.y));
  }
  assert.equal(model.agents[0].id, 'ranger');
  assert.ok(Math.abs(model.agents[0].home.y - model.clearings[0].height) < 1e-6, 'the Ranger stands on the clearing plateau');
  // Deterministic.
  const again = buildParkModel(layout);
  assert.deepEqual(again.foliage.slice(0, 5), model.foliage.slice(0, 5));
  const other = buildParkModel({ ...layout, seed: 78 });
  assert.notDeepEqual(other.foliage.slice(0, 5), model.foliage.slice(0, 5));
  // Zones map from tiles.
  assert.deepEqual(zoneCenter({ x: 6, y: 6, w: 2, h: 2 }), { x: 0, z: 0 });
  assert.deepEqual(tileToWorld(7, 7), { x: 2, z: 2 });
  // A second zone adds a spoke from the station hub.
  const two = { ...layout, rooms: [...layout.rooms, { id: 'camp', name: 'Campground', x: 20, y: 1, w: 6, h: 6 }] };
  assert.equal(trailsFor(clearingsFor(two)).length, 3);
  assert.deepEqual(trailsFor(clearingsFor(two)).map((t) => [t.from, t.to]), [['ranger-station', 'gate:ranger-station'], ['ranger-station', 'mountain-peak'], ['ranger-station', 'camp']]);
  assert.ok(scatterFoliage(layout, model.clearings, model.trails, { trees: 10, rocks: 2 }).length <= 12);
});

test('clips: every agent state has a clip; walking overrides; placement follows state and handoffs', () => {
  for (const st of AGENT_STATES) assert.ok(STATE_CLIPS[st], st);
  assert.equal(clipFor('tool-running', false), 'work');
  assert.equal(clipFor('error', false), 'error');
  assert.equal(clipFor('idle', true), 'walk');
  assert.equal(clipFor('mystery', false), 'idle');
  const home = { x: 1, z: 2 };
  const gate = { x: 5, z: 40 };
  assert.deepEqual(placeFor({ agentState: 'idle', home, gate }), { x: 1, z: 2, heading: 0, walking: false, fraction: 1, leg: 'home' });
  assert.equal(placeFor({ agentState: 'waiting', home, gate }).z, 40);
  const pts = [{ x: 0, z: 0 }, { x: 5, z: 1 }, { x: 10, z: 0 }];
  const trail = { table: arcLengthTable(pts, 16) };
  const startedAt = 1000;
  const mid = placeFor({ agentState: 'idle', home, gate, handoff: { trail, startedAt }, now: startedAt + ((trail.table.length / 2) / WALK_SPEED) * 1000, pointAtFraction });
  assert.ok(mid.walking);
  assert.ok(mid.x > 3 && mid.x < 7);
  const end = placeFor({ agentState: 'idle', home, gate, handoff: { trail, startedAt }, now: startedAt + 60000, pointAtFraction });
  assert.equal(end.walking, false);
  assert.equal(end.leg, 'home', 'a finished handoff walk ends at home (the route ends in the Ranger\'s own zone)');
  assert.equal(end.x, home.x);
  assert.equal(badgeFor('waiting'), 'gate');
  assert.equal(badgeFor('idle'), null);
});

test('sun: rises in the east, high at noon, below the horizon at night, always unit length', () => {
  const at = (h) => sunFor(new Date(2026, 5, 1, h, 0, 0));
  const noon = at(12);
  const morning = at(8);
  const night = at(2);
  assert.ok(noon.direction.y > morning.direction.y);
  assert.ok(night.direction.y < 0 && night.night);
  assert.ok(morning.direction.x > at(16).direction.x, 'moves east to west');
  for (const h of [0, 6, 9, 12, 15, 18, 21]) {
    const d = at(h).direction;
    assert.ok(Math.abs(Math.hypot(d.x, d.y, d.z) - 1) < 1e-9);
    assert.ok(at(h).intensity > 0);
  }
  assert.equal(at(7).color, 0xffb070, 'warm light at dawn');
});

test('a mountain_peak room is the Peak clearing (no duplicate), and its agents stand on the Peak', async () => {
  const { buildParkModel } = await import('../frontend/park/placement.js');
  const layout = defaultLayout();
  layout.rooms.push({ id: 'mountain-peak', name: 'Mountain Peak', kind: 'mountain_peak', x: 0, y: 0, w: 4, h: 4 });
  layout.agents.push({ id: 'chief-ranger', name: 'Chief Ranger', roomId: 'mountain-peak', x: 0, y: 0, role: 'chief_ranger' });
  const model = buildParkModel(layout);
  const peaks = model.clearings.filter((c) => c.kind === 'peak');
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].id, 'mountain-peak');
  assert.equal(peaks[0].zoneId, 'mountain-peak');
  assert.equal(model.clearings.filter((c) => c.id === 'mountain-peak').length, 1, 'the room is not also a zone clearing');
  const plain = buildParkModel(defaultLayout());
  const derived = plain.clearings.find((c) => c.kind === 'peak');
  assert.deepEqual([peaks[0].x, peaks[0].z, peaks[0].height], [derived.x, derived.z, derived.height], 'same place as the derived Peak');
  const chief = model.agents.find((a) => a.id === 'chief-ranger');
  assert.equal(chief.home.x, peaks[0].x);
  assert.equal(chief.home.y, peaks[0].height);
  assert.equal(model.clearings.find((c) => c.kind === 'zone').zoneKind, 'ranger_station');
});

test('step 7 park: hub-and-spoke trails, trailheads to the camps that serve a venture, two-leg routes, the Visitor Center', async () => {
  const { buildParkModel, routeBetween, reverseTable, joinTables } = await import('../frontend/park/placement.js');
  const layout = defaultLayout();
  layout.rooms.push({ id: 'mountain-peak', name: 'Mountain Peak', kind: 'mountain_peak', x: 0, y: 0, w: 2, h: 2 });
  layout.rooms.push({ id: 'visitor-center', name: 'Visitor Center', kind: 'visitor_center', x: 21, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'research', name: 'Research Camp', kind: 'research', x: 31, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'marketing', name: 'Marketing Camp', kind: 'marketing', x: 41, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'trailhead-lantern', name: 'Lantern Co Trailhead', kind: 'trailhead', venture: 'lantern-co', x: 1, y: 11, w: 4, h: 4 });
  layout.agents.push({ id: 'chief-ranger', name: 'Chief', roomId: 'mountain-peak', x: 0, y: 0, role: 'chief_ranger' });
  layout.agents.push({ id: 'ada', name: 'Ada', roomId: 'research', x: 31, y: 1, role: 'ranger', venture: 'lantern-co' });
  layout.agents.push({ id: 'jr', name: 'Jr', roomId: 'research', x: 32, y: 1, role: 'junior_ranger', parentAgentId: 'ada', venture: 'lantern-co' });
  const model = buildParkModel(layout);
  const pairs = model.trails.map((t) => `${t.from}>${t.to}`);
  assert.deepEqual(pairs, ['ranger-station>gate:ranger-station', 'ranger-station>mountain-peak', 'ranger-station>visitor-center', 'ranger-station>research', 'ranger-station>marketing', 'ranger-station>trailhead-lantern', 'trailhead-lantern>research']);
  assert.equal(model.visitorCenter.id, 'visitor-center');
  assert.equal(model.clearings.find((c) => c.id === 'trailhead-lantern').venture, 'lantern-co');
  // Routes: direct, two legs through the hub, none.
  const direct = routeBetween(model.trails, 'research', 'ranger-station');
  assert.deepEqual(direct.legs, ['trail:ranger-station:research']);
  assert.deepEqual(direct.table.samples[0], { ...model.trails[3].table.samples.at(-1), dist: 0, t: 0 }, 'reversed to start at research');
  const two = routeBetween(model.trails, 'mountain-peak', 'research');
  assert.deepEqual(two.legs, ['trail:ranger-station:mountain-peak', 'trail:ranger-station:research']);
  assert.ok(Math.abs(two.table.length - (model.trails[1].table.length + model.trails[3].table.length)) < 1e-9);
  assert.ok(two.table.samples.every((smp, i, arr) => i === 0 || smp.dist >= arr[i - 1].dist), 'distances increase along the joined route');
  assert.equal(two.table.samples.at(-1).t, 1);
  assert.equal(model.route('research', 'marketing').legs.length, 2);
  assert.equal(routeBetween(model.trails, 'research', 'research'), null);
  assert.equal(routeBetween([], 'a', 'b'), null);
  const t = arcLengthTable([{ x: 0, z: 0 }, { x: 10, z: 0 }], 4);
  const r = reverseTable(t);
  assert.equal(r.samples[0].x, 10);
  assert.equal(r.samples[0].dist, 0);
  assert.equal(r.samples.at(-1).dist, t.length);
  const j = joinTables(t, reverseTable(t));
  assert.equal(j.length, 2 * t.length);
  assert.equal(j.samples.length, t.samples.length * 2 - 1);
  assert.equal(j.samples.at(-1).x, 0);
  // Bodies: juniors stand where their tile says, the Chief on the Peak.
  assert.equal(model.agents.find((a) => a.id === 'jr').zoneClearingId, 'research');
  assert.equal(model.agents.find((a) => a.id === 'chief-ranger').zoneClearingId, 'mountain-peak');
});

test('step 7 clips: a delivery walks out to the Visitor Center and back; handoff wins over delivery; looks per role', async () => {
  const { lookFor, ROLE_LOOK } = await import('../frontend/park/clips.js');
  const home = { x: 0, z: 0 };
  const gate = { x: 5, z: 40 };
  const trail = { table: arcLengthTable([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }], 16) };
  const startedAt = 1000;
  const secs = (d) => startedAt + (d / WALK_SPEED) * 1000;
  const out = placeFor({ agentState: 'idle', home, gate, delivery: { trail, startedAt }, now: secs(5), pointAtFraction });
  assert.equal(out.leg, 'deliver');
  assert.ok(out.walking && out.x > 3 && out.x < 7);
  const there = placeFor({ agentState: 'idle', home, gate, delivery: { trail, startedAt }, now: secs(trail.table.length + 5), pointAtFraction });
  assert.equal(there.leg, 'return');
  assert.ok(there.walking && there.x > 12 && there.x < 17, 'walking back');
  const back = placeFor({ agentState: 'idle', home, gate, delivery: { trail, startedAt }, now: secs(2 * trail.table.length + 1), pointAtFraction });
  assert.deepEqual([back.leg, back.walking, back.x], ['home', false, 0]);
  const both = placeFor({ agentState: 'idle', home, gate, handoff: { trail, startedAt }, delivery: { trail, startedAt }, now: secs(2), pointAtFraction });
  assert.equal(both.leg, 'handoff');
  const waiting = placeFor({ agentState: 'waiting', home, gate, delivery: { trail, startedAt }, now: secs(999), pointAtFraction });
  assert.equal(waiting.leg, 'gate');
  assert.equal(lookFor({ role: 'junior_ranger' }).scale, ROLE_LOOK.junior_ranger.scale);
  assert.ok(lookFor({ role: 'junior_ranger' }).scale < lookFor({ role: 'ranger' }).scale);
  assert.ok(lookFor({ role: 'chief_ranger' }).scale > 1);
  assert.equal(lookFor({ role: 'ranger', paused: true }).tint, 0x8a8a8a);
  assert.equal(lookFor(null).tint, 0xffffff);
  assert.equal(badgeFor('thinking', { paused: true }), 'paused');
});
