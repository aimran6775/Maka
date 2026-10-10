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
  assert.equal(model.clearings.length, 2);
  assert.equal(model.clearings[0].id, 'ranger-station');
  assert.equal(model.clearings[1].kind, 'gate');
  assert.ok(model.clearings[1].z > model.clearings[0].z, 'gate is south of the station');
  assert.equal(model.trails.length, 1);
  assert.equal(model.trails[0].from, 'ranger-station');
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
  // A second zone adds a trail between zones.
  const two = { ...layout, rooms: [...layout.rooms, { id: 'camp', name: 'Campground', x: 20, y: 1, w: 6, h: 6 }] };
  assert.equal(trailsFor(clearingsFor(two)).length, 3);
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
  assert.deepEqual(placeFor({ agentState: 'idle', home, gate }), { x: 1, z: 2, heading: 0, walking: false, fraction: 1 });
  assert.equal(placeFor({ agentState: 'waiting', home, gate }).z, 40);
  const pts = [{ x: 0, z: 0 }, { x: 5, z: 1 }, { x: 10, z: 0 }];
  const trail = { table: arcLengthTable(pts, 16) };
  const startedAt = 1000;
  const mid = placeFor({ agentState: 'idle', home, gate, handoff: { trail, startedAt }, now: startedAt + ((trail.table.length / 2) / WALK_SPEED) * 1000, pointAtFraction });
  assert.ok(mid.walking);
  assert.ok(mid.x > 3 && mid.x < 7);
  const end = placeFor({ agentState: 'idle', home, gate, handoff: { trail, startedAt }, now: startedAt + 60000, pointAtFraction });
  assert.equal(end.walking, false);
  assert.equal(end.x, 10);
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
