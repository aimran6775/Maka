// Deterministic placement of clearings, trails, trees and rocks from the layout.
//
// The sidecar's layout (shared/world.js) is 2D tile data: rooms (zones) with x, y, w, h and
// a seed. This module maps it onto the 3D park: each zone becomes a clearing on the terrain,
// zones are joined by trails, and foliage is scattered everywhere else from the seed. No
// Three.js here, so it is tested under node.

import { mulberry32 } from './random.js';
import { heightAt, isWater, TERRAIN } from './terrain.js';
import { trailBetween, arcLengthTable } from './spline.js';

export const TILE_WORLD = 4; // world units per layout tile
const TILE_ORIGIN = 7; // layout tiles are offset so the default zone sits near the origin

// Centre of a zone in world space, from its tile rectangle.
export function zoneCenter(room) {
  return {
    x: (room.x + room.w / 2 - TILE_ORIGIN) * TILE_WORLD,
    z: (room.y + room.h / 2 - TILE_ORIGIN) * TILE_WORLD,
  };
}

export function zoneRadius(room) {
  return (Math.max(room.w, room.h) / 2) * TILE_WORLD + TILE_WORLD;
}

// World position of a tile inside a zone (fixtures and the Ranger's home tile).
export function tileToWorld(tx, ty) {
  return { x: (tx + 0.5 - TILE_ORIGIN) * TILE_WORLD, z: (ty + 0.5 - TILE_ORIGIN) * TILE_WORLD };
}

// Clearings: one per zone, plus the Entrance Gate clearing south of the first zone. Their
// heights are chosen from the raw terrain so they sit naturally, then the terrain is
// flattened to them (see terrain.heightAt).
export function clearingsFor(layout) {
  const seed = layout.seed || 1;
  const out = [];
  for (const room of layout.rooms) {
    const c = zoneCenter(room);
    out.push({ id: room.id, kind: 'zone', name: room.name, x: c.x, z: c.z, radius: zoneRadius(room), height: heightAt(c.x, c.z, seed) });
  }
  if (layout.rooms.length) {
    const first = out[0];
    const gx = first.x;
    const gz = first.z + first.radius + 26;
    out.push({ id: `gate:${first.id}`, kind: 'gate', name: 'Entrance Gate', zoneId: first.id, x: gx, z: gz, radius: 9, height: heightAt(gx, gz, seed) });
  }
  // Keep heights above water so clearings never flood.
  for (const c of out) c.height = Math.max(c.height, TERRAIN.waterLevel + 2);
  return out;
}

// Trails: each zone to the Gate (and zone to zone for later phases, in layout order).
export function trailsFor(clearings) {
  const gate = clearings.find((c) => c.kind === 'gate');
  const zones = clearings.filter((c) => c.kind === 'zone');
  const trails = [];
  if (gate) {
    for (const z of zones) {
      const points = trailBetween(z, gate, 0.2);
      trails.push({ id: `trail:${z.id}:${gate.id}`, from: z.id, to: gate.id, points, table: arcLengthTable(points, 48) });
    }
  }
  for (let i = 1; i < zones.length; i++) {
    const points = trailBetween(zones[i - 1], zones[i], 0.25);
    trails.push({ id: `trail:${zones[i - 1].id}:${zones[i].id}`, from: zones[i - 1].id, to: zones[i].id, points, table: arcLengthTable(points, 48) });
  }
  return trails;
}

function nearTrail(trails, x, z, margin) {
  for (const t of trails) {
    for (const s of t.table.samples) if (Math.hypot(s.x - x, s.z - z) < margin) return true;
  }
  return false;
}

// Scatters trees and rocks from the seed. Returns instances { kind, variant, x, z, y, rotation, scale }.
export function scatterFoliage(layout, clearings, trails, { trees = 420, rocks = 90 } = {}) {
  const seed = layout.seed || 1;
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const half = TERRAIN.size / 2 - 6;
  const out = [];
  const blocked = (x, z, margin) => clearings.some((c) => Math.hypot(c.x - x, c.z - z) < c.radius + margin) || nearTrail(trails, x, z, 3 + margin) || isWater(x, z, seed);
  let attempts = 0;
  while (out.filter((o) => o.kind === 'tree').length < trees && attempts++ < trees * 6) {
    const x = (rand() * 2 - 1) * half;
    const z = (rand() * 2 - 1) * half;
    if (blocked(x, z, 2)) continue;
    const y = heightAt(x, z, seed, clearings);
    if (y < TERRAIN.waterLevel + 0.8) continue;
    out.push({ kind: 'tree', variant: Math.floor(rand() * 4), x, z, y, rotation: rand() * Math.PI * 2, scale: 0.85 + rand() * 0.5 });
  }
  attempts = 0;
  while (out.filter((o) => o.kind === 'rock').length < rocks && attempts++ < rocks * 6) {
    const x = (rand() * 2 - 1) * half;
    const z = (rand() * 2 - 1) * half;
    if (blocked(x, z, 1)) continue;
    const y = heightAt(x, z, seed, clearings);
    out.push({ kind: 'rock', variant: Math.floor(rand() * 3), x, z, y, rotation: rand() * Math.PI * 2, scale: 0.7 + rand() * 0.9 });
  }
  return out;
}

// Everything render.js needs, derived once per layout change.
export function buildParkModel(layout) {
  const clearings = clearingsFor(layout);
  const trails = trailsFor(clearings);
  const foliage = scatterFoliage(layout, clearings, trails);
  const seed = layout.seed || 1;
  const fixtures = layout.objects.map((o) => {
    const p = tileToWorld(o.x, o.y);
    return { ...o, x: p.x, z: p.z, y: heightAt(p.x, p.z, seed, clearings) };
  });
  const agents = layout.agents.map((a) => {
    const p = tileToWorld(a.x, a.y);
    return { ...a, home: { x: p.x, z: p.z, y: heightAt(p.x, p.z, seed, clearings) } };
  });
  return { seed, clearings, trails, foliage, fixtures, agents, heightAt: (x, z) => heightAt(x, z, seed, clearings) };
}
