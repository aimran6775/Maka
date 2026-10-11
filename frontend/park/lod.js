// Level of detail by distance (phase 4 step 15, D146): pure rules and the mesh decimation
// the renderer uses for its far foliage. No Three.js here so it is tested under Node.
//
// Foliage keeps its instancing: every kit mesh of every variant is drawn as two
// InstancedMeshes over the same items, `near` (the kit geometry, shadows) and `far` (the
// vertex-clustered geometry from `clusterDecimate`, flat shaded, no shadow); an item beyond
// LOD.foliageFar is not drawn at all (the fog ends at 320). The crew keeps one body each;
// distance decides how often its animation mixer runs and whether the label, the badge and
// the shadow are drawn. Nothing here changes where anything stands.

export const LOD = Object.freeze({
  foliageNear: 70, // closer than this: the kit mesh with shadows
  foliageFar: 290, // up to this: the decimated mesh without shadow; beyond: not drawn
  crewNear: 40, // closer than this: every frame, label, badge, shadow
  crewFar: 120, // up to this: the mixer every second frame, no label; beyond: every fourth frame, no badge, no shadow
  rebucketMove: 2, // world units the camera moves before the foliage buckets are redone
  rebucketMs: 250, // or this long
  decimateCells: 6, // the far mesh collapses vertices into a grid of this many cells along the model's longest side
});

// 0 near, 1 far, 2 not drawn. With `enabled: false` everything is near (the bench's control).
export function foliageLevel(dist, { enabled = true } = {}) {
  if (!enabled) return 0;
  return dist < LOD.foliageNear ? 0 : dist < LOD.foliageFar ? 1 : 2;
}

// Buckets every foliage item by its distance to the camera. Returns the level per item
// and how many fell in each.
export function bucketFoliage(items, cam, { enabled = true } = {}) {
  const levels = new Uint8Array(items.length);
  const counts = [0, 0, 0];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dist = Math.hypot(it.x - cam.x, (it.y || 0) - (cam.y || 0), it.z - cam.z);
    const lv = foliageLevel(dist, { enabled });
    levels[i] = lv;
    counts[lv]++;
  }
  return { levels, counts };
}

// What a crew body does at this distance.
export function crewLod(dist, { enabled = true } = {}) {
  if (!enabled || dist < LOD.crewNear) return { level: 0, mixerEvery: 1, label: true, badge: true, shadow: true };
  if (dist < LOD.crewFar) return { level: 1, mixerEvery: 2, label: false, badge: true, shadow: true };
  return { level: 2, mixerEvery: 4, label: false, badge: false, shadow: false };
}

// Whether the foliage buckets should be redone: never done yet, the camera moved more than
// LOD.rebucketMove, or LOD.rebucketMs passed.
export function shouldRebucket(prev, cam, now) {
  if (!prev) return true;
  if (now - prev.at >= LOD.rebucketMs) return true;
  return Math.hypot(cam.x - prev.x, (cam.y || 0) - (prev.y || 0), cam.z - prev.z) > LOD.rebucketMove;
}

// The grid cell for `clusterDecimate`: the model's longest side over `cells`.
export function cellSizeFor(positions, cells = LOD.decimateCells) {
  if (!positions.length) return 1;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return longest > 0 ? longest / Math.max(1, cells) : 1;
}

// Vertex clustering: every vertex snaps to the centre of mass of its grid cell, triangles
// whose corners collapse together go, duplicates go. Positions in, positions and an index
// out; normals are the renderer's to recompute. Deterministic for the same input.
export function clusterDecimate({ positions, index = null }, cellSize) {
  const vertexCount = Math.floor(positions.length / 3);
  const cell = cellSize > 0 ? cellSize : 1;
  const min = [Infinity, Infinity, Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) if (positions[i * 3 + k] < min[k]) min[k] = positions[i * 3 + k];
  }
  const cells = new Map(); // key -> { n, sum: [x,y,z], id }
  const remap = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const key = `${Math.floor((x - min[0]) / cell)},${Math.floor((y - min[1]) / cell)},${Math.floor((z - min[2]) / cell)}`;
    let c = cells.get(key);
    if (!c) {
      c = { n: 0, sum: [0, 0, 0], id: cells.size };
      cells.set(key, c);
    }
    c.n++;
    c.sum[0] += x;
    c.sum[1] += y;
    c.sum[2] += z;
    remap[i] = c.id;
  }
  const out = new Float32Array(cells.size * 3);
  for (const c of cells.values()) {
    out[c.id * 3] = c.sum[0] / c.n;
    out[c.id * 3 + 1] = c.sum[1] / c.n;
    out[c.id * 3 + 2] = c.sum[2] / c.n;
  }
  const src = index || Array.from({ length: vertexCount }, (_, i) => i);
  const trianglesBefore = Math.floor(src.length / 3);
  const seen = new Set();
  const tris = [];
  for (let t = 0; t < trianglesBefore; t++) {
    const a = remap[src[t * 3]];
    const b = remap[src[t * 3 + 1]];
    const c = remap[src[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    // The same three corners in any rotation are the same face; keep the first winding.
    const key = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    tris.push(a, b, c);
  }
  return { positions: out, index: Uint32Array.from(tris), vertices: cells.size, trianglesBefore, trianglesAfter: tris.length / 3 };
}
