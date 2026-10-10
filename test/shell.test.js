// Phase 3 step 1: the Tauri shell's files as data. The Rust itself is checked with
// `cargo check --target aarch64-apple-darwin` (and `cargo test` on a Mac); this suite
// keeps the config, the pins and the generated icons honest under node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { REPO_ROOT } from '../sidecar/index.js';
import { renderAll, encodePng, raster, markSample } from '../scripts/make-icons.mjs';

const shell = path.join(REPO_ROOT, 'src-tauri');
const read = (rel) => fsp.readFile(path.join(shell, rel), 'utf8');

test('tauri.conf.json: valid JSON, the version comes from package.json, every referenced file exists, the bundle carries the sidecar', async () => {
  const conf = JSON.parse(await read('tauri.conf.json'));
  assert.equal(conf.identifier, 'com.makapark.maka');
  assert.equal(conf.version, '../package.json', 'one version, in package.json');
  assert.deepEqual(conf.app.windows, [], 'the window is created in code once the sidecar answers');
  for (const icon of conf.bundle.icon) assert.ok((await fsp.stat(path.join(shell, icon))).isFile(), icon);
  assert.ok((await fsp.stat(path.join(shell, conf.build.frontendDist, 'index.html'))).isFile(), 'the splash page');
  assert.ok((await fsp.stat(path.join(shell, conf.bundle.macOS.entitlements))).isFile());
  assert.deepEqual(conf.bundle.externalBin, ['binaries/node'], 'Node is bundled as an external binary');
  for (const [src, dest] of Object.entries(conf.bundle.resources)) {
    assert.ok(await fsp.stat(path.join(shell, src)), `resource ${src}`);
    assert.equal(dest.replace(/\/$/, ''), path.basename(src.replace(/\/$/, '')), 'resources keep their names so sidecar/index.js finds ../frontend');
  }
  assert.ok(conf.bundle.resources['../package.json'], 'package.json carries "type": "module" for the sidecar');
  const release = JSON.parse(await read('tauri.release.conf.json'));
  assert.equal(release.plugins.updater.pubkey, '__TAURI_UPDATER_PUBKEY__', 'substituted by the release script, never committed');
  assert.deepEqual(release.plugins.updater.endpoints, ['https://makapark.com/releases/latest.json']);
  assert.equal(release.bundle.createUpdaterArtifacts, true);
  const cap = JSON.parse(await read('capabilities/default.json'));
  assert.deepEqual(cap.windows, ['main']);
  assert.deepEqual(cap.permissions, ['core:default'], 'the park page calls no Tauri command');
  const ent = await read('Entitlements.plist');
  for (const key of ['allow-jit', 'allow-unsigned-executable-memory']) assert.match(ent, new RegExp(`com.apple.security.cs.${key}`), `V8 needs ${key}`);
});

test('Cargo.toml pins every crate exactly and the sidecar stays dependency-free', async () => {
  const cargo = await read('Cargo.toml');
  const sections = cargo.split(/^\[/m).filter((s) => /^(build-|target\..*\.)?dependencies\]/.test(s));
  const deps = sections.flatMap((s) => [...s.matchAll(/^([a-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)]);
  assert.ok(deps.length >= 6, `found ${deps.length} dependencies`);
  for (const m of deps) assert.match(m[2] || m[3], /^=\d+\.\d+\.\d+$/, `${m[1]} must be pinned with =x.y.z`);
  assert.match(cargo, /security-framework/, 'the Keychain crate');
  const pkg = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  const ignore = await read('.gitignore');
  assert.match(ignore, /binaries\/node-\*/, 'the downloaded Node binary is never committed');
  assert.match(ignore, /target\//);
});

test('icons: the generator is deterministic, PNGs and the ICNS are well formed, and the committed files match it', async () => {
  const files = renderAll();
  const png = files['icon.png'];
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  const icns = files['icon.icns'];
  assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  for (let o = 8; o < icns.length;) {
    types.push(icns.subarray(o, o + 4).toString('latin1'));
    o += icns.readUInt32BE(o + 4);
  }
  assert.deepEqual(types, ['ic07', 'ic08', 'ic09', 'ic10']);
  const again = renderAll();
  for (const name of Object.keys(files)) {
    assert.ok(files[name].equals(again[name]), `${name} deterministic`);
    const committed = await fsp.readFile(path.join(shell, 'icons', name));
    assert.ok(committed.equals(files[name]), `${name} on disk matches the generator (run node scripts/make-icons.mjs)`);
  }
  // The mark: green square, cream mountain, a sun, transparent corners.
  assert.deepEqual(markSample(0.02, 0.02), [0, 0, 0, 0]);
  assert.deepEqual(markSample(0.5, 0.6), [0xf1, 0xe9, 0xd2, 255]);
  assert.deepEqual(markSample(0.75, 0.3), [0xff, 0xd3, 0x6b, 255]);
  assert.deepEqual(markSample(0.1, 0.5), [0x4f, 0x8a, 0x3f, 255]);
  const tiny = encodePng(2, raster(2, markSample, 1));
  assert.equal(tiny.readUInt32BE(16), 2);
});

test('the splash page shows only what the shell passes in its hash', async () => {
  const html = await read('ui/index.html');
  assert.match(html, /Starting the sidecar/);
  assert.match(html, /params\.get\('error'\)/);
  assert.doesNotMatch(html, /<progress|progress bar|\d+\s?% done/i, 'no simulated progress');
});
