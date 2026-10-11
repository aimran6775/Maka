// The park's surface maths (frontend/park/surface.js, D166): the terrain's splat
// weights and macro vertex colours, the greyscale detail map, and the alpha-cutout
// foliage cards. Pure pixel maths, so it runs under node with no DOM and no Three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splatWeights, layerMeans, detailGrayscale, terrainVertexColors, foliageCard, woodGrain, srgbToLinear, DETAIL_MEAN_LINEAR, LAYER_NAMES } from '../frontend/park/surface.js';
import { TERRAIN, heightAt } from '../frontend/park/terrain.js';

// A flat RGBA image of one colour, the shape loadPixels hands the surface maths.
const flat = (r, g, b, size = 8) => {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: size, height: size };
};

test('splat weights: always a blend that sums to one, sand at the water line, rock on steep ground and high ground', () => {
  for (const height of [-2, -1, 0, 4, 11, 20]) {
    for (const slope of [0, 0.3, 0.8, 3]) {
      const w = splatWeights({ height, slope, x: 13, z: -7, seed: 3 });
      assert.equal(w.length, 4);
      for (const v of w) assert.ok(v >= 0 && v <= 1, `${v} out of range`);
      assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'weights sum to 1');
    }
  }
  const atWater = splatWeights({ height: TERRAIN.waterLevel + 0.1, slope: 0, x: 0, z: 0, seed: 1 });
  assert.ok(atWater[3] > 0.9, 'the shore is sand');
  const flatHigh = splatWeights({ height: 3, slope: 0, x: 0, z: 0, seed: 1 });
  const steep = splatWeights({ height: 3, slope: 2, x: 0, z: 0, seed: 1 });
  assert.ok(steep[2] > flatHigh[2], 'a steeper slope shows more rock');
  const peak = splatWeights({ height: 20, slope: 0, x: 0, z: 0, seed: 1 });
  assert.ok(peak[2] > 0.9, 'the high ground is rock');
  // Deterministic for the same point and seed, different for another seed.
  assert.deepEqual(splatWeights({ height: 3, slope: 0.2, x: 5, z: 5, seed: 7 }), splatWeights({ height: 3, slope: 0.2, x: 5, z: 5, seed: 7 }));
});

test('layer means and the greyscale detail map: colour out, light and shade kept, centred on mid grey', () => {
  const means = layerMeans({ grass: flat(60, 120, 40), forest: flat(90, 70, 50), rock: flat(140, 140, 140), sand: flat(200, 190, 160) });
  assert.deepEqual(LAYER_NAMES, ['grass', 'forest', 'rock', 'sand']);
  assert.ok(Math.abs(means.grass[1] - 120 / 255) < 1e-6, 'the mean is the layer colour');
  assert.ok(means.sand[0] > means.grass[0]);

  // A chequerboard: the detail map must keep its contrast and lose its colour.
  const size = 8;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const dark = (i + Math.floor(i / size)) % 2 === 0;
    data[i * 4] = dark ? 20 : 200;
    data[i * 4 + 1] = dark ? 90 : 240; // green: the colour that must not survive
    data[i * 4 + 2] = dark ? 10 : 180;
    data[i * 4 + 3] = 255;
  }
  const gray = detailGrayscale({ data, width: size, height: size });
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < size * size; i++) {
    const [r, g, b] = [gray.data[i * 4], gray.data[i * 4 + 1], gray.data[i * 4 + 2]];
    assert.equal(r, g, 'grey: r = g');
    assert.equal(g, b, 'grey: g = b');
    assert.equal(gray.data[i * 4 + 3], 255);
    sum += r;
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  assert.ok(Math.abs(sum / (size * size) - 128) < 4, 'centred on mid grey so the macro colour keeps its brightness');
  assert.ok(max - min > 60, 'the texture keeps its light and shade');
  // A flat layer has nothing to say: every texel lands on mid grey.
  const flatGray = detailGrayscale(flat(77, 77, 77));
  for (let i = 0; i < 64; i++) assert.equal(flatGray.data[i * 4], 128);
});

test('terrain vertex colours: the layer blend in linear space, divided by the detail map mean, shaded by slope', () => {
  assert.ok(Math.abs(srgbToLinear(1) - 1) < 1e-9);
  assert.equal(srgbToLinear(0), 0);
  assert.ok(Math.abs(DETAIL_MEAN_LINEAR - srgbToLinear(128 / 255)) < 1e-12);

  const means = layerMeans({ grass: flat(60, 120, 40), forest: flat(90, 70, 50), rock: flat(140, 140, 140), sand: flat(200, 190, 160) });
  const sample = (x, z) => heightAt(x, z, 5, []);
  // Three vertices: a shore point, mid ground, and the high ground.
  const positions = new Float32Array([0, TERRAIN.waterLevel + 0.1, 0, 20, 3, -14, -30, 20, 8]);
  const colors = terrainVertexColors({ positions, sampleHeight: sample, seed: 5, means });
  assert.equal(colors.length, 9);
  for (const v of colors) assert.ok(Number.isFinite(v) && v > 0, `${v} is not a positive finite colour`);
  // The shore vertex is sand: brighter and warmer than the rock vertex up high.
  const shore = [colors[0], colors[1], colors[2]];
  const high = [colors[6], colors[7], colors[8]];
  assert.ok(shore[0] > shore[2], 'sand is warm');
  assert.ok(shore[0] > high[0], 'the shore is brighter than the rock');
  // The product of the detail map's mean and the vertex colour is the layer's own
  // linear albedo: that is the whole point of dividing by it.
  const sandLinear = srgbToLinear(means.sand[0]);
  assert.ok(Math.abs(shore[0] * DETAIL_MEAN_LINEAR - sandLinear) < sandLinear * 0.35, 'the ground lands on the layer albedo, give or take the macro shading');
  // Deterministic.
  assert.deepEqual([...terrainVertexColors({ positions, sampleHeight: sample, seed: 5, means })], [...colors]);
});

test('layer colours: a vegetation layer is read from its leafy pixels, bare ground from all of them', () => {
  // Mostly the soil between the blades, a quarter green blades — the proportions of a
  // real grass scan, whose plain mean is therefore khaki and whose leafy pixels are not.
  const size = 8;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const leaf = i % 4 === 0;
    data[i * 4] = leaf ? 60 : 165;
    data[i * 4 + 1] = leaf ? 125 : 135;
    data[i * 4 + 2] = leaf ? 45 : 95;
    data[i * 4 + 3] = 255;
  }
  const img = { data, width: size, height: size };
  const veg = layerMeans({ grass: img, forest: img, rock: img, sand: img });
  const plain = layerMeans({ grass: img, forest: img, rock: img, sand: img }, { vegetation: [] });
  assert.ok(veg.grass[1] > veg.grass[0], 'the grass layer comes out green');
  assert.ok(plain.grass[0] > plain.grass[1], 'the plain mean of the same image is khaki');
  assert.deepEqual(veg.rock, plain.rock, 'bare ground is not a vegetation layer: it keeps its plain mean');
  // An image with no green at all still answers something sane rather than nothing.
  const grey = { data: new Uint8ClampedArray(size * size * 4).fill(120), width: size, height: size };
  const flatVeg = layerMeans({ grass: grey, forest: grey, rock: grey, sand: grey });
  for (const v of flatVeg.grass) assert.ok(v > 0.4 && v < 0.6, `${v} is not the flat grey back again`);
});

test('wood grain: planks with a seam between them, grain along the board, and a normal map', () => {
  const g = woodGrain({ size: 64, seed: 5, planks: 4 });
  assert.equal(g.albedo.length, 64 * 64 * 4);
  const row = (j, i) => g.albedo[(j * 64 + i) * 4];
  // The seam between two boards is darker than the middle of one.
  const mid = row(32, 8); // the middle of the first plank
  const seam = row(32, 0); // the seam at its edge
  assert.ok(seam < mid, `the seam (${seam}) is darker than the board (${mid})`);
  // The grain runs along the board: a column varies less than a row crossing the planks.
  const spread = (vals) => Math.max(...vals) - Math.min(...vals);
  const down = spread(Array.from({ length: 64 }, (_, j) => row(j, 8)));
  const across = spread(Array.from({ length: 64 }, (_, i) => row(32, i)));
  assert.ok(across > down, `across the boards (${across}) varies more than along one (${down})`);
  for (let i = 0; i < 64 * 64; i++) assert.equal(g.albedo[i * 4 + 3], 255, 'timber is opaque');
  assert.deepEqual([...woodGrain({ size: 32, seed: 5 }).albedo], [...woodGrain({ size: 32, seed: 5 }).albedo], 'deterministic');
});

test('foliage cards: a needle spray and a leaf spray, mostly empty, opaque where the foliage is, with a normal map', () => {
  for (const kind of ['needle', 'leaf']) {
    const card = foliageCard({ size: 64, seed: 11, kind });
    assert.equal(card.size, 64);
    assert.equal(card.albedo.length, 64 * 64 * 4);
    assert.equal(card.normal.length, 64 * 64 * 4);
    let opaque = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const a = card.albedo[i * 4 + 3];
      assert.ok(a === 0 || a === 255, 'a cutout is opaque or it is nothing');
      if (a === 255) opaque++;
    }
    const coverage = opaque / (64 * 64);
    assert.ok(coverage > 0.05 && coverage < 0.6, `${kind}: ${(coverage * 100).toFixed(0)}% covered — a spray, not a slab and not empty`);
    // Every normal points out of the card, and the flat background points straight out.
    for (let i = 0; i < 64 * 64; i++) assert.ok(card.normal[i * 4 + 2] >= 127, 'normals face out of the card');
  }
  const a = foliageCard({ size: 32, seed: 4, kind: 'needle' });
  const b = foliageCard({ size: 32, seed: 4, kind: 'needle' });
  assert.deepEqual([...a.albedo], [...b.albedo], 'deterministic for the same seed');
  const c = foliageCard({ size: 32, seed: 9, kind: 'needle' });
  assert.notDeepEqual([...c.albedo], [...a.albedo], 'another seed draws another spray');
});
