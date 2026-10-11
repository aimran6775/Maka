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
  assert.ok(model.foliage.filter((f) => f.kind === 'grass').length > 1000, 'ground cover is dense: only what is near the camera is drawn');
  for (const f of model.foliage) {
    for (const c of model.clearings) {
      // Trees and rocks keep out of a clearing; grass grows back over its outer third,
      // where the worn ground fades into the grass (D166).
      const keepOut = f.kind === 'grass' ? c.radius * 0.66 : c.radius;
      assert.ok(Math.hypot(c.x - f.x, c.z - f.z) >= keepOut, `${f.kind} stays out of clearings`);
    }
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
  assert.ok(scatterFoliage(layout, model.clearings, model.trails, { trees: 10, rocks: 2, grass: 3 }).length <= 15);
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
  // The light warms on a ramp toward the horizon, never on a switch (D166): the middle
  // of the day is neutral, dawn and dusk are warm, and the dome overhead stays blue.
  const blue = (hex) => (hex & 255) / (((hex >> 16) & 255) || 1);
  assert.equal(noon.warmth, 0, 'no warmth at noon');
  assert.ok(at(7).warmth > 0.1 && at(7).warmth < 0.5, `dawn is on the way up: ${at(7).warmth}`);
  assert.ok(at(17.5).warmth > at(16).warmth, 'the afternoon warms as the sun drops');
  assert.ok(blue(at(7).color) < blue(noon.color), 'dawn light is warmer than noon light');
  assert.ok(blue(at(7).zenith) > 1, 'the sky overhead stays blue at dawn');
  assert.ok(blue(night.zenith) > 1 && night.warmth === 0, 'night has no golden hour');
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

test('park-check cleanup: the profile removal is forced, recursive and retried; a stubborn directory is reported, not fatal', async () => {
  const { removeWithRetry } = await import('../scripts/park-check.mjs');
  const calls = [];
  let failures = 2;
  const fs = { rm: async (dir, opts) => { calls.push({ dir, opts }); if (failures-- > 0) { const e = new Error('busy'); e.code = 'ENOTEMPTY'; throw e; } } };
  const sleeps = [];
  assert.equal(await removeWithRetry('/tmp/x', { fs, sleep: async (ms) => sleeps.push(ms), delayMs: 5 }), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].opts, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  assert.deepEqual(sleeps, [5, 5]);
  failures = 99;
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    assert.equal(await removeWithRetry('/tmp/y', { fs, sleep: async () => {}, attempts: 3 }), false);
  } finally {
    console.warn = warn;
  }
  assert.match(warned[0], /could not be removed \(ENOTEMPTY\)/);
});

test('phase 4 step 3 lamps: a Peak tower shows one lamp per owner channel from channel.connect state only; a camp tower and a park without the registry show none', async () => {
  const { lampsFor, LAMP_LOOK } = await import('../frontend/park/clips.js');
  const channels = { adapters: [{ name: 'telegram', label: 'Telegram', status: 'up', paired: [{ chatId: '1' }] }, { name: 'discord', label: 'Discord', status: 'error', paired: [] }, { name: 'slack', label: 'Slack', status: 'not_wired', paired: [] }, { name: 'other', label: 'Other', status: 'weird', paired: [] }] };
  const lamps = lampsFor(channels);
  assert.deepEqual(lamps.map((l) => [l.name, l.status, l.paired]), [['telegram', 'up', 1], ['discord', 'error', 0], ['slack', 'not_wired', 0], ['other', 'down', 0]]);
  assert.equal(lamps[0].look, LAMP_LOOK.up);
  assert.equal(lamps[2].look.intensity, 0, 'not wired is dark');
  assert.deepEqual(lampsFor(channels, { atPeak: false }), []);
  assert.deepEqual(lampsFor(null), []);
  assert.deepEqual(lampsFor({}), []);
});

test('phase 4 step 15 lod: distance levels for foliage and crew, the buckets, the rebucket rule, lod off keeps everything near', async () => {
  const { LOD, foliageLevel, bucketFoliage, crewLod, shouldRebucket, cellSizeFor } = await import('../frontend/park/lod.js');
  assert.equal(foliageLevel(0), 0);
  assert.equal(foliageLevel(LOD.foliageNear - 0.01), 0);
  assert.equal(foliageLevel(LOD.foliageNear), 1);
  assert.equal(foliageLevel(LOD.foliageFar - 0.01), 1);
  assert.equal(foliageLevel(LOD.foliageFar), 2);
  assert.equal(foliageLevel(5000, { enabled: false }), 0);
  const items = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 400 }, { x: 10, y: 0, z: 10 }];
  const cam = { x: 0, y: 0, z: 0 };
  const b = bucketFoliage(items, cam);
  assert.deepEqual([...b.levels], [0, 1, 2, 0]);
  assert.deepEqual(b.counts, [2, 1, 1]);
  assert.deepEqual(bucketFoliage(items, cam, { enabled: false }).counts, [4, 0, 0]);
  // Height counts: an item 100 below a camera straight above it is far, not near.
  assert.equal(bucketFoliage([{ x: 0, y: 0, z: 0 }], { x: 0, y: 100, z: 0 }).levels[0], 1);
  assert.deepEqual(crewLod(1), { level: 0, mixerEvery: 1, label: true, badge: true, shadow: true });
  assert.deepEqual(crewLod(LOD.crewNear), { level: 1, mixerEvery: 2, label: false, badge: true, shadow: true });
  assert.deepEqual(crewLod(LOD.crewFar), { level: 2, mixerEvery: 4, label: false, badge: false, shadow: false });
  assert.equal(crewLod(999, { enabled: false }).level, 0);
  assert.equal(shouldRebucket(null, cam, 0), true);
  assert.equal(shouldRebucket({ x: 0, y: 0, z: 0, at: 0 }, { x: 1, y: 0, z: 0 }, 10), false);
  assert.equal(shouldRebucket({ x: 0, y: 0, z: 0, at: 0 }, { x: LOD.rebucketMove + 0.1, y: 0, z: 0 }, 10), true);
  assert.equal(shouldRebucket({ x: 0, y: 0, z: 0, at: 0 }, { x: 0, y: 0, z: 0 }, LOD.rebucketMs), true);
  assert.equal(cellSizeFor(new Float32Array([0, 0, 0, 12, 3, 6]), 6), 2);
  assert.equal(cellSizeFor(new Float32Array([1, 1, 1, 1, 1, 1]), 6), 1, 'a flat model gets a cell of one');
  assert.equal(cellSizeFor(new Float32Array(0)), 1);
});

test('phase 4 step 15 lod: vertex clustering decimates a mesh, drops collapsed and duplicate faces, stays inside the model, is deterministic', async () => {
  const { clusterDecimate, cellSizeFor } = await import('../frontend/park/lod.js');
  // A 10 × 10 grid of quads (200 triangles) over [0, 10]², indexed.
  const n = 11;
  const positions = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) positions.set([i, Math.sin(i) * 0.2, j], (j * n + i) * 3);
  const index = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i;
    index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
  }
  const d = clusterDecimate({ positions, index: Uint32Array.from(index) }, cellSizeFor(positions, 4));
  assert.equal(d.trianglesBefore, 200);
  assert.ok(d.trianglesAfter > 4 && d.trianglesAfter < 200, `decimated to ${d.trianglesAfter}`);
  assert.equal(d.index.length, d.trianglesAfter * 3);
  assert.equal(d.positions.length, d.vertices * 3);
  for (let t = 0; t < d.trianglesAfter; t++) {
    const [a, b, c] = [d.index[t * 3], d.index[t * 3 + 1], d.index[t * 3 + 2]];
    assert.ok(a !== b && b !== c && a !== c, 'no collapsed face');
    assert.ok(a < d.vertices && b < d.vertices && c < d.vertices);
  }
  for (let i = 0; i < d.positions.length; i += 3) {
    assert.ok(d.positions[i] >= 0 && d.positions[i] <= 10 && d.positions[i + 2] >= 0 && d.positions[i + 2] <= 10, 'inside the model');
  }
  const again = clusterDecimate({ positions, index: Uint32Array.from(index) }, cellSizeFor(positions, 4));
  assert.deepEqual([...again.index], [...d.index]);
  // One cell swallows everything: no face survives (the renderer then keeps the kit mesh).
  assert.equal(clusterDecimate({ positions, index: Uint32Array.from(index) }, 1000).trianglesAfter, 0);
  // A cell smaller than any edge keeps every face; an unindexed soup works too.
  assert.equal(clusterDecimate({ positions, index: Uint32Array.from(index) }, 0.1).trianglesAfter, 200);
  const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  const sd = clusterDecimate({ positions: soup }, 0.01);
  assert.equal(sd.trianglesBefore, 3);
  assert.equal(sd.trianglesAfter, 1, 'the duplicate face and the degenerate face go');
});

test('phase 4 step 15 frametime: ring statistics, percentiles, reset, and the overlay says "no data" without samples', async () => {
  const { createFrameStats, percentile, median, overlayLines } = await import('../frontend/park/frametime.js');
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([1, 2, 10]), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([], 0.5), null);
  const s = createFrameStats({ size: 4 });
  assert.deepEqual(s.snapshot(), { samples: 0, median: null, p95: null, worst: null, mean: null });
  s.push(10);
  s.push(30);
  s.push(NaN);
  s.push(-1);
  assert.equal(s.count, 2);
  assert.equal(s.median(), 20);
  for (const v of [1, 2, 3]) s.push(v); // wraps: keeps 30, 1, 2, 3
  assert.equal(s.count, 4);
  assert.equal(s.total, 5);
  assert.equal(s.worst(), 30);
  assert.equal(s.median(), 2.5);
  assert.equal(s.p95(), 30);
  assert.equal(s.mean(), 9);
  s.reset();
  assert.equal(s.count, 0);
  assert.equal(s.total, 0);
  const lines = overlayLines({ renderer: 'webgl2', fps: 0, frameMs: s.snapshot(), workMs: s.snapshot(), calls: null, triangles: null, lod: { enabled: false, foliage: [1, 2, 3], crew: [4, 5, 6], triangles: {} }, density: 2, foliage: 6, bodies: 15 });
  assert.match(lines[0], /^renderer webgl2$/);
  assert.match(lines[1], /frame no data median · no data p95/);
  assert.match(lines[3], /draw calls no data · triangles no data/);
  assert.match(lines[4], /lod off · foliage 1 near \/ 2 far \/ 3 culled of 6 .*density ×2/);
  assert.match(lines[5], /crew 15 bodies: 4 near \/ 5 mid \/ 6 far/);
  const withData = overlayLines({ renderer: 'webgpu', fps: 60, frameMs: { samples: 3, median: 16.66, p95: 20, worst: 33.3 }, workMs: { samples: 3, median: 4.04, p95: 6 }, calls: 87, triangles: 100127, lod: { enabled: true, foliage: [0, 0, 0], crew: [0, 0, 0], triangles: { near: 1, far: 2 } }, density: 1, foliage: 0, bodies: 0 });
  assert.equal(withData[0], 'renderer webgpu · 60 fps');
  assert.equal(withData[1], 'frame 16.7 ms median · 20.0 ms p95 · 33.3 ms worst (3 frames)');
  assert.equal(withData[3], 'draw calls 87 · triangles 100127');
});

test('phase 4 step 15 gpu: WebGPU when navigator.gpu exists, WebGL2 otherwise or when forced; the label names a fallback; page options parse strictly', async () => {
  const { chooseRenderer, rendererLabel, parkOptions } = await import('../frontend/park/gpu.js');
  assert.deepEqual(chooseRenderer({ hasGpu: true }), { path: 'webgpu', reason: 'navigator.gpu exists' });
  assert.deepEqual(chooseRenderer({ hasGpu: false }), { path: 'webgl2', reason: 'navigator.gpu is missing' });
  assert.deepEqual(chooseRenderer({ hasGpu: false, secure: false }), { path: 'webgl2', reason: 'navigator.gpu is missing (not a secure context)' });
  assert.equal(chooseRenderer({ query: { renderer: 'webgl2' }, hasGpu: true }).path, 'webgl2');
  assert.equal(chooseRenderer({ query: { renderer: 'WebGL' }, hasGpu: true }).path, 'webgl2');
  assert.equal(chooseRenderer({ query: { renderer: 'webgpu' }, hasGpu: true }).reason, 'renderer=webgpu in the URL');
  assert.deepEqual(chooseRenderer({ query: { renderer: 'webgpu' }, hasGpu: false }), { path: 'webgl2', reason: 'renderer=webgpu asked, but navigator.gpu is missing' });
  assert.match(chooseRenderer({ query: { renderer: 'vulkan' }, hasGpu: true }).reason, /unknown renderer "vulkan" ignored/);
  assert.equal(chooseRenderer({ query: { renderer: 'vulkan' }, hasGpu: false }).path, 'webgl2');
  assert.equal(rendererLabel({ path: 'webgpu' }), 'webgpu');
  assert.equal(rendererLabel({ path: 'webgl2' }), 'webgl2');
  assert.equal(rendererLabel({ path: 'webgl2', fellBack: 'no WebGPU adapter' }), 'webgl2 (no WebGPU adapter)');
  assert.deepEqual(parkOptions({}), { renderer: 'auto', lod: true, density: 1, overlay: false });
  assert.deepEqual(parkOptions({ renderer: 'WEBGPU', lod: 'off', density: '3', dev: '1' }), { renderer: 'webgpu', lod: false, density: 3, overlay: true });
  assert.deepEqual(parkOptions({ renderer: 'webgl', lod: 'ON', density: '99', overlay: '1' }), { renderer: 'webgl2', lod: true, density: 6, overlay: true });
  assert.deepEqual(parkOptions({ renderer: 'metal', density: '-2' }), { renderer: 'auto', lod: true, density: 1, overlay: false });
  assert.equal(parkOptions({ density: 'abc' }).density, 1);
});

test('phase 4 step 15 density: buildParkModel multiplies the foliage for the bench and leaves the park itself unchanged', async () => {
  const { buildParkModel, scatterFoliage, clearingsFor, trailsFor, FOLIAGE } = await import('../frontend/park/placement.js');
  const layout = { ...defaultLayout(), seed: 777 };
  const one = buildParkModel(layout);
  const clearings = clearingsFor(layout);
  assert.deepEqual(one.foliage, scatterFoliage(layout, clearings, trailsFor(clearings, layout)), 'density 1 is the park');
  assert.deepEqual(FOLIAGE, { trees: 420, rocks: 90, grass: 10000 });
  const trees = (m) => m.foliage.filter((f) => f.kind === 'tree').length;
  const rocks = (m) => m.foliage.filter((f) => f.kind === 'rock').length;
  const three = buildParkModel(layout, { density: 3 });
  assert.ok(trees(three) > trees(one) * 2 && trees(three) <= 1260, `${trees(three)} trees at ×3`);
  assert.ok(rocks(three) > rocks(one) * 2 && rocks(three) <= 270, `${rocks(three)} rocks at ×3`);
  assert.deepEqual(buildParkModel(layout, { density: 3 }).foliage, three.foliage, 'deterministic');
  for (const f of three.foliage.filter((x) => x.kind !== 'grass')) assert.ok(!clearings.some((c) => Math.hypot(c.x - f.x, c.z - f.z) < c.radius), 'a dense park still keeps the clearings clear');
});

test('phase 4 step 15 bench: the argument parser, the configurations, the table and the LOD gain are pure and refuse typos', async () => {
  const { parseArgs, configurations, benchTable, lodGain, DEFAULTS } = await import('../scripts/park-bench.mjs');
  assert.deepEqual(parseArgs([]), DEFAULTS);
  assert.deepEqual(parseArgs(['--density=2', '--crew=5', '--webgpu', '--json=false']), { ...DEFAULTS, density: 2, crew: 5, webgpu: true, json: false });
  assert.throws(() => parseArgs(['--densty=2']), /unknown option --densty/);
  assert.throws(() => parseArgs(['--frames=0']), /positive number/);
  assert.deepEqual(configurations({ webgpu: false }), [{ renderer: 'webgl2', lod: 'on' }, { renderer: 'webgl2', lod: 'off' }]);
  assert.equal(configurations({ webgpu: true }).length, 4);
  const stats = (median, extra = {}) => ({ renderer: 'webgl2', frameMs: { samples: 100, median, p95: median * 2, worst: median * 3 }, workMs: { samples: 100, median: 3, p95: 5 }, calls: 80, triangles: 90000, lod: { foliage: [1, 2, 3], crew: [4, 5, 6] }, ...extra });
  const rows = [{ renderer: 'webgl2', lod: 'on', stats: stats(10) }, { renderer: 'webgl2', lod: 'off', stats: stats(15) }, { renderer: 'webgpu', lod: 'on', stats: null, rendererLabel: 'webgl2 (no WebGPU adapter)' }];
  const table = benchTable(rows);
  assert.match(table[0], /^config\s+renderer \(as run\)\s+frames\s+frame median/);
  assert.match(table[2], /^webgl2 lod on\s+webgl2\s+100\s+10\.0 ms\s+20\.0 ms\s+3\.0 ms\s+80\s+90000\s+1\/2\/3\s+4\/5\/6$/);
  assert.match(table[4], /^webgpu lod on\s+webgl2 \(no WebGPU adapter\)\s+0\s+no data/);
  assert.deepEqual(lodGain(rows, 'webgl2'), { onMs: 10, offMs: 15, ratio: 1.5 });
  assert.equal(lodGain(rows, 'webgpu'), null);
});

test('phase 4 step 15 wiring: the import map carries the WebGPU build, the manifest vendors it, render.js alone imports Three.js, the bench script is registered', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(map.imports['three/webgpu'], '/vendor/three/three.webgpu.js');
  assert.equal(map.imports['three/tsl'], '/vendor/three/three.tsl.js');
  const manifest = JSON.parse(await fs.readFile(new URL('../frontend/assets/manifest.json', import.meta.url), 'utf8'));
  const three = manifest.sources.find((s) => s.id === 'three');
  for (const f of ['three.webgpu.js', 'three.tsl.js', 'addons/objects/SkyMesh.js']) assert.ok(three.files.some((x) => x.to === f), `${f} vendored`);
  const dir = new URL('../frontend/', import.meta.url);
  const importers = [];
  const walk = async (d, rel) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === 'vendor') continue;
      if (e.isDirectory()) await walk(new URL(`${e.name}/`, d), `${rel}${e.name}/`);
      else if (e.name.endsWith('.js') && /from ['"]three/.test(await fs.readFile(new URL(e.name, d), 'utf8'))) importers.push(`${rel}${e.name}`);
    }
  };
  await walk(dir, '');
  assert.deepEqual(importers, ['park/render.js']);
  const render = await fs.readFile(new URL('../frontend/park/render.js', import.meta.url), 'utf8');
  for (const s of ["import('three/webgpu')", "import('three/tsl')", 'isWebGPUBackend', 'shimTextureViewSwizzle', 'device.lost', 'onDeviceLost(', 'rebucketFoliage', 'crewLod(', 'frameStats', 'park-overlay']) assert.ok(render.includes(s), `render.js has ${s}`);
  const app = await fs.readFile(new URL('../frontend/app.js', import.meta.url), 'utf8');
  for (const s of ['parkOptions(', 'onDeviceLost:', "loadPark({ renderer: 'webgl2', fellBack: reason })"]) assert.ok(app.includes(s), `app.js has ${s}`);
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['park:bench'], 'node scripts/park-bench.mjs');
  assert.deepEqual(pkg.dependencies, {});
});
