// The park's realistic surfaces as pure pixel math (D166): the terrain's baked splat
// albedo and the procedural needle/leaf textures for the trees. No Three.js and no DOM —
// render.js wraps the returned pixel buffers in canvases/textures; this module is tested
// under node. All functions are deterministic for the same inputs.

import { valueNoise, TERRAIN } from './terrain.js';
import { hash2 } from './random.js';

// Blend weights [grass, forest, rock, sand] for one terrain sample. Sand hugs the water
// line, rock takes steep slopes and the high ground, forest floor comes in noise-grown
// patches of the mid heights, grass is the rest. Weights sum to 1.
export function splatWeights({ height, slope, x, z, seed }) {
  const smooth = (a, b, t) => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const sand = 1 - smooth(TERRAIN.waterLevel + 0.6, TERRAIN.waterLevel + 1.6, height);
  const rock = Math.max(smooth(0.5, 1.1, slope), smooth(12, 16, height)) * (1 - sand);
  const patch = valueNoise(x * 0.035, z * 0.035, seed + 977);
  const forest = smooth(0.42, 0.62, patch) * (1 - rock) * (1 - sand);
  const grass = Math.max(0, 1 - sand - rock - forest);
  const sum = grass + forest + rock + sand || 1;
  return [grass / sum, forest / sum, rock / sum, sand / sum];
}

export const LAYER_NAMES = Object.freeze(['grass', 'forest', 'rock', 'sand']);

// The colour each layer stands for, 0..1 per channel, from { data, width, height } RGBA
// reads of the four diffuse maps.
//
// For bare ground that is the plain mean. For the vegetation layers it is the mean of
// the leafy pixels only — the ones greener than the photo's own average. A grass scan
// averages to khaki because half of it is the soil between the blades, so the plain mean
// paints a meadow the colour of a dirt road; the leafy half is what a person means when
// they say the grass is green (D166).
export function layerMeans(layers, { vegetation = ['grass', 'forest'] } = {}) {
  const out = {};
  for (const name of LAYER_NAMES) {
    const l = layers[name];
    const n = l.width * l.height;
    const greenness = (i) => l.data[i * 4 + 1] - (l.data[i * 4] + l.data[i * 4 + 2]) / 2;
    let cut = -Infinity;
    if (vegetation.includes(name)) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += greenness(i);
      cut = sum / n;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (greenness(i) < cut) continue;
      r += l.data[i * 4];
      g += l.data[i * 4 + 1];
      b += l.data[i * 4 + 2];
      count++;
    }
    if (!count) {
      for (let i = 0; i < n; i++) {
        r += l.data[i * 4];
        g += l.data[i * 4 + 1];
        b += l.data[i * 4 + 2];
      }
      count = n;
    }
    out[name] = [r / count / 255, g / count / 255, b / count / 255];
  }
  return out;
}

// A tiling greyscale detail map: one layer's diffuse divided by its own mean, so it
// carries the texture's light and shade and none of its colour. The terrain multiplies
// it by a per-vertex macro colour, which is what lets one small tiled map give sharp
// ground detail at any zoom while the colour still changes from grass to rock to sand
// (D166 — a single baked albedo over 240 world units is blurry at every useful camera).
export function detailGrayscale(layer) {
  const n = layer.width * layer.height;
  let mean = 0;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * layer.data[i * 4] + 0.7152 * layer.data[i * 4 + 1] + 0.0722 * layer.data[i * 4 + 2];
    lum[i] = l;
    mean += l;
  }
  mean = mean / n || 1;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    // Centred on mid-grey so the product keeps the macro colour's brightness, with the
    // texture's own light and shade pushed well clear of flat: this map is the only
    // thing standing between the ground and a painted sheet of colour.
    const v = 128 * (1 + (lum[i] / mean - 1) * 1.5);
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: layer.width, height: layer.height };
}

// sRGB 0..1 to linear 0..1, the transfer function a renderer applies to a colour map.
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// The mean linear value of `detailGrayscale`'s output: it is centred on sRGB 128, and a
// vertex colour has to divide that back out for the product to land on the layer's real
// albedo rather than something arbitrarily darker or brighter.
export const DETAIL_MEAN_LINEAR = srgbToLinear(128 / 255);

// The terrain's macro colour per vertex: the four layers' mean colours blended by the
// splat weights, with slope and low-frequency shading, converted to linear and divided
// by the detail map's own mean — so detail × vertexColour reproduces the layer's true
// albedo, with the map contributing variation and none of its brightness (D166).
// `positions` is the terrain geometry's position buffer (x, y, z per vertex, y already
// the terrain height); returns a Float32Array of linear RGB triples for a `color`
// attribute.
export function terrainVertexColors({ positions, sampleHeight, seed, means }) {
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const h = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const slope = (Math.abs(sampleHeight(x + 1, z) - h) + Math.abs(sampleHeight(x, z + 1) - h)) / 1;
    const w = splatWeights({ height: h, slope, x, z, seed });
    let r = 0;
    let g = 0;
    let b = 0;
    for (let L = 0; L < 4; L++) {
      const m = means[LAYER_NAMES[L]];
      r += m[0] * w[L];
      g += m[1] * w[L];
      b += m[2] * w[L];
    }
    // Two octaves of large-scale shading on top of the slope darkening: real ground is
    // never one tone over a hundred metres, and without this the park reads as a sheet.
    const shade =
      1 -
      Math.min(0.2, slope * 0.08) -
      0.17 * (1 - valueNoise(x * 0.012, z * 0.012, seed + 431)) -
      0.09 * (1 - valueNoise(x * 0.047, z * 0.047, seed + 613));
    const k = shade / DETAIL_MEAN_LINEAR;
    // The layer's own colour, not a saturated version of it: these means come from
    // photographs, and a dry-grass photo averages to a warm khaki, so "more saturation"
    // means "more orange", not "more green". Variety comes from the splat instead.
    out[i * 3] = srgbToLinear(r) * k;
    out[i * 3 + 1] = srgbToLinear(g) * k;
    out[i * 3 + 2] = srgbToLinear(b) * k;
  }
  return out;
}

// A tileable sawn-timber texture: albedo and its normal map, grain running along v.
// The park's built pieces (the cabin, the signs, the crates, the fences) are boards, and
// a board needs grain and a seam between planks or it reads as a coloured box (D166).
// `width` is how many planks fit across the tile.
export function woodGrain({ size = 256, seed = 5, planks = 4, dark = [86, 62, 40], light = [146, 112, 72] }) {
  const albedo = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      // Which plank this column belongs to, and how far across it we are.
      const across = u * planks;
      const plank = Math.floor(across);
      const inPlank = across - plank;
      const tone = hash2(plank, 3, seed); // every board is cut from a different piece
      // Grain: noise stretched hard along the board's length, so it runs in lines.
      const g = valueNoise((u * planks * 9 + tone * 20) % 512, (v * 2.2) % 512, seed + plank * 7);
      const fine = valueNoise((u * planks * 34) % 512, (v * 9) % 512, seed + 101);
      let t = 0.35 + 0.45 * g + 0.2 * fine + (tone - 0.5) * 0.3;
      // The seam between two boards, and the softened edge either side of it.
      const seam = Math.min(inPlank, 1 - inPlank);
      const edge = Math.min(1, seam / 0.045);
      t *= 0.35 + 0.65 * edge;
      t = Math.min(1, Math.max(0, t));
      height[j * size + i] = t;
      const o = (j * size + i) * 4;
      albedo[o] = dark[0] + (light[0] - dark[0]) * t;
      albedo[o + 1] = dark[1] + (light[1] - dark[1]) * t;
      albedo[o + 2] = dark[2] + (light[2] - dark[2]) * t;
      albedo[o + 3] = 255;
    }
  }
  const normal = new Uint8ClampedArray(size * size * 4);
  const at = (i, j) => height[((j + size) % size) * size + ((i + size) % size)];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const hx = at(i + 1, j) - at(i - 1, j);
      const hy = at(i, j + 1) - at(i, j - 1);
      const inv = 1 / Math.hypot(hx * 3, hy * 3, 1);
      const o = (j * size + i) * 4;
      normal[o] = (-hx * 3 * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (-hy * 3 * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  return { albedo, normal, size };
}

// An alpha-cutout foliage card: one branch spray drawn into a square RGBA sprite, with a
// matching tangent-space normal map. This is what makes a tree read as a tree rather than
// a cone (D166): the renderer builds each tree from a few dozen of these quads, so the
// silhouette is needles and gaps, not a solid shell. The spray grows from the left edge
// (the branch's attachment) toward the right (its tip), so a card can be rotated into
// place around a trunk without further thought.
//
//   kind 'needle'  a conifer frond: a tapering stem with needles swept toward the tip
//   kind 'leaf'    a broadleaf spray: oval leaves either side of a thin twig
//
// Returns { albedo, normal, size } as RGBA byte buffers; alpha is 0 off the foliage.
export function foliageCard({ size = 256, seed = 7, kind = 'needle', base = [38, 62, 30], tip = [104, 140, 64] }) {
  const albedo = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const px = (u, v) => [Math.round(u * (size - 1)), Math.round(v * (size - 1))];
  // Paints one blade/leaf as a capsule between (x0,y0) and (x1,y1) in uv space, only over
  // its own bounding box, with `shade` picking the colour between base and tip.
  const stroke = (x0, y0, x1, y1, halfWidth, shade, round) => {
    const [ax, ay] = px(x0, y0);
    const [bx, by] = px(x1, y1);
    const r = halfWidth * size;
    const lo = (v, m) => Math.max(0, Math.floor(Math.min(v, m) - r - 1));
    const hi = (v, m, cap) => Math.min(cap - 1, Math.ceil(Math.max(v, m) + r + 1));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let j = lo(ay, by); j <= hi(ay, by, size); j++) {
      for (let i = lo(ax, bx); i <= hi(ax, bx, size); i++) {
        let t = ((i - ax) * dx + (j - ay) * dy) / len2;
        t = Math.min(1, Math.max(0, t));
        const cx = ax + dx * t;
        const cy = ay + dy * t;
        const d = Math.hypot(i - cx, j - cy);
        // A blade thins toward its tip; a leaf keeps its width and rounds off.
        const w = round ? r * Math.sqrt(Math.max(0.0001, 1 - (2 * t - 1) ** 2)) : r * (1 - 0.85 * t);
        if (d > w) continue;
        const profile = Math.sqrt(Math.max(0, 1 - (d / Math.max(w, 0.001)) ** 2));
        const o = (j * size + i) * 4;
        const s = Math.min(1, shade * (0.75 + 0.45 * profile));
        const r8 = base[0] + (tip[0] - base[0]) * s;
        const g8 = base[1] + (tip[1] - base[1]) * s;
        const b8 = base[2] + (tip[2] - base[2]) * s;
        if (profile >= height[j * size + i]) {
          albedo[o] = r8;
          albedo[o + 1] = g8;
          albedo[o + 2] = b8;
          height[j * size + i] = profile;
        }
        albedo[o + 3] = 255;
      }
    }
  };

  if (kind === 'leaf') {
    stroke(0.02, 0.5, 0.95, 0.5, 0.012, 0.25, false); // the twig
    const leaves = 26;
    for (let i = 0; i < leaves; i++) {
      const t = 0.08 + (i / leaves) * 0.86;
      const side = i % 2 ? 1 : -1;
      const j = hash2(i, 3, seed);
      const ang = side * (0.6 + j * 0.5) - 0.25; // fanned forward
      const len = 0.3 * (1 - 0.45 * t) * (0.75 + j * 0.5);
      stroke(t, 0.5, t + Math.cos(ang) * len * 0.7, 0.5 + Math.sin(ang) * len, 0.055 * (0.8 + j * 0.5), 0.45 + j * 0.55, true);
    }
  } else {
    stroke(0.01, 0.5, 0.99, 0.5, 0.016, 0.2, false); // the stem
    const needles = 110;
    for (let i = 0; i < needles; i++) {
      const t = 0.03 + (i / needles) * 0.95;
      const side = i % 2 ? 1 : -1;
      const j = hash2(i, 11, seed);
      // Swept back toward the tip, the way a fir frond lies.
      const ang = side * (1.15 - 0.55 * t) * (0.85 + j * 0.3);
      const len = 0.3 * (1 - 0.7 * t) * (0.7 + j * 0.6);
      stroke(t, 0.5, t + Math.cos(ang) * len * 0.55, 0.5 + Math.sin(ang) * len, 0.0075 * (0.8 + j * 0.6), 0.35 + j * 0.65, false);
    }
  }

  const normal = new Uint8ClampedArray(size * size * 4);
  const at = (i, j) => height[Math.min(size - 1, Math.max(0, j)) * size + Math.min(size - 1, Math.max(0, i))];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const hx = at(i + 1, j) - at(i - 1, j);
      const hy = at(i, j + 1) - at(i, j - 1);
      const inv = 1 / Math.hypot(hx * 2, hy * 2, 1);
      const o = (j * size + i) * 4;
      normal[o] = (-hx * 2 * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (-hy * 2 * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  return { albedo, normal, size };
}
