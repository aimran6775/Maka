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
      ...THREE_ADDONS.map((f) => ({ from: `package/examples/jsm/${f}`, to: `addons/${f}` })),
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
    else if (pinned.sha256 !== s.archiveSha256) problems.push(`${s.id}: manifest archive hash differs from the pin`);
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
  if (total > 25 * 1024 * 1024) problems.push(`vendored files total ${(total / 1024 / 1024).toFixed(1)} MB, over the 25 MB limit`);
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
