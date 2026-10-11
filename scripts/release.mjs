#!/usr/bin/env node
// `node scripts/release.mjs [--dry-run] [--skip-gates] [--skip-smoke] [--notes "…"]`:
// the whole release, in order, from a clean tagged checkout on the owner's Mac:
//   1. gates: test:fast, the phase 2 and phase 4 demos, the shell check (cargo check + host tests)
//   2. build (release-build.mjs): Node bundled, signed, notarized .app, .dmg, updater artifact
//   3. notarize and staple the .dmg (release-notarize.mjs), verify both with Gatekeeper
//   4. smoke launch of the built app under a fresh MAKA_HOME (release-smoke.mjs, step 7)
//   5. the site (release-site.mjs): latest.json, download.json, SHA256SUMS, dist/site/
// --dry-run prints every command instead of running it and writes dist/release/plan.sh
// (the exact sequence) and dry-run manifests, so the plan can be read and tested where
// there is no Xcode. Secrets come from the environment only (release-lib.mjs SIGNING_ENV).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createRunner, readVersion, signingStatus, exists, DEFAULT_TRIPLE, REPO_ROOT, SIGNING_ENV } from './release-lib.mjs';
import { build } from './release-build.mjs';
import { notarize } from './release-notarize.mjs';
import { site } from './release-site.mjs';

export async function release({ root = REPO_ROOT, out = path.join(root, 'dist'), triple = DEFAULT_TRIPLE, dryRun = false, skipGates = false, skipSmoke = false, notes = '', env = process.env, log = console, smoke = null } = {}) {
  const runner = createRunner({ dryRun, log, env });
  const version = await readVersion(root);
  const signing = signingStatus(env);
  log.info(`release Maka ${version} for ${triple}${dryRun ? ' (DRY RUN: nothing is built, signed or uploaded)' : ''}`);
  log.info(`signing environment: ${Object.keys(SIGNING_ENV).map((k) => `${k}=${env[k] ? 'set' : 'MISSING'}`).join(' ')}`);
  if (!dryRun) {
    const tag = runner.run('git', ['describe', '--tags', '--exact-match'], { cwd: root, capture: true, allowFail: true, note: 'the checkout must be the tagged release commit' });
    if (tag.status !== 0 || tag.stdout.trim() !== `v${version}`) throw new Error(`HEAD is not tagged v${version} (run scripts/release-bump.mjs ${version} first, then check out the tag)`);
    const dirty = runner.run('git', ['status', '--porcelain'], { cwd: root, capture: true });
    if (dirty.stdout.trim()) throw new Error(`the working tree is not clean:\n${dirty.stdout}`);
  }
  const steps = [];
  if (!skipGates) {
    runner.run('npm', ['run', 'test:fast'], { cwd: root, note: 'gate 1: the merge gate' });
    runner.run('npm', ['run', 'demo'], { cwd: root, note: 'gate 2: the phase 2 chain against the fakes' });
    runner.run('npm', ['run', 'demo:phase4'], { cwd: root, note: 'gate 2b: the phase 4 chain against the fakes' });
    runner.run('npm', ['run', 'shell:check'], { cwd: root, note: 'gate 3: the shell type-checks and its host tests pass' });
    steps.push('gates');
  }
  const built = await build({ root, out, triple, dryRun, env, log, runner });
  steps.push('build');
  await notarize({ dmg: built.artifacts.dmg, app: built.artifacts.app, dryRun, env, log, runner });
  steps.push('notarize');
  let smokeResult = null;
  if (!skipSmoke) {
    const smokeFn = smoke || (await import('./release-smoke.mjs').then((m) => m.smoke).catch(() => null));
    if (smokeFn) {
      smokeResult = await smokeFn({ app: built.artifacts.app, dryRun, env, log, runner, root });
      steps.push('smoke');
    } else {
      log.warn('release-smoke.mjs is not present; the smoke launch is skipped');
    }
  }
  const assembled = await site({ root, out, triple, version, notes, dryRun, log });
  steps.push('site');
  await fsp.mkdir(built.out, { recursive: true });
  const planPath = path.join(built.out, 'plan.sh');
  await fsp.writeFile(planPath, runner.renderPlan(), { mode: 0o755 });
  const summary = { version, triple, dryRun, steps, signing: { ...signing, missing: signing.missing }, artifacts: built.artifacts, site: assembled.siteDir, urls: assembled.urls, smoke: smokeResult, plan: planPath, at: new Date().toISOString() };
  await fsp.writeFile(path.join(built.out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log.info(`${dryRun ? '[dry-run] ' : ''}release ${version}: ${steps.join(' → ')}; plan at ${planPath}; site at ${assembled.siteDir}`);
  if (!dryRun) log.info(`publish: upload ${assembled.siteDir}/ to makapark.com (docs/RELEASE_RUNBOOK.md); the updater reads ${assembled.urls.updater.replace(/\/[^/]+$/, '/latest.json')}`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  release({ root: flags.root ? path.resolve(flags.root) : REPO_ROOT, out: flags.out ? path.resolve(flags.out) : undefined, triple: flags.triple || DEFAULT_TRIPLE, dryRun: Boolean(flags['dry-run']), skipGates: Boolean(flags['skip-gates']), skipSmoke: Boolean(flags['skip-smoke']), notes: flags.notes || '' }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
