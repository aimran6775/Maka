#!/usr/bin/env node
// Downloads the third-party files the park needs (Three.js and the licensed 3D kits),
// verifies each archive against its pinned SHA-256, and extracts only the files Maka uses:
//   frontend/vendor/three/   the Three.js ES-module build and the addons the park imports
//   frontend/assets/<pack>/  the GLB/FBX/texture files the park loads
// Node core modules only (zip and tar.gz readers are inline).
//
//   node scripts/fetch-assets.mjs            download, verify, extract, write the manifest
//   node scripts/fetch-assets.mjs --check    verify the vendored files match the manifest
//
// The extracted files are committed so the app works offline and inside the Tauri bundle;
// this script is how they are reproduced and how their provenance is proven. Licenses are
// recorded in NOTICE.md and in frontend/assets/manifest.json.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'frontend', 'assets', 'manifest.json');

const THREE_VERSION = '0.186.1';
const THREE_ADDONS = [
  'controls/OrbitControls.js',
  'loaders/GLTFLoader.js',
  'loaders/FBXLoader.js',
  'curves/NURBSCurve.js',
  'curves/NURBSUtils.js',
  'utils/BufferGeometryUtils.js',
  'utils/SkeletonUtils.js',
  'objects/Sky.js',
  'objects/SkyMesh.js', // the TSL sky for the WebGPU path (phase 4 step 15)
  'libs/fflate.module.js',
];

// Pinned sources. URLs and hashes were verified on 2026-10-10; a changed hash means the
// upstream archive changed and must be re-reviewed before the pin is updated. `root` is
// where the files land; `files` maps archive paths to published paths under it.
export const SOURCES = [
  {
    id: 'three',
    title: `Three.js ${THREE_VERSION}`,
    author: 'Three.js Authors',
    license: 'MIT',
    page: 'https://threejs.org/',
    url: `https://registry.npmjs.org/three/-/three-${THREE_VERSION}.tgz`,
    sha256: '8cd068708ea44f2c73c944b1cead2ba2f0d5c15c8fc194e5700f4e4f4a033fe7',
    licenseEvidence: 'LICENSE in the npm tarball (MIT); fflate.module.js carries its own MIT header',
    kind: 'tgz',
    root: 'frontend/vendor/three',
    files: [
      { from: 'package/LICENSE', to: 'LICENSE' },
      { from: 'package/build/three.core.js', to: 'three.core.js' },
      { from: 'package/build/three.module.js', to: 'three.module.js', note: 'WebGL2 build; imports ./three.core.js' },
      { from: 'package/build/three.webgpu.js', to: 'three.webgpu.js', note: 'WebGPU build (WebGPURenderer, node materials); imports ./three.core.js; loaded on demand when the park chooses WebGPU (phase 4 step 15)' },
      { from: 'package/build/three.tsl.js', to: 'three.tsl.js', note: 'Three Shading Language; imports three/webgpu' },
      ...THREE_ADDONS.map((f) => ({ from: `package/examples/jsm/${f}`, to: `addons/${f}` })),
    ],
  },
  {
    // The npm tarball ships no example textures; the same MIT repo serves them at the tag.
    id: 'three-examples',
    title: `Three.js ${THREE_VERSION} example textures`,
    author: 'Three.js Authors',
    license: 'MIT',
    page: 'https://github.com/mrdoob/three.js',
    licenseEvidence: 'LICENSE at the repository root (MIT) covers examples/textures',
    kind: 'files',
    root: 'frontend/vendor/three/textures',
    files: [
      { url: 'https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/textures/waternormals.jpg', sha256: 'add9912b158a4fe9c12421745babe68c44c8af75631ac4837236cb2a03bc373f', to: 'waternormals.jpg' },
    ],
  },
  {
    id: 'kenney-nature-kit',
    title: 'Nature Kit',
    author: 'Kenney',
    license: 'CC0-1.0',
    page: 'https://kenney.nl/assets/nature-kit',
    url: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip',
    sha256: 'fa7974a0d342bfe63c38664ba9f8ec1a4aab8ea25f099bdc56870e33588c4d9d',
    licenseEvidence: 'License.txt inside the archive: "License (Creative Commons Zero, CC0)"',
    kind: 'zip',
    root: 'frontend/assets/nature-kit',
    files: ['tree_pineTallA', 'tree_pineRoundA', 'tree_oak', 'tree_default', 'rock_largeA', 'rock_largeB', 'rock_smallA', 'sign', 'campfire_logs', 'fence_simple', 'fence_gate', 'tent_detailedOpen'].map((n) => ({ from: `Models/GLTF format/${n}.glb`, to: `${n}.glb` })),
  },
  {
    id: 'kenney-survival-kit',
    title: 'Survival Kit',
    author: 'Kenney',
    license: 'CC0-1.0',
    page: 'https://kenney.nl/assets/survival-kit',
    url: 'https://kenney.nl/media/pages/assets/survival-kit/4065a8185b-1712149243/kenney_survival-kit.zip',
    sha256: 'c3586341b5932c87eb43d75d915434f47daed168b17ed36a03e8ca9977c7443e',
    licenseEvidence: 'License.txt inside the archive: "License (Creative Commons Zero, CC0)"',
    kind: 'zip',
    root: 'frontend/assets/survival-kit',
    files: [
      ...['structure', 'tent', 'campfire-pit', 'signpost', 'chest', 'box', 'fence', 'fence-doorway'].map((n) => ({ from: `Models/GLB format/${n}.glb`, to: `${n}.glb` })),
      { from: 'Models/GLB format/Textures/colormap.png', to: 'Textures/colormap.png', note: 'referenced by the GLBs as Textures/colormap.png' },
    ],
  },
  {
    id: 'kenney-animated-characters-protagonists',
    title: 'Animated Characters Protagonists',
    author: 'Kenney',
    license: 'CC0-1.0',
    page: 'https://kenney.nl/assets/animated-characters-protagonists',
    url: 'https://kenney.nl/media/pages/assets/animated-characters-protagonists/608191acc4-1774773108/kenney_animated-characters-protagonists.zip',
    sha256: 'ec3787de70fa2200256848d74201b10f6b6c3126594e9857bf989753312c2b84',
    licenseEvidence: 'License.txt inside the archive: "License: (Creative Commons Zero, CC0)"',
    kind: 'zip',
    root: 'frontend/assets/characters',
    files: [
      { from: 'Model/characterMedium.fbx', to: 'characterMedium.fbx', note: 'rigged body (binary FBX; the pack ships no glTF)' },
      { from: 'Animations/idle.fbx', to: 'idle.fbx' },
      { from: 'Animations/run.fbx', to: 'run.fbx' },
      { from: 'Skins/skaterMaleA.png', to: 'skaterMaleA.png', note: 'the Ranger skin' },
    ],
  },
  {
    id: 'kenney-animated-characters-survivors',
    title: 'Animated Characters Survivors',
    author: 'Kenney',
    license: 'CC0-1.0',
    page: 'https://kenney.nl/assets/animated-characters-survivors',
    url: 'https://kenney.nl/media/pages/assets/animated-characters-survivors/27b16052a7-1774772958/kenney_animated-characters-survivors.zip',
    sha256: 'fdadced07a0454c9b7f0b46507be6144a072b4d03b4ffa37f225893c76c62845',
    licenseEvidence: 'License.txt inside the archive: "License: (Creative Commons Zero, CC0)"',
    kind: 'zip',
    root: 'frontend/assets/characters-survivors',
    files: [], // pinned and verified; same rig as Protagonists, nothing drawn from it yet
  },
  // Poly Haven (CC0) PBR textures and photoscanned models for the park's realistic look
  // (2026-10-11, the owner's ask). Loose files (kind 'files'), each pinned by its own
  // SHA-256; md5s were verified against api.polyhaven.com when the pins were taken.
  {
    id: 'polyhaven-leafy-grass',
    title: 'Leafy Grass',
    author: 'Charlotte Baglioni (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/leafy_grass',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_diff_1k.jpg', sha256: 'cfa40bc9d9417d1852db8753a8d5917f110c40101179f63543c382e39bc05e4a', to: 'leafy_grass_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_nor_gl_1k.jpg', sha256: '832328216adc0a7e1f70a31d5ee48c9ab7f2152d83816122736cf42ac4b2ebd6', to: 'leafy_grass_nor_gl_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_arm_1k.jpg', sha256: '95432451cb2693794459fe7ea339ea9ffdb5959c40373740f80a4aa1703f089d', to: 'leafy_grass_arm_1k.jpg' },
    ],
  },
  {
    id: 'polyhaven-forest-leaves-04',
    title: 'Forest Leaves 04',
    author: 'Rob Tuytel (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/forest_leaves_04',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/forest_leaves_04/forest_leaves_04_diff_1k.jpg', sha256: 'a898e6ef0668a40faaf1bcbc6b024f6ef437ec424a10fa47aa6d35d013c9dade', to: 'forest_leaves_04_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/forest_leaves_04/forest_leaves_04_nor_gl_1k.jpg', sha256: '6b7c4086fc28b7b1f11f4d04aedcc27772ce3bb894cfc00835b4637092c1bb0c', to: 'forest_leaves_04_nor_gl_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/forest_leaves_04/forest_leaves_04_arm_1k.jpg', sha256: 'e253ba0615d1da2376a18d8edf26dd02a0be92e5729efd3402be02f7f2ae53be', to: 'forest_leaves_04_arm_1k.jpg' },
    ],
  },
  {
    id: 'polyhaven-rock-face',
    title: 'Rock Face',
    author: 'Greg Zaal, Dario Barresi (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/rock_face',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/rock_face/rock_face_diff_1k.jpg', sha256: 'cce4b50517161264bdef196f5e247e328ca3739083cd6044ad3cc54d88cb82e2', to: 'rock_face_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/rock_face/rock_face_nor_gl_1k.jpg', sha256: 'e2682e1286c8b6aca7e01ba7b8fe1726cb6606042b9ee70d097aa67470d410ef', to: 'rock_face_nor_gl_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/rock_face/rock_face_arm_1k.jpg', sha256: '3a0fce8658ba2bac6690f68e79630c16e004f1676c1588ef4d54906fc3907616', to: 'rock_face_arm_1k.jpg' },
    ],
  },
  {
    id: 'polyhaven-sandy-gravel',
    title: 'Sandy Gravel',
    author: 'Charlotte Baglioni (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/sandy_gravel',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/sandy_gravel/sandy_gravel_diff_1k.jpg', sha256: '38829e669dc246e86b7ce94c4141485709988450b13f82cfc4bc6067dd69ed48', to: 'sandy_gravel_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/sandy_gravel/sandy_gravel_nor_gl_1k.jpg', sha256: 'f2a4c48f31cd5ad5e2b0488e89c94d284c5a2acd4367bec49a5f48f832b7e3da', to: 'sandy_gravel_nor_gl_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/sandy_gravel/sandy_gravel_arm_1k.jpg', sha256: 'ae13c0de981ab78abc39e3bec6147a06448e0865f4162cd57d54ada411df0de7', to: 'sandy_gravel_arm_1k.jpg' },
    ],
  },
  {
    id: 'polyhaven-pine-bark',
    title: 'Pine Bark',
    author: 'Dimitrios Savva (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/pine_bark',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/pine_bark/pine_bark_diff_1k.jpg', sha256: '89ddfbff0388d30caff902ba600cdf75eb1e651ca71ece6594b5a9b27abb47ab', to: 'pine_bark_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/pine_bark/pine_bark_nor_gl_1k.jpg', sha256: '666e5f175a010f12577687dd8029125bff99110e6a97958afb295b34266437db', to: 'pine_bark_nor_gl_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/pine_bark/pine_bark_arm_1k.jpg', sha256: '1ba20ec25c9f43327d6aa0ea809917854cff553ad7f21fb548e853a5b5ec701a', to: 'pine_bark_arm_1k.jpg' },
    ],
  },
  {
    id: 'polyhaven-boulder-01',
    title: 'Boulder 01',
    author: 'Rico Cilliers (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/boulder_01',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/boulder_01/boulder_01_1k.gltf', sha256: '51487934db898b4c24072780a451e34eca5c02e3ada24a62bbc600bbc4019e92', to: 'boulder_01/boulder_01_1k.gltf' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/boulder_01/boulder_01_arm_1k.jpg', sha256: 'c57187c5746b6be913fa53846cb44ff78743e7ca5000f131c9627b99563c2b87', to: 'boulder_01/textures/boulder_01_arm_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/boulder_01/boulder_01_diff_1k.jpg', sha256: 'c38f0e918f6dc16b8d386ba3cdd89805c78320c119a1ceec85856f82b09a65b8', to: 'boulder_01/textures/boulder_01_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/boulder_01/boulder_01.bin', sha256: '7f5b06503d62bd95bfe9c6b8a354a5cc8ff04a4d271a8cf87a3e3125db4232d7', to: 'boulder_01/boulder_01.bin' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/boulder_01/boulder_01_nor_gl_1k.jpg', sha256: '0810cf6e89d89bb6eb065b4d2e2855288f5dcbd2c15c6e40ab90d462021b50aa', to: 'boulder_01/textures/boulder_01_nor_gl_1k.jpg' },
    ],
  },
  {
    id: 'polyhaven-grass-medium-02',
    title: 'Grass Medium 02',
    author: 'Rico Cilliers (Poly Haven)',
    license: 'CC0-1.0',
    page: 'https://polyhaven.com/a/grass_medium_02',
    licenseEvidence: 'polyhaven.com/license: all Poly Haven assets are CC0',
    kind: 'files',
    root: 'frontend/assets/polyhaven',
    files: [
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/grass_medium_02/grass_medium_02_1k.gltf', sha256: '7037f8d2dfc6aeec0bf72f4eeb96cfa3f6b3a5e6c6f0bc5de537c055b2fd5d04', to: 'grass_medium_02/grass_medium_02_1k.gltf' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_medium_02/grass_medium_02_nor_gl_1k.jpg', sha256: '0b464550366ed72a6cad9c357e19ac4c83fc9adc87272771479138129853b300', to: 'grass_medium_02/textures/grass_medium_02_nor_gl_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_medium_02/grass_medium_02_diff_1k.jpg', sha256: '91ae99005b449011aceb207a68a937258fd9bfd66ff367d344c50398b1df389c', to: 'grass_medium_02/textures/grass_medium_02_diff_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/grass_medium_02/grass_medium_02_arm_1k.jpg', sha256: 'f0d57bfd95bff7710526b49d47cf2326ee3796e425639d53b983d1472480b57d', to: 'grass_medium_02/textures/grass_medium_02_arm_1k.jpg' },
      { url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/grass_medium_02/grass_medium_02.bin', sha256: 'aa8493bc1544a89e08bf440c7ba361042bfe6ea48b1fefc7e4af2dfff42fdf4a', to: 'grass_medium_02/grass_medium_02.bin' },
    ],
  },
];

// Named in the brief as a fallback rig. itch.io serves downloads through a per-session
// token, not a stable URL, so it cannot be pinned here. Recorded so the manifest says so.
export const UNPINNED = [
  { id: 'quaternius-ultimate-platformer-pack', title: 'Ultimate Platformer Pack', author: 'Quaternius', license: 'CC0-1.0', page: 'https://quaternius.itch.io/ultimate-platformer-pack', status: 'not fetched: itch.io has no stable direct download URL to pin' },
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Minimal ZIP reader: central directory → entries; supports stored (0) and deflate (8).
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    entries.set(name, { method, csize, usize, offset });
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} is not in the archive`);
      if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('bad local header');
      const nlen = buf.readUInt16LE(e.offset + 26);
      const xlen = buf.readUInt16LE(e.offset + 28);
      const start = e.offset + 30 + nlen + xlen;
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) {
        const out = inflateRawSync(data);
        if (out.length !== e.usize) throw new Error(`${name}: size mismatch after inflate`);
        return out;
      }
      throw new Error(`${name}: unsupported compression method ${e.method}`);
    },
  };
}

// Minimal tar.gz reader (ustar, as npm publishes): 512-byte headers, size in octal.
export function readTgz(buf) {
  const tar = gunzipSync(buf);
  const entries = new Map();
  let p = 0;
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const start = p + 512;
    if (type === '0' || type === '\0') entries.set(name, { start, size });
    p = start + Math.ceil(size / 512) * 512;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} is not in the archive`);
      return Buffer.from(tar.subarray(e.start, e.start + e.size));
    },
  };
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchAll({ log = console, fetchImpl = download } = {}) {
  const manifest = {
    generatedBy: 'scripts/fetch-assets.mjs',
    note: 'Every file below was extracted from an archive whose SHA-256 matched the pin. Licenses: see NOTICE.md.',
    sources: [],
    unpinned: UNPINNED,
  };
  let total = 0;
  for (const src of SOURCES) {
    log.info(`fetching ${src.title} …`);
    // kind 'files': loose files (Poly Haven), each pinned by its own SHA-256.
    if (src.kind === 'files') {
      const files = [];
      for (const f of src.files) {
        const data = await fetchImpl(f.url);
        const got = sha256(data);
        if (got !== f.sha256) throw new Error(`${src.id}: ${f.to} hash ${got} does not match the pinned ${f.sha256}; refusing to keep it`);
        const dest = path.join(ROOT, src.root, f.to);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, data);
        total += data.length;
        files.push({ url: f.url, to: f.to, sha256: got, bytes: data.length });
        log.info(`  ${f.url.split('/').pop()} → ${src.root}/${f.to} (${data.length} bytes)`);
      }
      manifest.sources.push({ id: src.id, title: src.title, author: src.author, license: src.license, page: src.page, licenseEvidence: src.licenseEvidence, kind: 'files', root: src.root, files });
      continue;
    }
    const buf = await fetchImpl(src.url);
    const got = sha256(buf);
    if (got !== src.sha256) throw new Error(`${src.id}: archive hash ${got} does not match the pinned ${src.sha256}; refusing to extract`);
    const archive = src.kind === 'tgz' ? readTgz(buf) : readZip(buf);
    const files = [];
    for (const f of src.files) {
      const data = archive.read(f.from);
      const dest = path.join(ROOT, src.root, f.to);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
      total += data.length;
      files.push({ from: f.from, to: f.to, sha256: sha256(data), bytes: data.length, ...(f.note ? { note: f.note } : {}) });
      log.info(`  ${f.from} → ${src.root}/${f.to} (${data.length} bytes)`);
    }
    manifest.sources.push({ id: src.id, title: src.title, author: src.author, license: src.license, page: src.page, url: src.url, archiveSha256: src.sha256, licenseEvidence: src.licenseEvidence, root: src.root, files });
  }
  await fsp.mkdir(path.dirname(MANIFEST), { recursive: true });
  await fsp.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  log.info(`wrote ${path.relative(ROOT, MANIFEST)} (${(total / 1024 / 1024).toFixed(2)} MB of vendored files)`);
  return manifest;
}

// Verifies that every vendored file matches the manifest hash and that every manifest
// source is one of the pinned SOURCES. Returns a list of problems (empty = ok).
export async function checkVendored() {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
  } catch (err) {
    return [`manifest unreadable: ${err.message}`];
  }
  let total = 0;
  for (const s of manifest.sources) {
    const pinned = SOURCES.find((p) => p.id === s.id);
    if (!pinned) problems.push(`${s.id}: not a pinned source`);
    else if (pinned.kind === 'files') {
      // Loose files: every manifest file's hash must be one of this source's pins.
      for (const f of s.files) {
        const pin = pinned.files.find((pf) => pf.to === f.to);
        if (!pin) problems.push(`${s.id}: ${f.to} is not a pinned file`);
        else if (pin.sha256 !== f.sha256) problems.push(`${s.id}: ${f.to} manifest hash differs from the pin`);
      }
    } else if (pinned.sha256 !== s.archiveSha256) problems.push(`${s.id}: manifest archive hash differs from the pin`);
    if (!/^CC0-1\.0$|^CC-BY-4\.0$|^MIT$/.test(s.license)) problems.push(`${s.id}: license ${s.license} is not CC0, CC-BY or MIT`);
    for (const f of s.files) {
      try {
        const data = await fsp.readFile(path.join(ROOT, s.root, f.to));
        total += data.length;
        if (sha256(data) !== f.sha256) problems.push(`${s.root}/${f.to}: hash differs from the manifest`);
      } catch {
        problems.push(`${s.root}/${f.to}: missing`);
      }
    }
  }
  // 32 MB: raised from 25 for the Poly Haven realism pack (D166), still a bound on bloat.
  if (total > 32 * 1024 * 1024) problems.push(`vendored files total ${(total / 1024 / 1024).toFixed(1)} MB, over the 32 MB limit`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = process.argv.includes('--check')
    ? checkVendored().then((problems) => {
        if (problems.length) {
          console.error(problems.join('\n'));
          process.exit(1);
        }
        console.info('vendored assets match the manifest');
      })
    : fetchAll();
  run.catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
