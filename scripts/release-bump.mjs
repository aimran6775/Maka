#!/usr/bin/env node
// `node scripts/release-bump.mjs 0.2.0 [--no-git] [--root dir]`: sets the version in
// package.json (tauri.conf.json reads it from there), src-tauri/Cargo.toml and
// Cargo.lock's own entry, then commits and tags `v0.2.0` unless --no-git. Refuses a
// version that is not newer, or a dirty working tree (the release is one commit).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, assertSemver, readVersion, cargoVersion, createRunner, REPO_ROOT } from './release-lib.mjs';

function newer(a, b) {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return a !== b;
}

export async function bump({ version, root = REPO_ROOT, git = true, dryRun = false, log = console, runner = createRunner({ dryRun, log }) } = {}) {
  const next = assertSemver(version);
  const current = await readVersion(root);
  if (!newer(next, current)) throw new Error(`${next} is not newer than the current ${current}`);
  if (git && !dryRun) {
    const status = runner.run('git', ['status', '--porcelain'], { cwd: root, capture: true, note: 'the release is one commit: the tree must be clean' });
    if (status.stdout.trim()) throw new Error(`the working tree is not clean:\n${status.stdout}`);
  }
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(await fsp.readFile(pkgFile, 'utf8'));
  pkg.version = next;
  const cargoFile = path.join(root, 'src-tauri', 'Cargo.toml');
  const cargo = await fsp.readFile(cargoFile, 'utf8');
  const cargoNext = cargo.replace(/^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${next}$2`);
  if (cargoNext === cargo) throw new Error('Cargo.toml: no [package] version to bump');
  const lockFile = path.join(root, 'src-tauri', 'Cargo.lock');
  let lock = null;
  let lockNext = null;
  try {
    lock = await fsp.readFile(lockFile, 'utf8');
    lockNext = lock.replace(/(\[\[package\]\]\nname = "maka"\nversion = ")[^"]+(")/, `$1${next}$2`);
  } catch {
    /* no lockfile yet */
  }
  log.info(`${dryRun ? '[dry-run] ' : ''}bump ${current} → ${next}: package.json, src-tauri/Cargo.toml${lock ? ', src-tauri/Cargo.lock' : ''}`);
  if (!dryRun) {
    await fsp.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    await fsp.writeFile(cargoFile, cargoNext);
    if (lock && lockNext !== lock) await fsp.writeFile(lockFile, lockNext);
  }
  if (git) {
    runner.run('git', ['add', 'package.json', 'src-tauri/Cargo.toml', ...(lock ? ['src-tauri/Cargo.lock'] : [])], { cwd: root });
    runner.run('git', ['commit', '-m', `Release v${next}`], { cwd: root });
    runner.run('git', ['tag', '-a', `v${next}`, '-m', `Maka v${next}`], { cwd: root });
  }
  return { from: current, to: next, cargoWas: await cargoVersion(root) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  bump({ version: positional[0] || flags.version, root: flags.root ? path.resolve(flags.root) : REPO_ROOT, git: !flags['no-git'], dryRun: Boolean(flags['dry-run']) })
    .then((r) => console.log(`version ${r.from} → ${r.to}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
