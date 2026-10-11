// Phase 3 step 6: the release scripts, proved where there is no Xcode: the library's
// pure parts, Node bundling against a fake nodejs.org (checksum verified, a bad hash
// refused), the version bump, the site assembly from real (tiny) artifacts, and the
// whole release in dry-run mode: every command in order, nothing executed, manifests
// that say they are a dry run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseArgs, assertSemver, artifactNames, updaterManifest, downloadManifest, releaseOverlay, signingStatus, readPubkey, fetchNode, createRunner, sha256, TRIPLES, REPO_ROOT } from '../scripts/release-lib.mjs';
import { bump } from '../scripts/release-bump.mjs';
import { site } from '../scripts/release-site.mjs';
import { release } from '../scripts/release.mjs';
import { packTar } from '../sidecar/backup/archive.js';

async function tempRepo() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-rel-'));
  await fsp.mkdir(path.join(root, 'src-tauri'), { recursive: true });
  await fsp.mkdir(path.join(root, 'website'), { recursive: true });
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'maka', version: '0.1.0', dependencies: {} }, null, 2));
  await fsp.writeFile(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "maka"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "=1.0.229"\n');
  await fsp.writeFile(path.join(root, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "maka"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.229"\n');
  await fsp.copyFile(path.join(REPO_ROOT, 'src-tauri', 'tauri.release.conf.json'), path.join(root, 'src-tauri', 'tauri.release.conf.json'));
  await fsp.copyFile(path.join(REPO_ROOT, 'website', 'index.html'), path.join(root, 'website', 'index.html'));
  return root;
}

test('library: args, semver, artifact names, manifests, the overlay, signing status, the pubkey', async () => {
  assert.deepEqual(parseArgs(['--dry-run', '--triple', 'x86_64-apple-darwin', '0.2.0', '--notes=hi']), { flags: { 'dry-run': true, triple: 'x86_64-apple-darwin', notes: 'hi' }, positional: ['0.2.0'] });
  assert.equal(assertSemver('1.2.3-rc.1'), '1.2.3-rc.1');
  assert.throws(() => assertSemver('v1.2'), /not a semver/);
  const names = artifactNames({ version: '0.2.0' });
  assert.equal(names.dmg, 'Maka-0.2.0-aarch64.dmg');
  assert.equal(names.updater, 'Maka-0.2.0-aarch64.app.tar.gz');
  assert.equal(names.bundled.dmg, 'dmg/Maka_0.2.0_aarch64.dmg');
  const m = updaterManifest({ version: '0.2.0', notes: 'n', pubDate: Date.UTC(2026, 9, 10), platforms: { 'darwin-aarch64': { url: 'https://makapark.com/releases/x.tar.gz', signature: 'sig' } } });
  assert.deepEqual(m, { version: '0.2.0', notes: 'n', pub_date: '2026-10-10T00:00:00.000Z', platforms: { 'darwin-aarch64': { url: 'https://makapark.com/releases/x.tar.gz', signature: 'sig' } } });
  assert.throws(() => updaterManifest({ version: '0.2.0', pubDate: 0, platforms: { 'darwin-aarch64': { url: 'u' } } }), /signature/);
  const d = downloadManifest({ version: '0.2.0', pubDate: 0, dmg: { url: 'https://makapark.com/releases/Maka-0.2.0-aarch64.dmg', sha256: 'abc', bytes: 10 } });
  assert.equal(d.dmg.name, 'Maka-0.2.0-aarch64.dmg');
  assert.equal(d.arch, 'aarch64');
  assert.equal(d.dryRun, false);
  const overlay = await releaseOverlay({ pubkey: 'PUBKEY-1' });
  assert.equal(overlay.plugins.updater.pubkey, 'PUBKEY-1');
  assert.deepEqual(overlay.plugins.updater.endpoints, ['https://makapark.com/releases/latest.json']);
  assert.equal(overlay.bundle.createUpdaterArtifacts, true);
  assert.equal(overlay['//'], undefined);
  const none = signingStatus({});
  assert.deepEqual([none.canSign, none.canNotarize, none.canSignUpdates], [false, false, false]);
  assert.ok(none.missing.includes('APPLE_SIGNING_IDENTITY'));
  const all = signingStatus({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: X (T)', APPLE_ID: 'a', APPLE_PASSWORD: 'p', APPLE_TEAM_ID: 'T', TAURI_SIGNING_PRIVATE_KEY: 'k' });
  assert.deepEqual([all.canSign, all.canNotarize, all.canSignUpdates, all.missing], [true, true, true, []]);
  assert.equal(await readPubkey({ env: { TAURI_UPDATER_PUBKEY: ' pk ' }, root: '/nowhere' }), 'pk');
  assert.equal(await readPubkey({ env: {}, root: '/nowhere' }), null);
  assert.deepEqual(Object.keys(TRIPLES), ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
});

async function fakeNodeDist({ version = '22.22.0', breakHash = false } = {}) {
  const inner = `node-v${version}-darwin-arm64`;
  const nodeBytes = Buffer.from('#!/bin/sh\necho fake node\n');
  const tgz = gzipSync(packTar([{ path: `${inner}/bin/node`, data: nodeBytes, mode: 0o755 }, { path: `${inner}/README.md`, data: Buffer.from('x') }]));
  const sums = `${breakHash ? 'f'.repeat(64) : sha256(tgz)}  ${inner}.tar.gz\n${'0'.repeat(64)}  node-v${version}-darwin-x64.tar.gz\n`;
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url === `/v${version}/SHASUMS256.txt`) return res.end(sums);
    if (req.url === `/v${version}/${inner}.tar.gz`) return res.end(tgz);
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, nodeBytes, expected: sha256(tgz), close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('fetchNode: verifies the tarball against SHASUMS256.txt, extracts bin/node as 0755, refuses a hash mismatch or an unlisted file', async () => {
  const dist = await fakeNodeDist();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-node-'));
  try {
    const dest = path.join(dir, 'binaries', 'node-aarch64-apple-darwin');
    const r = await fetchNode({ version: '22.22.0', dest, baseUrl: dist.url, log: { info() {} } });
    assert.equal(r.sha256, dist.expected);
    assert.equal(r.bytes, dist.nodeBytes.length);
    assert.ok((await fsp.readFile(dest)).equals(dist.nodeBytes));
    assert.equal((await fsp.stat(dest)).mode & 0o777, 0o755);
    assert.deepEqual(dist.calls, ['/v22.22.0/SHASUMS256.txt', '/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz']);
    await assert.rejects(fetchNode({ version: '22.22.0', triple: 'x86_64-apple-darwin', dest, baseUrl: dist.url, log: { info() {} } }), /HTTP 404/);
    await assert.rejects(fetchNode({ version: '21.0.0', dest, baseUrl: dist.url, log: { info() {} } }), /HTTP 404/);
    await dist.close();
    const bad = await fakeNodeDist({ breakHash: true });
    await assert.rejects(fetchNode({ version: '22.22.0', dest: path.join(dir, 'other'), baseUrl: bad.url, log: { info() {} } }), /does not match nodejs.org/);
    assert.equal(await fsp.access(path.join(dir, 'other')).then(() => true, () => false), false, 'nothing written on a mismatch');
    await bad.close();
  } finally {
    await dist.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('bump: writes package.json, Cargo.toml and Cargo.lock together, refuses a version that is not newer, and in dry-run writes nothing', async () => {
  const root = await tempRepo();
  try {
    const log = { info() {} };
    await assert.rejects(bump({ version: '0.1.0', root, git: false, log }), /not newer/);
    await assert.rejects(bump({ version: '0.0.9', root, git: false, log }), /not newer/);
    await bump({ version: '0.2.0', root, git: false, dryRun: true, log });
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version, '0.1.0', 'dry run');
    const r = await bump({ version: '0.2.0', root, git: false, log });
    assert.deepEqual([r.from, r.to, r.cargoWas], ['0.1.0', '0.2.0', '0.2.0']);
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version, '0.2.0');
    assert.match(await fsp.readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8'), /^version = "0\.2\.0"$/m);
    const lock = await fsp.readFile(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
    assert.match(lock, /name = "maka"\nversion = "0\.2\.0"/);
    assert.match(lock, /name = "serde"\nversion = "1\.0\.229"/, 'other packages untouched');
    // With git, the plan is add → commit → tag.
    const spawn = () => ({ status: 0, stdout: '' });
    const runner = createRunner({ dryRun: false, log, spawn });
    await bump({ version: '0.3.0', root, git: true, log, runner });
    assert.deepEqual(runner.plan.map((e) => [e.cmd, e.args[0]]), [['git', 'status'], ['git', 'add'], ['git', 'commit'], ['git', 'tag']]);
    assert.deepEqual(runner.plan[3].args, ['tag', '-a', 'v0.3.0', '-m', 'Maka v0.3.0']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('site: the updater manifest carries the .sig, download.json the dmg hash and size, SHA256SUMS and the artifacts are copied, the page is version-free', async () => {
  const root = await tempRepo();
  const out = path.join(root, 'dist');
  try {
    const rel = path.join(out, 'release');
    await fsp.mkdir(rel, { recursive: true });
    const names = artifactNames({ version: '0.1.0' });
    await fsp.writeFile(path.join(rel, names.dmg), Buffer.from('DMG BYTES'));
    await fsp.writeFile(path.join(rel, names.updater), Buffer.from('TARBALL'));
    await fsp.writeFile(path.join(rel, names.signature), 'untrusted comment: signature from tauri secret key\nSIGDATA\n');
    const r = await site({ root, out, notes: 'First.', pubDate: Date.UTC(2026, 9, 10, 12), log: { info() {} } });
    assert.equal(r.latest.version, '0.1.0');
    assert.equal(r.latest.platforms['darwin-aarch64'].signature, 'untrusted comment: signature from tauri secret key\nSIGDATA');
    assert.equal(r.latest.platforms['darwin-aarch64'].url, 'https://makapark.com/releases/Maka-0.1.0-aarch64.app.tar.gz');
    assert.equal(r.latest.dryRun, undefined);
    assert.equal(r.download.dmg.sha256, sha256(Buffer.from('DMG BYTES')));
    assert.equal(r.download.dmg.bytes, 9);
    assert.equal(r.download.dryRun, false);
    const listed = (await fsp.readdir(r.releasesDir)).sort();
    assert.deepEqual(listed, ['Maka-0.1.0-aarch64.app.tar.gz', 'Maka-0.1.0-aarch64.app.tar.gz.sig', 'Maka-0.1.0-aarch64.dmg', 'SHA256SUMS', 'download.json', 'latest.json']);
    const sums = await fsp.readFile(path.join(r.releasesDir, 'SHA256SUMS'), 'utf8');
    assert.match(sums, new RegExp(`^${sha256(Buffer.from('DMG BYTES'))}  Maka-0.1.0-aarch64.dmg$`, 'm'));
    const page = await fsp.readFile(path.join(r.siteDir, 'index.html'), 'utf8');
    assert.doesNotMatch(page, /0\.1\.0/, 'the page reads download.json; it carries no version');
    assert.match(page, /releases\/download\.json/);
    await fsp.rm(path.join(rel, names.signature));
    await assert.rejects(site({ root, out, log: { info() {} } }), /missing signature/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('release --dry-run: the exact sequence (gates, Node, build, notarize, staple, Gatekeeper, site) is planned and nothing runs; the manifests say dry run', async () => {
  const root = await tempRepo();
  const out = path.join(root, 'dist');
  const log = { info() {}, warn() {} };
  try {
    const smokeCalls = [];
    const r = await release({ root, out, dryRun: true, env: {}, log, smoke: async ({ app, dryRun }) => { smokeCalls.push({ app, dryRun }); return { ok: true, dryRun }; } });
    assert.deepEqual(r.steps, ['gates', 'build', 'notarize', 'smoke', 'site']);
    assert.equal(r.dryRun, true);
    assert.equal(smokeCalls.length, 1);
    assert.equal(smokeCalls[0].dryRun, true);
    const plan = await fsp.readFile(r.plan, 'utf8');
    const lines = plan.split('\n').filter((l) => l && !l.startsWith('#') && l !== 'set -e');
    const heads = lines.map((l) => l.replace(/^\(cd [^&]+&& /, '').replace(/\)$/, '').replace(/^(?:[A-Z_]+=<set> )+/, '').split(' ').slice(0, 3).join(' '));
    assert.deepEqual(heads, [
      'npm run test:fast',
      'npm run demo',
      'npm run demo:phase4',
      'npm run shell:check',
      'node scripts/release-node.mjs --triple',
      'cargo tauri build',
      'xcrun notarytool submit',
      'xcrun stapler staple',
      'xcrun stapler validate',
      'spctl --assess --type',
      'codesign --verify --deep',
      'spctl --assess --type',
      'xcrun stapler validate',
    ]);
    assert.match(plan, /cargo tauri build --target aarch64-apple-darwin --config .*tauri\.release\.conf\.json\)/);
    assert.match(plan, /notarytool submit .*Maka-0\.1\.0-aarch64\.dmg .* --wait/);
    assert.doesNotMatch(plan, /sk-|password=[^<]/, 'no secret value in the plan');
    const overlay = JSON.parse(await fsp.readFile(path.join(out, 'release', 'tauri.release.conf.json'), 'utf8'));
    assert.equal(overlay.plugins.updater.pubkey, 'DRY-RUN-NO-PUBKEY');
    const latest = JSON.parse(await fsp.readFile(path.join(out, 'site', 'releases', 'latest.json'), 'utf8'));
    assert.equal(latest.dryRun, true);
    assert.equal(latest.platforms['darwin-aarch64'].signature, 'DRY-RUN-SIGNATURE');
    const download = JSON.parse(await fsp.readFile(path.join(out, 'site', 'releases', 'download.json'), 'utf8'));
    assert.equal(download.dryRun, true);
    assert.equal(download.dmg.sha256, 'dry-run');
    assert.equal(await fsp.access(path.join(out, 'site', 'releases', 'Maka-0.1.0-aarch64.dmg')).then(() => true, () => false), false, 'no artifact was invented');
    const summary = JSON.parse(await fsp.readFile(path.join(out, 'release', 'summary.json'), 'utf8'));
    assert.equal(summary.signing.canSign, false);
    assert.equal(summary.smoke.ok, true);
    // A real run refuses without the signing identity, before anything is built.
    await assert.rejects(release({ root, out, dryRun: false, env: {}, log, skipGates: true, skipSmoke: true }), /not tagged|cannot sign|no updater public key/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('smoke: launches the bundle\'s binary with a fresh home, checks the sidecar from the bundle, stops it; dry-run only plans', async () => {
  const { smoke, findMainBinary } = await import('../scripts/release-smoke.mjs');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-smoke-app-'));
  const app = path.join(dir, 'Maka.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  await fsp.mkdir(macos, { recursive: true });
  // A stand-in for the shell: announces the park like src-tauri/src/lib.rs does, then runs the real sidecar.
  await fsp.writeFile(path.join(macos, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await fsp.writeFile(path.join(macos, 'Maka'), `#!/bin/sh\necho "maka: park at http://127.0.0.1:$MAKA_PORT/"\nexec env PORT=$MAKA_PORT HOST=127.0.0.1 MAKA_WORKSPACE="$MAKA_HOME/ws" ${process.execPath} ${path.join(REPO_ROOT, 'sidecar', 'index.js')}\n`, { mode: 0o755 });
  const log = { info() {}, warn() {} };
  try {
    assert.equal(await findMainBinary(app), path.join(macos, 'Maka'));
    const dry = await smoke({ app, dryRun: true, log, env: {} });
    assert.deepEqual([dry.ok, dry.dryRun], [true, true]);
    const r = await smoke({ app, log, env: { ...process.env }, expectBroker: false, timeoutMs: 60_000 });
    assert.equal(r.ok, true);
    const names = r.checks.map((c) => c.check);
    assert.ok(names.includes('first run on a fresh home'), names.join(', '));
    assert.ok(names.includes('the vendored renderer is served'));
    assert.ok(names.includes('the sidecar stopped with the app'));
    assert.ok(r.checks.every((c) => c.ok));
    assert.equal(await fsp.access(r.home).then(() => true, () => false), false, 'the temporary home is removed');
    // A bundle whose sidecar never answers fails plainly, with the app's output.
    await fsp.writeFile(path.join(macos, 'Maka'), '#!/bin/sh\necho "maka: nothing"\nsleep 30\n', { mode: 0o755 });
    await assert.rejects(smoke({ app, log, env: {}, timeoutMs: 1500 }), /no \/api\/state on http:\/\/127\.0\.0\.1:\d+ within/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the runbook names every release script, every signing variable, the gates and the Node version it bundles', async () => {
  const runbook = await fsp.readFile(path.join(REPO_ROOT, 'docs', 'RELEASE_RUNBOOK.md'), 'utf8');
  const { SIGNING_ENV, NODE_VERSION } = await import('../scripts/release-lib.mjs');
  const scripts = (await fsp.readdir(path.join(REPO_ROOT, 'scripts'))).filter((f) => /^release.*\.mjs$/.test(f) && f !== 'release-lib.mjs');
  assert.ok(scripts.length >= 6, scripts.join(', '));
  for (const s of scripts) assert.ok(runbook.includes(s), `runbook mentions ${s}`);
  for (const k of Object.keys(SIGNING_ENV)) assert.ok(runbook.includes(k), `runbook mentions ${k}`);
  for (const cmd of ['npm run test:fast', 'npm run demo', 'npm run demo:phase4', 'npm run shell:check', 'npm run release:dry', 'npm run release', 'cargo tauri signer generate', 'xcrun notarytool store-credentials', 'node scripts/park-check.mjs', 'sysadminctl -addUser']) assert.ok(runbook.includes(cmd), `runbook has ${cmd}`);
  assert.ok(runbook.includes(NODE_VERSION), 'the bundled Node version');
  assert.ok(runbook.includes('releases/latest.json') && runbook.includes('releases/download.json'));
  const pkg = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs');
  assert.equal(pkg.scripts['release:dry'], 'node scripts/release.mjs --dry-run');
});
