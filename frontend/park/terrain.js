// Seeded heightmap terrain: value noise with a few octaves, flattened inside clearings so
// zones sit on level ground, and lowered along the river. Pure functions of (seed, x, z);
// render.js samples them to build the mesh and to place things on the surface.

import { hash2 } from './random.js';

export const TERRAIN = Object.freeze({
  size: 240, // world units, centred on the origin
  segments: 240, // one vertex per world unit: the macro colour the ground is splatted with lives on them (D166)
  amplitude: 9,
  baseFrequency: 1 / 48,
  octaves: 6, // down to a 1.5-unit wavelength: ground that is lumpy at walking scale, not a smooth sheet (D166)
  waterLevel: -1.2,
});

function smooth(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function fbm(x, z, seed, { octaves = TERRAIN.octaves, frequency = TERRAIN.baseFrequency } = {}) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = frequency;
  for (let i = 0; i < octaves; i++) {
    sum += (valueNoise(x * f, z * f, seed + i * 101) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm; // -1 .. 1
}

// The river follows a gentle sine across the park in x, offset by the seed.
export function riverCenterZ(x, seed) {
  const phase = hash2(seed, 7, seed) * Math.PI * 2;
  return Math.sin(x / 55 + phase) * 28 + (hash2(seed, 11, seed) - 0.5) * 20;
}

export const RIVER_HALF_WIDTH = 7;

// Height at world (x, z) for a seed, given the clearings to flatten.
export function heightAt(x, z, seed, clearings = []) {
  let h = fbm(x, z, seed) * TERRAIN.amplitude;
  // Ridgelines toward the edges so the park feels enclosed.
  const edge = Math.max(Math.abs(x), Math.abs(z)) / (TERRAIN.size / 2);
  if (edge > 0.75) h += (edge - 0.75) * 40;
  // River valley.
  const dz = Math.abs(z - riverCenterZ(x, seed));
  if (dz < RIVER_HALF_WIDTH * 2.5) {
    const t = Math.min(1, dz / (RIVER_HALF_WIDTH * 2.5));
    h = h * smooth(t) + (TERRAIN.waterLevel - 1.5) * (1 - smooth(t));
  }
  // Clearings: blend to a flat plateau at the clearing's height. A peak clearing also
  // raises a wide cone of ground around it so it reads as a mountain.
  for (const c of clearings) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (c.kind === 'peak') {
      const reach = c.radius * 5;
      if (d < reach) {
        const t = smooth(Math.min(1, Math.max(0, (d - c.radius) / (reach - c.radius))));
        h = h * t + c.height * (1 - t);
      }
    } else if (d < c.radius * 1.6) {
      const t = Math.min(1, Math.max(0, (d - c.radius) / (c.radius * 0.6)));
      h = h * smooth(t) + c.height * (1 - smooth(t));
    }
  }
  return h;
}

export function isWater(x, z, seed) {
  return Math.abs(z - riverCenterZ(x, seed)) < RIVER_HALF_WIDTH;
}
