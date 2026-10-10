#!/usr/bin/env node
// `node scripts/release-build.mjs [--triple aarch64-apple-darwin] [--dry-run] [--unsigned]`:
// builds the signed app and the .dmg with Tauri's bundler. The bundler, given the
// environment in release-lib.mjs's SIGNING_ENV, signs every binary in the bundle (the
// shell and the Node external binary, hardened runtime, src-tauri/Entitlements.plist)
// with the Developer ID Application certificate, submits the .app to Apple's notary
// service and staples the ticket, builds the .dmg, and writes the updater artifact
// (Maka.app.tar.gz) with its minisign signature. The artifacts are copied under
// dist/release/ with their release names. --unsigned makes a local, unsigned build for
// a smoke test on the owner's own machine only; it cannot be distributed.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createRunner, readVersion, cargoVersion, readPubkey, releaseOverlay, signingStatus, artifactNames, exists, DEFAULT_TRIPLE, TRIPLES, REPO_ROOT, SIGNING_ENV } from './release-lib.mjs';

export async function build({ root = REPO_ROOT, out = path.join(root, 'dist'), triple = DEFAULT_TRIPLE, dryRun = false, unsigned = false, env = process.env, log = console, runner = createRunner({ dryRun, log, env }) } = {}) {
  if (!TRIPLES[triple]) throw new Error(`unknown target triple ${triple}`);
  const version = await readVersion(root);
  const cargo = await cargoVersion(root);
  if (cargo !== version) throw new Error(`version mismatch: package.json ${version}, src-tauri/Cargo.toml ${cargo} (run scripts/release-bump.mjs)`);
  const releaseDir = path.join(out, 'release');
  await fsp.mkdir(releaseDir, { recursive: true });

  // 1. The Node binary Tauri bundles (externalBin). Fetched and verified by release-node.mjs.
  const nodeBin = path.join(root, 'src-tauri', 'binaries', `node-${triple}`);
  if (!(await exists(nodeBin)) || dryRun) {
    runner.run('node', ['scripts/release-node.mjs', '--triple', triple], { cwd: root, note: 'download the official Node binary and verify it against nodejs.org SHASUMS256.txt' });
    if (!dryRun && !(await exists(nodeBin))) throw new Error(`${nodeBin} is still missing after release-node.mjs`);
  } else {
    log.info(`Node binary present: ${nodeBin}`);
  }

  // 2. The updater public key into the config overlay (never committed with a real key).
  let pubkey = await readPubkey({ env, root });
  if (!pubkey) {
    if (!dryRun) throw new Error('no updater public key: set TAURI_UPDATER_PUBKEY or write src-tauri/updater.pub (from `cargo tauri signer generate -w ~/.tauri/maka.key`; see docs/RELEASE_RUNBOOK.md)');
    pubkey = 'DRY-RUN-NO-PUBKEY';
  }
  const overlay = await releaseOverlay({ root, pubkey });
  const overlayPath = path.join(releaseDir, 'tauri.release.conf.json');
  await fsp.writeFile(overlayPath, JSON.stringify(overlay, null, 2) + '\n');

  // 3. Signing: everything comes from the environment.
  const signing = signingStatus(env);
  if (!unsigned && !dryRun && !signing.canSign) throw new Error(`cannot sign: set ${signing.missing.filter((k) => k === 'APPLE_SIGNING_IDENTITY').join(', ')} (${SIGNING_ENV.APPLE_SIGNING_IDENTITY}); or pass --unsigned for a local smoke build`);
  if (!unsigned && !dryRun && !signing.canNotarize) log.warn(`notarization variables missing (${signing.missing.filter((k) => k.startsWith('APPLE_') && k !== 'APPLE_SIGNING_IDENTITY').join(', ')}): the bundler will sign but not notarize the .app; release-notarize.mjs will refuse`);
  if (!unsigned && !dryRun && !signing.canSignUpdates) throw new Error('cannot sign the updater artifact: set TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD)');
  const secretEnv = Object.keys(SIGNING_ENV).filter((k) => env[k]);
  const extraEnv = unsigned ? { APPLE_SIGNING_IDENTITY: '-' } : {};

  // 4. The build. `cargo tauri` is the pinned Tauri CLI (cargo install tauri-cli --version ^2).
  runner.run('cargo', ['tauri', 'build', '--target', triple, '--config', overlayPath, ...(unsigned ? ['--bundles', 'app'] : [])], { cwd: path.join(root, 'src-tauri'), secretEnv, extraEnv, note: unsigned ? 'local unsigned build (ad-hoc signature), app bundle only' : 'build, sign with the Developer ID, notarize and staple the .app, build the .dmg and the updater artifact' });

  // 5. Collect the artifacts under their release names.
  const names = artifactNames({ version, triple });
  const bundleDir = path.join(root, 'src-tauri', 'target', triple, 'release', 'bundle');
  const artifacts = { app: path.join(bundleDir, names.bundled.app), dmg: path.join(releaseDir, names.dmg), updater: path.join(releaseDir, names.updater), signature: path.join(releaseDir, names.signature) };
  if (!dryRun && !unsigned) {
    for (const [k, from] of [['dmg', names.bundled.dmg], ['updater', names.bundled.updater], ['signature', names.bundled.signature]]) {
      const src = path.join(bundleDir, from);
      if (!(await exists(src))) throw new Error(`the bundler did not produce ${src}`);
      await fsp.copyFile(src, artifacts[k]);
    }
  } else {
    log.info(`${dryRun ? '[dry-run] ' : ''}artifacts expected at ${bundleDir}/{${names.bundled.dmg}, ${names.bundled.updater}, ${names.bundled.signature}} → ${releaseDir}/`);
  }
  return { version, triple, out: releaseDir, overlayPath, artifacts, names, signing: { ...signing, unsigned }, dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  build({ root: flags.root ? path.resolve(flags.root) : REPO_ROOT, out: flags.out ? path.resolve(flags.out) : undefined, triple: flags.triple || DEFAULT_TRIPLE, dryRun: Boolean(flags['dry-run']), unsigned: Boolean(flags.unsigned) })
    .then((r) => console.log(`built Maka ${r.version} for ${r.triple}${r.dryRun ? ' (dry run)' : ''}: ${r.out}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
