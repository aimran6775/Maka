// Shared pieces of the release scripts (phase 3 step 6). Core modules only. Every
// external command goes through a Runner that, in dry-run mode, prints the exact command
// instead of running it and records it in a plan, so the sequence can be proved on a
// machine without Xcode (test/release.test.js) and read before it runs on the Mac.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTgz } from './fetch-assets.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_ORIGIN = 'https://makapark.com';
export const RELEASES_PATH = 'releases';
export const DEFAULT_TRIPLE = 'aarch64-apple-darwin';
export const NODE_DIST = 'https://nodejs.org/dist';
// Node 22 is what the sidecar is developed and tested on (package.json engines).
export const NODE_VERSION = '22.22.0';

export const TRIPLES = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({ node: 'darwin-arm64', updater: 'darwin-aarch64', dmgArch: 'aarch64' }),
  'x86_64-apple-darwin': Object.freeze({ node: 'darwin-x64', updater: 'darwin-x86_64', dmgArch: 'x64' }),
});

// What the Mac must have in its environment. The signing identity is the Developer ID
// Application certificate's name; the Apple ID, app-specific password and team id are
// what notarytool wants; the Tauri key pair signs the updater artifact. None of these
// is ever read from a file in the repository.
export const SIGNING_ENV = Object.freeze({
  APPLE_SIGNING_IDENTITY: 'the Developer ID Application certificate, e.g. "Developer ID Application: Name (TEAMID)"',
  APPLE_ID: 'the Apple ID that owns the developer account',
  APPLE_PASSWORD: 'an app-specific password for that Apple ID (appleid.apple.com)',
  APPLE_TEAM_ID: 'the 10-character team id',
  TAURI_SIGNING_PRIVATE_KEY: 'the updater private key (cargo tauri signer generate), the key text or a path',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'its password (may be empty)',
});

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['root', 'out', 'target', 'node-version', 'version', 'notes', 'triple', 'dmg', 'app', 'config'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

export function assertSemver(v) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(v || ''))) throw new Error(`not a semver version: "${v}"`);
  return String(v);
}

export async function sha256File(file) {
  const h = createHash('sha256');
  h.update(await fsp.readFile(file));
  return h.digest('hex');
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function readVersion(root = REPO_ROOT) {
  return assertSemver((await readJson(path.join(root, 'package.json'))).version);
}

export async function cargoVersion(root = REPO_ROOT) {
  const text = await fsp.readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const m = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(text);
  return m ? m[1] : null;
}

// One place that runs (or, in dry-run, prints and records) external commands.
export function createRunner({ dryRun = false, log = console, env = process.env, spawn = spawnSync } = {}) {
  const plan = [];
  return {
    dryRun,
    plan,
    // Runs `cmd args` in `cwd`; `secretEnv` names variables passed to the child but shown
    // as <set> in the plan. Throws on a non-zero exit unless `allowFail`.
    run(cmd, args, { cwd = REPO_ROOT, note = null, secretEnv = [], extraEnv = {}, allowFail = false, capture = false } = {}) {
      const shown = `${cmd} ${args.map(quote).join(' ')}`;
      const entry = { cmd, args, cwd, note, env: Object.keys(extraEnv), secrets: secretEnv };
      plan.push(entry);
      log.info(`${dryRun ? '[dry-run] ' : ''}+ ${shown}${note ? `   # ${note}` : ''}${cwd !== REPO_ROOT ? `   (in ${cwd})` : ''}`);
      if (dryRun) return { status: 0, stdout: '', dry: true };
      const r = spawn(cmd, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...env, ...extraEnv }, encoding: 'utf8' });
      if (r.error) throw new Error(`${cmd} could not start: ${r.error.message}`);
      if (r.status !== 0 && !allowFail) throw new Error(`${shown} exited with ${r.status}`);
      return { status: r.status, stdout: r.stdout || '' };
    },
    renderPlan() {
      return ['#!/bin/sh', '# The release command sequence, as planned. Secrets come from the environment.', 'set -e', ...plan.map((e) => `${e.note ? `# ${e.note}\n` : ''}${e.cwd !== REPO_ROOT ? `(cd ${quote(e.cwd)} && ` : ''}${e.secrets.length ? `${e.secrets.map((s) => `${s}=<set>`).join(' ')} ` : ''}${e.cmd} ${e.args.map(quote).join(' ')}${e.cwd !== REPO_ROOT ? ')' : ''}`)].join('\n') + '\n';
    },
  };
}

function quote(s) {
  const t = String(s);
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(t) ? t : `'${t.replace(/'/g, "'\\''")}'`;
}

// Which signing variables are set (names only; values never logged).
export function signingStatus(env = process.env) {
  const missing = Object.keys(SIGNING_ENV).filter((k) => !(env[k] && String(env[k]).trim()) && k !== 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  return { missing, canSign: !missing.includes('APPLE_SIGNING_IDENTITY'), canNotarize: !['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].some((k) => missing.includes(k)), canSignUpdates: !missing.includes('TAURI_SIGNING_PRIVATE_KEY') };
}

// The updater public key: TAURI_UPDATER_PUBKEY, else src-tauri/updater.pub, else null.
export async function readPubkey({ env = process.env, root = REPO_ROOT } = {}) {
  if (env.TAURI_UPDATER_PUBKEY && String(env.TAURI_UPDATER_PUBKEY).trim()) return String(env.TAURI_UPDATER_PUBKEY).trim();
  try {
    return (await fsp.readFile(path.join(root, 'src-tauri', 'updater.pub'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

// The config overlay for `cargo tauri build --config`: the committed
// src-tauri/tauri.release.conf.json with the public key substituted.
export async function releaseOverlay({ root = REPO_ROOT, pubkey, endpoint = `${SITE_ORIGIN}/${RELEASES_PATH}/latest.json` } = {}) {
  const overlay = await readJson(path.join(root, 'src-tauri', 'tauri.release.conf.json'));
  delete overlay['//'];
  overlay.plugins.updater.pubkey = pubkey;
  overlay.plugins.updater.endpoints = [endpoint];
  return overlay;
}

// Downloads the official Node binary for a target and verifies it against nodejs.org's
// SHASUMS256.txt before extracting bin/node to `dest` (Tauri's externalBin name).
export async function fetchNode({ version = NODE_VERSION, triple = DEFAULT_TRIPLE, dest, baseUrl = NODE_DIST, fetch: fetchImpl = globalThis.fetch, log = console } = {}) {
  const t = TRIPLES[triple];
  if (!t) throw new Error(`unknown target triple ${triple}`);
  if (!dest) throw new Error('fetchNode needs dest');
  const file = `node-v${version}-${t.node}.tar.gz`;
  const sumsUrl = `${baseUrl}/v${version}/SHASUMS256.txt`;
  log.info(`fetching ${sumsUrl}`);
  const sumsRes = await fetchImpl(sumsUrl);
  if (!sumsRes.ok) throw new Error(`${sumsUrl}: HTTP ${sumsRes.status}`);
  const sums = await sumsRes.text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`) || l.trim().endsWith(` ${file}`));
  if (!line) throw new Error(`${file} is not listed in ${sumsUrl}`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const url = `${baseUrl}/v${version}/${file}`;
  log.info(`fetching ${url}`);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual} does not match nodejs.org's ${expected}; not extracting`);
  const tgz = readTgz(buf);
  const inner = `node-v${version}-${t.node}/bin/node`;
  if (!tgz.names().includes(inner)) throw new Error(`${file} has no ${inner}`);
  const node = tgz.read(inner);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, node, { mode: 0o755 });
  await fsp.chmod(dest, 0o755);
  return { path: dest, version, triple, file, sha256: expected, bytes: node.length, source: url };
}

// The Tauri updater's static manifest (https://v2.tauri.app/plugin/updater/#static-json-file).
export function updaterManifest({ version, notes = '', pubDate, platforms }) {
  assertSemver(version);
  if (!platforms || !Object.keys(platforms).length) throw new Error('updaterManifest needs at least one platform');
  for (const [k, p] of Object.entries(platforms)) if (!p.url || !p.signature) throw new Error(`platform ${k} needs url and signature`);
  return { version, notes, pub_date: new Date(pubDate).toISOString(), platforms };
}

// What the download page reads (separate from the updater's manifest on purpose).
export function downloadManifest({ version, pubDate, notes = '', dmg, triple = DEFAULT_TRIPLE, minimumSystemVersion = '12.0', dryRun = false }) {
  assertSemver(version);
  if (!dmg || !dmg.url || !dmg.sha256 || typeof dmg.bytes !== 'number') throw new Error('downloadManifest needs dmg { url, sha256, bytes }');
  return { version, pub_date: new Date(pubDate).toISOString(), notes, arch: TRIPLES[triple].dmgArch, minimumSystemVersion, dmg: { name: dmg.name || path.basename(dmg.url), url: dmg.url, sha256: dmg.sha256, bytes: dmg.bytes }, dryRun };
}

export function artifactNames({ version, triple = DEFAULT_TRIPLE, productName = 'Maka' }) {
  const t = TRIPLES[triple];
  return {
    dmg: `${productName}-${version}-${t.dmgArch}.dmg`,
    updater: `${productName}-${version}-${t.dmgArch}.app.tar.gz`,
    signature: `${productName}-${version}-${t.dmgArch}.app.tar.gz.sig`,
    // Where Tauri's bundler puts them (relative to src-tauri/target/<triple>/release/bundle).
    bundled: { app: `macos/${productName}.app`, dmg: `dmg/${productName}_${version}_${t.dmgArch}.dmg`, updater: `macos/${productName}.app.tar.gz`, signature: `macos/${productName}.app.tar.gz.sig` },
  };
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
