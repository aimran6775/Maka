// Frame-time statistics and the dev overlay's text (phase 4 step 15). Pure: tested under
// Node, used by render.js for the overlay and by scripts/park-bench.mjs through
// `park.frameStats()`. Only measured numbers, never a projection: a stat with no samples is
// null and prints as "no data".

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A ring of the last `size` samples in milliseconds.
export function createFrameStats({ size = 240 } = {}) {
  const buf = new Float64Array(size);
  let n = 0;
  let head = 0;
  let total = 0; // every sample ever pushed, for "frames since reset"
  const sorted = () => Float64Array.from(buf.subarray(0, n)).sort();
  return {
    push(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      buf[head] = ms;
      head = (head + 1) % size;
      if (n < size) n++;
      total++;
    },
    get count() {
      return n;
    },
    get total() {
      return total;
    },
    reset() {
      n = 0;
      head = 0;
      total = 0;
    },
    median: () => median(sorted()),
    p95: () => percentile(sorted(), 0.95),
    worst: () => (n ? Math.max(...buf.subarray(0, n)) : null),
    mean: () => (n ? buf.subarray(0, n).reduce((a, b) => a + b, 0) / n : null),
    snapshot() {
      const s = sorted();
      return { samples: n, median: median(s), p95: percentile(s, 0.95), worst: s.length ? s[s.length - 1] : null, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null };
    },
  };
}

const ms = (v) => (v === null || v === undefined ? 'no data' : `${v.toFixed(1)} ms`);
const num = (v) => (v === null || v === undefined ? 'no data' : String(v));

// The overlay's lines from a `park.frameStats()` snapshot.
export function overlayLines(s) {
  const lod = s.lod || {};
  const f = lod.foliage || [0, 0, 0];
  const c = lod.crew || [0, 0, 0];
  const tri = lod.triangles || {};
  return [
    `renderer ${s.renderer}${s.fps ? ` · ${s.fps} fps` : ''}`,
    `frame ${ms(s.frameMs && s.frameMs.median)} median · ${ms(s.frameMs && s.frameMs.p95)} p95 · ${ms(s.frameMs && s.frameMs.worst)} worst (${num(s.frameMs ? s.frameMs.samples : null)} frames)`,
    `work ${ms(s.workMs && s.workMs.median)} median · ${ms(s.workMs && s.workMs.p95)} p95`,
    `draw calls ${num(s.calls)} · triangles ${num(s.triangles)}`,
    `lod ${lod.enabled === false ? 'off' : 'on'} · foliage ${f[0]} near / ${f[1]} far / ${f[2]} culled of ${num(s.foliage)} (triangles near ${num(tri.near)} far ${num(tri.far)}) · density ×${num(s.density)}`,
    `crew ${num(s.bodies)} bodies: ${c[0]} near / ${c[1]} mid / ${c[2]} far`,
    '` toggles this overlay',
  ];
}
