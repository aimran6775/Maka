#!/usr/bin/env node
// `node scripts/release-smoke.mjs --app <Maka.app> [--dry-run] [--expect-broker=false]`:
// the smoke launch of the built app (phase 3 step 7). Starts the bundle's main binary
// with a fresh MAKA_HOME and a chosen port, waits for the shell to announce the park,
// and checks what a first launch must show: /api/state answers with the contract,
// setup.firstRun is true (a fresh home), secrets go through the shell's Keychain broker,
// the page and the vendored Three.js are served from the bundle; then stops it with
// SIGTERM and checks the sidecar went with it. Nothing is installed or written outside
// the temporary home. The clean-user-account launch is a manual step in
// docs/RELEASE_RUNBOOK.md (a GUI session is needed for the Keychain and the window).
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs, createRunner, exists, REPO_ROOT } from './release-lib.mjs';

export const SMOKE_TIMEOUT_MS = 90_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// The bundle's main binary: Contents/MacOS/<something executable that is not node>.
export async function findMainBinary(app) {
  const dir = path.join(app, 'Contents', 'MacOS');
  const names = (await fsp.readdir(dir)).filter((n) => !/^node(-|$)/.test(n) && !n.startsWith('.'));
  for (const n of ['Maka', 'maka', ...names]) {
    const p = path.join(dir, n);
    if (names.includes(n) && (await exists(p))) return p;
  }
  throw new Error(`no main binary under ${dir}`);
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function smoke({ app, dryRun = false, env = process.env, log = console, runner = createRunner({ dryRun, log, env }), timeoutMs = SMOKE_TIMEOUT_MS, expectBroker = true, spawn = spawnChild } = {}) {
  if (!app) throw new Error('smoke needs the .app path');
  const home = path.join(os.tmpdir(), `maka-smoke-${process.pid}`);
  const port = await freePort();
  const checks = [];
  const bin = dryRun ? path.join(app, 'Contents', 'MacOS', 'Maka') : await findMainBinary(app);
  if (dryRun) {
    // The plan only: the launch is asynchronous and supervised below, so it goes through
    // the runner (which would block on it) in dry-run alone.
    runner.run(bin, [], { note: `launch the built app with MAKA_HOME=${home} MAKA_PORT=${port} (a fresh home: the first-run card must show)`, extraEnv: { MAKA_HOME: home, MAKA_PORT: String(port) } });
    for (const c of ['GET /api/state → 200, contractVersion 1, setup.firstRun true, keystore.broker true (the Keychain broker)', 'GET / → the park page from the bundle', 'GET /vendor/three/three.module.js → the vendored renderer from the bundle', 'SIGTERM → the app exits and the sidecar port closes']) runner.run('#', ['check:', c], { note: null });
    return { ok: true, dryRun: true, home, port, checks: [] };
  }
  log.info(`smoke: launching ${bin} with MAKA_HOME=${home} MAKA_PORT=${port}`);

  await fsp.mkdir(home, { recursive: true });
  const child = spawn(bin, [], { env: { ...env, MAKA_HOME: home, MAKA_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  const fail = (what) => { checks.push({ check: what, ok: false }); throw new Error(`smoke: ${what}\n--- app output ---\n${output.slice(-4000)}`); };
  const pass = (what, detail = '') => { checks.push({ check: what, ok: true, detail }); log.info(`smoke ok: ${what}${detail ? ` (${detail})` : ''}`); };
  try {
    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) fail(`the app exited early with code ${child.exitCode}`);
      try {
        const r = await getJson(`${base}/api/state`);
        if (r.status === 200 && r.body) { state = r.body; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!state) fail(`no /api/state on ${base} within ${timeoutMs / 1000}s`);
    pass('/api/state answers', `seq ${state.seq}`);
    if (state.contractVersion !== 1) fail(`contractVersion is ${state.contractVersion}`);
    pass('contract v1');
    if (!state.setup || state.setup.firstRun !== true) fail('setup.firstRun is not true on a fresh home');
    pass('first run on a fresh home');
    if (!state.keystore || state.keystore.broker !== true) {
      if (expectBroker) fail(`secrets are not going through the Keychain broker (keystore: ${JSON.stringify(state.keystore)})`);
      checks.push({ check: 'Keychain broker', ok: true, detail: 'not expected in this run' });
    } else pass('secrets through the Keychain broker');
    if (!/maka: park at /.test(output)) fail('the shell did not announce the park URL');
    pass('the shell announced the park');
    const page = await fetch(`${base}/`);
    const html = await page.text();
    if (page.status !== 200 || !/<title>Maka<\/title>/.test(html)) fail('the park page is not served');
    pass('the park page is served from the bundle');
    const three = await fetch(`${base}/vendor/three/three.module.js`);
    if (three.status !== 200) fail('the vendored Three.js is not served (frontend/vendor missing from the bundle)');
    pass('the vendored renderer is served', `${three.headers.get('content-length') || '?'} bytes`);
    const assets = await fetch(`${base}/assets/manifest.json`);
    if (assets.status !== 200) fail('the asset manifest is not served');
    pass('the asset manifest is served');
  } finally {
    child.kill('SIGTERM');
  }
  const ended = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 20_000))]);
  if (!ended) {
    child.kill('SIGKILL');
    fail('the app did not exit within 20s of SIGTERM');
  }
  pass('the app exited on SIGTERM', ended.signal || `code ${ended.code}`);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    try {
      await fetch(`${base}/api/state`);
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      gone = true;
    }
  }
  if (!gone) fail('the sidecar is still answering after the app exited');
  pass('the sidecar stopped with the app');
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  return { ok: true, dryRun: false, home, port, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  smoke({ app: flags.app ? path.resolve(flags.app) : path.join(REPO_ROOT, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'Maka.app'), dryRun: Boolean(flags['dry-run']), expectBroker: flags['expect-broker'] !== 'false' })
    .then((r) => console.log(`SMOKE OK${r.dryRun ? ' (dry run)' : `: ${r.checks.length} checks`}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
