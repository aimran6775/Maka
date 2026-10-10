import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readZip, readTgz, checkVendored, fetchAll, SOURCES, UNPINNED } from '../scripts/fetch-assets.mjs';
import { gzipSync } from 'node:zlib';

// Builds a minimal zip (stored or deflated) without any library, for the reader test.
function makeZip(files, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('zip reader handles stored and deflated entries and rejects junk', () => {
  for (const deflate of [false, true]) {
    const zip = readZip(makeZip({ 'a/b.txt': 'hello', 'c.bin': 'x'.repeat(5000) }, { deflate }));
    assert.deepEqual(zip.names(), ['a/b.txt', 'c.bin']);
    assert.equal(zip.read('a/b.txt').toString(), 'hello');
    assert.equal(zip.read('c.bin').length, 5000);
    assert.throws(() => zip.read('nope'), /not in the archive/);
  }
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /not a zip/);
});

test('vendored assets match the manifest and every source is CC0, CC-BY or MIT with evidence', async () => {
  assert.deepEqual(await checkVendored(), []);
  for (const s of SOURCES) {
    assert.match(s.license, /^CC0-1\.0$|^CC-BY-4\.0$|^MIT$/, s.id);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, s.id);
    assert.ok(s.licenseEvidence.length > 10, s.id);
    assert.ok(s.page.startsWith('https://'), s.id);
  }
});

test('fetchAll refuses an archive whose hash does not match the pin, before extracting', async () => {
  const bogus = makeZip({ 'package/LICENSE': 'not the real file' });
  assert.notEqual(createHash('sha256').update(bogus).digest('hex'), SOURCES[0].sha256);
  await assert.rejects(fetchAll({ log: { info() {} }, fetchImpl: async () => bogus }), /does not match the pinned/);
  assert.deepEqual(await checkVendored(), [], 'nothing on disk changed');
});

// Builds a minimal ustar tar.gz for the tgz reader test.
function makeTgz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
    header.write('0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
    blocks.push(header, data, pad);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('tgz reader lists and reads ustar entries', () => {
  const tgz = readTgz(makeTgz({ 'package/LICENSE': 'MIT', 'package/build/x.js': 'export const x = 1;\n' }));
  assert.deepEqual(tgz.names(), ['package/LICENSE', 'package/build/x.js']);
  assert.equal(tgz.read('package/build/x.js').toString(), 'export const x = 1;\n');
  assert.throws(() => tgz.read('nope'), /not in the archive/);
  assert.ok(UNPINNED[0].status.startsWith('not fetched'));
});
