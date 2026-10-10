// Catmull-Rom splines over 2D points, plus arc-length parameterisation so a Ranger can walk
// a trail at constant speed. Pure math, no Three.js.

export function catmullRom(points, t) {
  const n = points.length;
  if (n === 0) return { x: 0, z: 0 };
  if (n === 1) return { ...points[0] };
  const seg = Math.min(n - 2, Math.max(0, Math.floor(t * (n - 1))));
  const u = Math.min(1, Math.max(0, t * (n - 1) - seg));
  const p0 = points[Math.max(0, seg - 1)];
  const p1 = points[seg];
  const p2 = points[seg + 1];
  const p3 = points[Math.min(n - 1, seg + 2)];
  const c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u * u + (-a + 3 * b - 3 * cc + d) * u * u * u);
  return { x: c(p0.x, p1.x, p2.x, p3.x), z: c(p0.z, p1.z, p2.z, p3.z) };
}

// Samples the spline into `count` points with cumulative distances, for constant-speed travel.
export function arcLengthTable(points, count = 64) {
  const samples = [];
  let dist = 0;
  let prev = null;
  for (let i = 0; i <= count; i++) {
    const p = catmullRom(points, i / count);
    if (prev) dist += Math.hypot(p.x - prev.x, p.z - prev.z);
    samples.push({ t: i / count, x: p.x, z: p.z, dist });
    prev = p;
  }
  return { samples, length: dist };
}

// Point at a fraction 0..1 of the trail's length (not of its parameter).
export function pointAtFraction(table, fraction) {
  const target = Math.min(1, Math.max(0, fraction)) * table.length;
  const s = table.samples;
  for (let i = 1; i < s.length; i++) {
    if (s[i].dist >= target) {
      const a = s[i - 1];
      const b = s[i];
      const span = b.dist - a.dist || 1;
      const u = (target - a.dist) / span;
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, heading: Math.atan2(b.x - a.x, b.z - a.z) };
    }
  }
  const last = s[s.length - 1];
  const before = s[Math.max(0, s.length - 2)];
  return { x: last.x, z: last.z, heading: Math.atan2(last.x - before.x, last.z - before.z) };
}

// A trail between two clearings with a mid-point bowed sideways so it is not a straight line.
export function trailBetween(a, b, bow = 0.25) {
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return [
    { x: a.x, z: a.z },
    { x: mx - dz * bow, z: mz + dx * bow },
    { x: b.x, z: b.z },
  ];
}
