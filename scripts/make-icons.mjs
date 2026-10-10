#!/usr/bin/env node
// Renders the Maka app icons with Node core modules only (no image library, nothing of
// unknown origin): the park mark (a cream mountain on a green rounded square, a sun) as
// PNGs at the sizes Tauri's bundler wants, an ICNS that wraps the PNGs (Apple's format
// allows PNG payloads for the ic07..ic10 sizes), and a monochrome template PNG for the
// menu bar item. Deterministic: the same bytes every run, which test/shell.test.js checks
// against the committed files.
//
//   node scripts/make-icons.mjs [outDir]      default src-tauri/icons

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const GREEN = [0x4f, 0x8a, 0x3f];
const CREAM = [0xf1, 0xe9, 0xd2];
const SUN = [0xff, 0xd3, 0x6b];

// Signed distance helpers in unit coordinates (0..1), y down.
function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
const inCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r;

// The app mark: returns [r, g, b, a] for a unit-square sample.
export function markSample(x, y) {
  if (!inRoundedSquare(x, y, 0.22)) return [0, 0, 0, 0];
  if (inTriangle(x, y, [0.17, 0.79], [0.5, 0.24], [0.83, 0.79])) return [...CREAM, 255];
  if (inCircle(x, y, 0.75, 0.3, 0.075)) return [...SUN, 255];
  return [...GREEN, 255];
}

// The menu bar template: a black mountain silhouette with a sun; macOS tints it.
export function traySample(x, y) {
  if (inTriangle(x, y, [0.06, 0.9], [0.5, 0.14], [0.94, 0.9])) return [0, 0, 0, 255];
  if (inCircle(x, y, 0.8, 0.22, 0.1)) return [0, 0, 0, 255];
  return [0, 0, 0, 0];
}

// Supersampled raster of a sampler at size n.
export function raster(n, sample, ss = 3) {
  const px = Buffer.alloc(n * n * 4);
  const inv = 1 / (ss * ss);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const [cr, cg, cb, ca] = sample((i + (si + 0.5) / ss) / n, (j + (sj + 0.5) / ss) / n);
          // Premultiplied accumulation, then un-premultiply so edges keep the shape colour.
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = (j * n + i) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round(a * inv);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePng(n, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(n * (n * 4 + 1));
  for (let j = 0; j < n; j++) {
    rows[j * (n * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, j * (n * 4 + 1) + 1, j * n * 4, (j + 1) * n * 4);
  }
  const idat = zlib.deflateSync(rows, { level: 9 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ICNS: 'icns' + total length, then one entry per size: type + length + PNG bytes.
const ICNS_TYPES = { 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
export function encodeIcns(pngsBySize) {
  const entries = [];
  for (const [size, type] of Object.entries(ICNS_TYPES)) {
    const png = pngsBySize[size];
    if (!png) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(png.length + 8, 4);
    entries.push(head, png);
  }
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

export function renderAll() {
  const pngs = {};
  for (const n of [32, 128, 256, 512, 1024]) pngs[n] = encodePng(n, raster(n, markSample));
  return {
    '32x32.png': pngs[32],
    '128x128.png': pngs[128],
    '128x128@2x.png': pngs[256],
    'icon.png': pngs[1024],
    'icon.icns': encodeIcns(pngs),
    'tray.png': encodePng(44, raster(44, traySample, 4)),
  };
}

async function main() {
  const out = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons'));
  await fsp.mkdir(out, { recursive: true });
  const files = renderAll();
  for (const [name, bytes] of Object.entries(files)) {
    await fsp.writeFile(path.join(out, name), bytes);
    console.log(`${name}\t${bytes.length} bytes`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
