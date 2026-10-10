// Deterministic PRNG and hash helpers. The park is a pure function of the layout seed, so
// every scattered tree and every terrain bump is the same on every launch and on every
// machine. No Three.js here.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// A fresh random seed for re-rolling the park (32-bit, non-zero).
export function newSeed(random = Math.random) {
  return (Math.floor(random() * 0xfffffffe) + 1) >>> 0;
}
