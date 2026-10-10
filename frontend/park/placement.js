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
// flattened to them (see terrain.heightAt). A room of kind 'mountain_peak' (the Chief
// Ranger's post, phase 2 step 3) IS the Peak: it is placed where the derived Peak used to
// be and raised the same way, so the park looks the same with or without the room.
export function clearingsFor(layout) {
  const seed = layout.seed || 1;
  const out = [];
  const peakRoom = layout.rooms.find((r) => r.kind === 'mountain_peak') || null;
  for (const room of layout.rooms) {
    if (room === peakRoom) continue;
    const c = zoneCenter(room);
    out.push({ id: room.id, kind: 'zone', name: room.name, zoneKind: room.kind || null, venture: room.venture || null, x: c.x, z: c.z, radius: zoneRadius(room), height: heightAt(c.x, c.z, seed) });
  }
  if (layout.rooms.length && out.length) {
    const first = out[0];
    const gx = first.x;
    const gz = first.z + first.radius + 26;
    out.push({ id: `gate:${first.id}`, kind: 'gate', name: 'Entrance Gate', zoneId: first.id, x: gx, z: gz, radius: 9, height: heightAt(gx, gz, seed) });
  }
  // The Mountain Peak: the control centre, a visible high point north-west of the first
  // zone with a small station on it (docs/KICKOFF_BRIEF.md, "Operating systems inside Maka").
  if (layout.rooms.length && out.length) {
    const first = out[0];
    const px = first.x - first.radius - 46;
    const pz = first.z - first.radius - 40;
    out.push({ id: peakRoom ? peakRoom.id : 'mountain-peak', kind: 'peak', name: peakRoom ? peakRoom.name : 'Mountain Peak', zoneId: peakRoom ? peakRoom.id : null, x: px, z: pz, radius: 8, height: Math.max(heightAt(px, pz, seed), 0) + 22 });
  }
  // Keep heights above water so clearings never flood.
  for (const c of out) c.height = Math.max(c.height, TERRAIN.waterLevel + 2);
  return out;
}

// Trails (phase 2 step 7): hub and spoke through the first zone (the Ranger Station).
//   station ↔ Gate, station ↔ Peak, station ↔ every other zone,
//   trailhead ↔ each camp that serves its venture (agents with that venture live there).
// Any two zones are then at most two legs apart (routeBetween). `layout` is optional; it
// supplies the agents' ventures for the trailhead trails.
export function trailsFor(clearings, layout = null) {
  const gate = clearings.find((c) => c.kind === 'gate');
  const peak = clearings.find((c) => c.kind === 'peak');
  const zones = clearings.filter((c) => c.kind === 'zone');
  const hub = zones[0];
  const trails = [];
  const seen = new Set();
  const add = (a, b, bend, samples = 48) => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (seen.has(key) || a.id === b.id) return;
    seen.add(key);
    const points = trailBetween(a, b, bend);
    trails.push({ id: `trail:${a.id}:${b.id}`, from: a.id, to: b.id, points, table: arcLengthTable(points, samples) });
  };
  if (!hub) return trails;
  if (gate) add(hub, gate, 0.2);
  if (peak) add(hub, peak, -0.3, 64);
  for (let i = 1; i < zones.length; i++) add(hub, zones[i], i % 2 ? 0.25 : -0.25);
  if (layout) {
    for (const th of zones.filter((z) => z.zoneKind === 'trailhead' && z.venture)) {
      const camps = new Set(layout.agents.filter((a) => a.venture === th.venture).map((a) => a.roomId));
      for (const campId of camps) {
        const camp = zones.find((z) => z.id === campId);
        if (camp && camp !== hub) add(th, camp, 0.15, 40);
      }
    }
  }
  return trails;
}

// A walking route from one clearing to another: the direct trail, else two legs through
// the hub. Returns { table, legs } with a single arc-length table (tables are joined end
// to end and distances offset), or null when the zones are not connected.
export function routeBetween(trails, fromId, toId) {
  if (fromId === toId) return null;
  const find = (a, b) => {
    for (const t of trails) {
      if (t.from === a && t.to === b) return { table: t.table, id: t.id };
      if (t.from === b && t.to === a) return { table: reverseTable(t.table), id: t.id };
    }
    return null;
  };
  const direct = find(fromId, toId);
  if (direct) return { table: direct.table, legs: [direct.id] };
  const hubs = new Set();
  for (const t of trails) if (t.from === fromId || t.to === fromId) hubs.add(t.from === fromId ? t.to : t.from);
  for (const hub of hubs) {
    const a = find(fromId, hub);
    const b = find(hub, toId);
    if (a && b) return { table: joinTables(a.table, b.table), legs: [a.id, b.id] };
  }
  return null;
}

export function reverseTable(table) {
  const n = table.samples.length;
  const samples = [...table.samples].reverse().map((s, i) => ({ ...s, dist: table.length - s.dist, t: n > 1 ? i / (n - 1) : 0 }));
  return { samples, length: table.length };
}

export function joinTables(a, b) {
  const length = a.length + b.length;
  const samples = [...a.samples, ...b.samples.slice(1).map((s) => ({ ...s, dist: s.dist + a.length }))].map((s, i, arr) => ({ ...s, t: arr.length > 1 ? i / (arr.length - 1) : 0 }));
  return { samples, length };
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
  const trails = trailsFor(clearings, layout);
  const foliage = scatterFoliage(layout, clearings, trails);
  const seed = layout.seed || 1;
  const fixtures = layout.objects.map((o) => {
    const p = tileToWorld(o.x, o.y);
    return { ...o, x: p.x, z: p.z, y: heightAt(p.x, p.z, seed, clearings) };
  });
  const peak = clearings.find((c) => c.kind === 'peak');
  const agents = layout.agents.map((a) => {
    // Agents in the Peak room stand on the Peak clearing, whatever their tile says.
    if (peak && peak.zoneId && a.roomId === peak.zoneId) return { ...a, home: { x: peak.x, z: peak.z - 2, y: peak.height }, zoneClearingId: peak.id };
    const p = tileToWorld(a.x, a.y);
    return { ...a, home: { x: p.x, z: p.z, y: heightAt(p.x, p.z, seed, clearings) }, zoneClearingId: a.roomId };
  });
  const visitorCenter = clearings.find((c) => c.zoneKind === 'visitor_center') || null;
  return { seed, clearings, trails, foliage, fixtures, agents, visitorCenter, heightAt: (x, z) => heightAt(x, z, seed, clearings), route: (fromId, toId) => routeBetween(trails, fromId, toId) };
}
