import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readZip, checkVendored, fetchAll, SOURCES } from '../scripts/fetch-assets.mjs';

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

test('vendored assets match the manifest and every source is CC0 or CC-BY with evidence', async () => {
  assert.deepEqual(await checkVendored(), []);
  for (const s of SOURCES) {
    assert.match(s.license, /^CC0-1\.0$|^CC-BY-4\.0$/, s.id);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, s.id);
    assert.ok(s.licenseEvidence.length > 10, s.id);
    assert.ok(s.page.startsWith('https://'), s.id);
  }
});

test('fetchAll refuses an archive whose hash does not match the pin, before extracting', async () => {
  const bogus = makeZip({ 'Tilemap/tilemap_packed.png': 'not the real file' });
  assert.notEqual(createHash('sha256').update(bogus).digest('hex'), SOURCES[0].sha256);
  await assert.rejects(fetchAll({ log: { info() {} }, fetchImpl: async () => bogus }), /does not match the pinned/);
  assert.deepEqual(await checkVendored(), [], 'nothing on disk changed');
});
