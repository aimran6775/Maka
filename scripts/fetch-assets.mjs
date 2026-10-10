#!/usr/bin/env node
// Downloads the licensed art packs, verifies each archive against its pinned SHA-256, and
// extracts only the sheets Maka uses into frontend/assets/. Node core modules only.
//
//   node scripts/fetch-assets.mjs            download, verify, extract, write manifest
//   node scripts/fetch-assets.mjs --check    verify the vendored files match the manifest
//
// The extracted files are committed so the app works offline and inside the Tauri bundle;
// this script is how they are (re)produced and how their provenance is proven. Licenses
// are recorded in NOTICE.md and in frontend/assets/manifest.json.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'frontend', 'assets');
const MANIFEST = path.join(OUT, 'manifest.json');

// Pinned sources. URLs and hashes were verified on 2026-10-10; a changed hash means the
// upstream archive changed and must be re-reviewed before the pin is updated.
export const SOURCES = [
  {
    id: 'kenney-tiny-town',
    title: 'Tiny Town (1.1)',
    author: 'Kenney',
    license: 'CC0-1.0',
    page: 'https://kenney.nl/assets/tiny-town',
    url: 'https://kenney.nl/media/pages/assets/tiny-town/a415fbeb49-1735736916/kenney_tiny-town.zip',
    sha256: '9768692dccff1d706408a5aedd6ca4f6cd1409506cbc84cb2f862919764be977',
    licenseEvidence: 'License.txt inside the archive: "License: (Creative Commons Zero, CC0)"',
    files: [{ from: 'Tilemap/tilemap_packed.png', to: 'tiny-town.png', note: '16x16 tiles, 12 columns, no spacing' }],
  },
  {
    id: 'kenney-roguelike-rpg',
    title: 'Roguelike/RPG pack',
    author: 'Kenney',
    license: 'CC0-1.0',
    page: 'https://kenney.nl/assets/roguelike-rpg-pack',
    url: 'https://kenney.nl/media/pages/assets/roguelike-rpg-pack/12c03cd78b-1677697420/kenney_roguelike-rpg-pack.zip',
    sha256: '8e7d2378f8f794245645f6d7dc7aeeb246791410a7e512293c594b46a5a9524b',
    licenseEvidence: 'License.txt inside the archive: "License (Creative Commons Zero, CC0)"',
    // Pinned and verified; no sheet from it is drawn yet, so nothing is extracted.
    files: [],
  },
  {
    id: 'shade-puny-characters',
    title: 'Puny Characters',
    author: 'Shade',
    license: 'CC0-1.0',
    page: 'https://opengameart.org/content/puny-characters',
    url: 'https://opengameart.org/sites/default/files/puny-characters.zip',
    sha256: '971d7b07eea18fb2cce475cd6554a176ebf783bb064dec5a637ba33c7829320e',
    licenseEvidence: 'OpenGameArt listing shows license CC0; the archive carries no license file',
    files: [{ from: 'Puny-Characters/Soldier-Yellow.png', to: 'ranger.png', note: '32x32 frames, 24 columns, 8 direction rows; row 0 faces down' }],
  },
  {
    id: 'inkbubi-forest-free',
    title: '16x16 Pixel Forest Tileset, Top-down (free sample, v1.1)',
    author: 'inkBubi',
    license: 'CC0-1.0',
    page: 'https://opengameart.org/node/180257',
    url: 'https://opengameart.org/sites/default/files/seasons_of_forest_free_v1_1.zip',
    sha256: 'e37d01e005fe31577d4f501f33bda98cb77db815e21862e162269889cc07f777',
    licenseEvidence: 'license.txt inside the archive: "License: CC0 (Creative Commons Zero)"',
    // Pinned and verified; no sheet from it is drawn yet, so nothing is extracted.
    files: [],
  },
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

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchAll({ log = console, fetchImpl = download } = {}) {
  await fsp.mkdir(OUT, { recursive: true });
  const manifest = { generatedBy: 'scripts/fetch-assets.mjs', note: 'Every file below was extracted from an archive whose SHA-256 matched the pin. Licenses: see NOTICE.md.', sources: [] };
  for (const src of SOURCES) {
    log.info(`fetching ${src.title} …`);
    const buf = await fetchImpl(src.url);
    const got = sha256(buf);
    if (got !== src.sha256) throw new Error(`${src.id}: archive hash ${got} does not match the pinned ${src.sha256}; refusing to extract`);
    const zip = readZip(buf);
    const files = [];
    for (const f of src.files) {
      const data = zip.read(f.from);
      await fsp.writeFile(path.join(OUT, f.to), data);
      files.push({ from: f.from, to: f.to, sha256: sha256(data), bytes: data.length, note: f.note });
      log.info(`  ${f.from} → frontend/assets/${f.to} (${data.length} bytes)`);
    }
    manifest.sources.push({ id: src.id, title: src.title, author: src.author, license: src.license, page: src.page, url: src.url, archiveSha256: src.sha256, licenseEvidence: src.licenseEvidence, files });
  }
  await fsp.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  log.info(`wrote ${path.relative(ROOT, MANIFEST)}`);
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
  for (const s of manifest.sources) {
    const pinned = SOURCES.find((p) => p.id === s.id);
    if (!pinned) problems.push(`${s.id}: not a pinned source`);
    else if (pinned.sha256 !== s.archiveSha256) problems.push(`${s.id}: manifest archive hash differs from the pin`);
    if (!/^CC0-1\.0$|^CC-BY-4\.0$/.test(s.license)) problems.push(`${s.id}: license ${s.license} is not CC0 or CC-BY`);
    for (const f of s.files) {
      try {
        const data = await fsp.readFile(path.join(OUT, f.to));
        if (sha256(data) !== f.sha256) problems.push(`${f.to}: hash differs from the manifest`);
      } catch {
        problems.push(`${f.to}: missing`);
      }
    }
  }
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
