// Phase 3 step 5: the R2 backup. The signer against AWS's published example, the
// archive format, the S3 client against a fake that verifies every signature with its
// own code, the backup module end to end (collect, snapshot, list, verify, restore into
// a fresh directory, wrong key, scheduler), and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { signV4, uriEncode, parseList, createS3, r2Endpoint, EMPTY_SHA256 } from '../sidecar/backup/s3.js';
import { packTar, readTar, encrypt, decrypt, seal, open as openSnapshot, keyFromHex, newKeyHex, MAGIC } from '../sidecar/backup/archive.js';
import { createBackup, HOME_FILES } from '../sidecar/backup/index.js';
import { startFakeS3 } from './helpers/fake-s3.js';
import { createEventBus } from '../sidecar/bus.js';
import { createScheduler } from '../sidecar/scheduler.js';
import { readJson } from '../sidecar/store.js';
import { resolveKey, setKey } from '../sidecar/providers/keys.js';
import { startTestServer } from './helpers/test-server.js';
import { fakeProvider, text, end } from './helpers/fake-provider.js';

test('signV4 reproduces the AWS "GET object" example signature', () => {
  const r = signV4({
    method: 'GET',
    path: '/test.txt',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    payloadHash: EMPTY_SHA256,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    now: Date.UTC(2013, 4, 24, 0, 0, 0),
  });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(r.headers['x-amz-date'], '20130524T000000Z');
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8/);
  assert.equal(uriEncode('/maka/my mac/2026-10-10T03:00:00.000Z.tar.gz.enc'), '/maka/my%20mac/2026-10-10T03%3A00%3A00.000Z.tar.gz.enc');
  assert.equal(uriEncode('a/b', { keepSlash: false }), 'a%2Fb');
  const parsed = parseList('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken><Contents><Key>maka/a&amp;b.enc</Key><LastModified>2026-10-10T03:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents></ListBucketResult>');
  assert.deepEqual(parsed, { items: [{ key: 'maka/a&b.enc', size: 12, lastModified: '2026-10-10T03:00:00.000Z', etag: 'abc' }], truncated: true, nextToken: 't&2' });
  assert.equal(r2Endpoint('0123456789abcdef0123456789ABCDEF'), 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
  assert.throws(() => r2Endpoint('short'), /32-hex/);
});

test('archive: tar round trip (long paths, modes, mtimes), AES-GCM with a bad key or header refused, seal / open', () => {
  const long = `workspace/${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(40)}.md`;
  const entries = [{ path: 'home/spend.json', data: Buffer.from('{"totalUsd":1}'), mode: 0o600, mtime: 1_700_000_000_000 }, { path: long, data: Buffer.alloc(1000, 7) }, { path: 'empty.txt', data: Buffer.alloc(0) }];
  const tar = packTar(entries);
  assert.equal(tar.length % 512, 0);
  const back = readTar(tar);
  assert.deepEqual(back.map((e) => [e.path, e.data.length, e.mode]), [['home/spend.json', 14, 0o600], [long, 1000, 0o644], ['empty.txt', 0, 0o644]]);
  assert.equal(back[0].mtime, 1_700_000_000_000);
  assert.ok(back[1].data.every((b) => b === 7));
  assert.throws(() => packTar([{ path: '../x', data: Buffer.alloc(1) }]), /bad tar entry path/);
  assert.throws(() => packTar([{ path: '/abs', data: Buffer.alloc(1) }]), /bad tar entry path/);
  const key = keyFromHex(newKeyHex());
  const sealed = encrypt(Buffer.from('hello'), key);
  assert.ok(sealed.subarray(0, 5).equals(MAGIC));
  assert.equal(decrypt(sealed, key).toString(), 'hello');
  assert.throws(() => decrypt(sealed, keyFromHex(newKeyHex())), (e) => e.code === 'BAD_KEY');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(tampered, key), (e) => e.code === 'BAD_KEY');
  assert.throws(() => decrypt(Buffer.from('nope'), key), (e) => e.code === 'BAD_SNAPSHOT');
  assert.throws(() => keyFromHex('abc'), (e) => e.code === 'BAD_KEY');
  const snap = seal(entries, key);
  assert.deepEqual(openSnapshot(snap, key).map((e) => e.path), entries.map((e) => e.path));
});

test('S3 client against the fake: head, put with metadata, get, paged list, delete, errors in S3 shape, a wrong secret refused', async () => {
  const fake = await startFakeS3({ pageSize: 2 });
  try {
    const s3 = createS3({ endpoint: fake.url, bucket: fake.bucket, accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey });
    assert.deepEqual(await s3.headBucket(), { ok: true, bucket: 'maka-backups' });
    const put = await s3.put('maka/test mac/a.enc', Buffer.from('AAA'), { metadata: { files: 3, Host: 'x' } });
    assert.equal(put.bytes, 3);
    assert.ok(put.etag);
    await s3.put('maka/test mac/b.enc', Buffer.from('B'));
    await s3.put('maka/test mac/c.enc', Buffer.from('CC'));
    await s3.put('other/d.enc', Buffer.from('D'));
    const got = await s3.get('maka/test mac/a.enc');
    assert.equal(got.body.toString(), 'AAA');
    assert.deepEqual(got.metadata, { files: '3', host: 'x' });
    const listed = await s3.list('maka/test mac/');
    assert.deepEqual(listed.map((i) => [i.key, i.size]), [['maka/test mac/a.enc', 3], ['maka/test mac/b.enc', 1], ['maka/test mac/c.enc', 2]]);
    assert.equal(fake.calls.filter((c) => c.query['list-type'] === '2').length, 2, 'two pages');
    await s3.delete('maka/test mac/b.enc');
    assert.equal((await s3.list('maka/')).length, 2);
    await assert.rejects(s3.get('maka/missing'), (e) => e.code === 'HTTP_404' && /NoSuchKey/.test(e.message));
    const wrong = createS3({ endpoint: fake.url, bucket: fake.bucket, accessKeyId: fake.accessKeyId, secretAccessKey: 'nope' });
    await assert.rejects(wrong.headBucket(), (e) => e.code === 'HTTP_403');
    await assert.rejects(wrong.list(''), (e) => e.code === 'HTTP_403' && /SignatureDoesNotMatch/.test(e.message));
    const other = createS3({ endpoint: fake.url, bucket: 'elsewhere', accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey });
    await assert.rejects(other.headBucket(), (e) => e.code === 'HTTP_404');
    fake.fail = 'down';
    await assert.rejects(s3.headBucket(), (e) => e.code === 'HTTP_500');
    fake.fail = null;
    await fake.close();
    await assert.rejects(s3.headBucket(), (e) => e.code === 'NETWORK');
  } finally {
    await fake.close().catch(() => {});
  }
});

async function seedData(home, ws) {
  await fsp.mkdir(path.join(ws, '_peak'), { recursive: true });
  await fsp.writeFile(path.join(ws, '_peak', 'away-log.ndjson'), '{"a":1}\n');
  await fsp.mkdir(path.join(ws, '_mail', 'messages'), { recursive: true });
  await fsp.writeFile(path.join(ws, '_mail', 'index.json'), '{}');
  await fsp.writeFile(path.join(ws, '_mail', 'messages', 'm1.json'), '{"id":"m1"}');
  await fsp.mkdir(path.join(ws, 'ranger', 'outbox'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'ranger', 'outbox', 'report.md'), '# report');
  await fsp.mkdir(path.join(ws, 'ranger', 'browser-profile'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'ranger', 'browser-profile', 'Cookies'), 'secret');
  await fsp.writeFile(path.join(ws, 'ranger', 'notes.txt'), 'not in the outbox');
  await fsp.mkdir(path.join(home, 'runs'), { recursive: true });
  await fsp.writeFile(path.join(home, 'runs', 'run-1.json'), '{}');
  await fsp.mkdir(path.join(home, 'reflections'), { recursive: true });
  await fsp.writeFile(path.join(home, 'reflections', 'r1.json'), '{"id":"r1"}');
  await fsp.writeFile(path.join(home, 'spend.json'), '{"totalUsd":2}');
  await fsp.writeFile(path.join(home, 'leash-ledger.json'), '{"days":{}}');
  await fsp.writeFile(path.join(home, 'keystore.json'), '{"anthropic":"sk"}', { mode: 0o600 });
}

test('backup module: not wired is a plain skip; enabling makes the key once and schedules; a snapshot carries the right files, lists, verifies and restores into a fresh directory', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-backup-'));
  const home = path.join(tmp, 'home');
  const ws = path.join(tmp, 'ws');
  await seedData(home, ws);
  const fake = await startFakeS3();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  let now = Date.UTC(2026, 9, 10, 2, 0, 0);
  const clock = { now: () => now };
  const scheduler = await createScheduler({ clock, tickMs: 60_000, log: { error() {} } }).init();
  const keystorePath = path.join(home, 'keystore.json');
  const env = {};
  const make = (config = {}) => createBackup({ scheduler, bus, home, workspaceRoot: ws, env, keystorePath, config, clock, hostname: 'Owner’s MacBook Pro', endpoint: fake.url, log: { error() {} } }).init();
  try {
    let backup = await make();
    let st = await backup.status();
    assert.equal(st.wired, false);
    assert.deepEqual(st.missing, ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'backup.bucket (config.json) or R2_BUCKET']);
    assert.equal(st.prefix, 'maka/owner-s-macbook-pro');
    await assert.rejects(backup.snapshot({ reason: 'manual' }), (e) => e.code === 'NOT_WIRED');
    assert.equal(events.at(-1).type, 'backup.snapshot');
    assert.equal(events.at(-1).payload.status, 'skipped');
    assert.match(events.at(-1).payload.error, /CLOUDFLARE_ACCOUNT_ID/);

    env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    await setKey('r2AccessKeyId', fake.accessKeyId, { env, keystorePath });
    await setKey('r2SecretAccessKey', fake.secretAccessKey, { env, keystorePath });
    const enabled = await backup.configure({ enabled: true, bucket: fake.bucket, at: '03:00' });
    assert.equal(enabled.wired, true);
    assert.equal(enabled.enabled, true);
    assert.match(enabled.keyHex, /^[0-9a-f]{64}$/, 'the key is made once and returned once');
    assert.match(enabled.keyNote, /Write this key down/);
    assert.equal(await resolveKey('backupKey', { env, keystorePath }), enabled.keyHex);
    assert.deepEqual(await readJson(path.join(home, 'config.json')), { backup: { enabled: true, at: '03:00', prefix: 'maka', bucket: fake.bucket } });
    assert.ok(scheduler.state().backup, 'a daily job');
    assert.equal(scheduler.state().backup.spec.daily, '03:00');
    const again = await backup.configure({ at: '04:30' });
    assert.equal(again.keyHex, null, 'no second key');
    assert.equal(scheduler.state().backup.spec.daily, '04:30');
    await assert.rejects(backup.configure({ at: 'noon' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(backup.configure({ bucket: 'Bad Bucket' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(backup.configure({ prefix: '../x' }), (e) => e.code === 'BAD_REQUEST');

    const files = (await backup.collect()).map((f) => f.path).sort();
    assert.deepEqual(files, ['home/leash-ledger.json', 'home/reflections/r1.json', 'home/spend.json', 'workspace/_mail/index.json', 'workspace/_mail/messages/m1.json', 'workspace/_peak/away-log.ndjson', 'workspace/ranger/outbox/report.md']);
    assert.ok(!files.some((f) => /keystore|runs\/|browser-profile|notes\.txt/.test(f)), 'secrets, transcripts, cookies and loose files stay out');

    const entry = await backup.snapshot({ reason: 'manual' });
    assert.equal(entry.status, 'done');
    assert.equal(entry.files, 7);
    assert.equal(entry.key, 'maka/owner-s-macbook-pro/2026-10-10T02-00-00-000Z.tar.gz.enc');
    const stored = fake.objects.get(entry.key);
    assert.ok(stored, 'the sealed object is in the bucket');
    assert.equal(stored.metadata.files, '7');
    assert.ok(stored.body.subarray(0, 5).equals(MAGIC), 'encrypted on the wire');
    assert.equal(stored.body.includes(Buffer.from('# report')), false);
    const index = JSON.parse(fake.objects.get('maka/owner-s-macbook-pro/latest.json').body.toString());
    assert.equal(index.key, entry.key);
    assert.deepEqual(index.paths.sort(), files);
    const snapEvents = events.filter((e) => e.type === 'backup.snapshot').map((e) => e.payload.status);
    assert.deepEqual(snapEvents.slice(-2), ['started', 'done']);
    assert.equal(events.at(-1).payload.bytes, stored.body.length);
    assert.equal((await backup.status()).last.status, 'done');
    assert.equal((await readJson(path.join(home, 'backups.json'))).history[0].key, entry.key);

    now += 3600_000;
    const second = await backup.snapshot({ reason: 'manual' });
    assert.deepEqual((await backup.list()).map((i) => i.key), [second.key, entry.key], 'newest first');

    const verified = await backup.verify({});
    assert.equal(verified.key, second.key);
    assert.equal(verified.files, 7);
    assert.equal(events.at(-1).payload.status, 'verified');

    const restored = await backup.restore({ key: entry.key });
    assert.equal(restored.into, path.join(ws, '_restore', '2026-10-10T03-00-00-000Z'));
    assert.equal(await fsp.readFile(path.join(restored.into, 'workspace', 'ranger', 'outbox', 'report.md'), 'utf8'), '# report');
    assert.equal(await fsp.readFile(path.join(restored.into, 'home', 'spend.json'), 'utf8'), '{"totalUsd":2}');
    assert.equal(await fsp.readFile(path.join(ws, 'ranger', 'outbox', 'report.md'), 'utf8'), '# report', 'live data untouched');
    assert.equal(events.at(-1).payload.status, 'done');
    await assert.rejects(backup.restore({ key: entry.key, into: restored.into }), (e) => e.code === 'NOT_EMPTY');
    assert.equal((await backup.status()).lastRestore.files, 7);
    assert.equal(events.at(-1).payload.status, 'failed');
    assert.match(events.at(-1).payload.error, /not empty/);

    // The scheduler runs it with its reason.
    const { ran } = await scheduler.trigger('backup', 'scheduled');
    assert.equal(ran, true);
    assert.equal((await backup.status()).last.reason, 'scheduled');

    // A wrong key opens nothing and says so; the sealed bytes are useless without it.
    await setKey('backupKey', newKeyHex(), { env, keystorePath });
    backup = await make({ enabled: true, bucket: fake.bucket });
    await assert.rejects(backup.verify({ key: entry.key }), (e) => e.code === 'BAD_KEY');
    assert.equal(events.at(-1).payload.status, 'failed');
    await assert.rejects(backup.restore({ key: entry.key, into: path.join(tmp, 'r2') }), (e) => e.code === 'BAD_KEY');

    // Disabled: no job; a snapshot still works on demand.
    const off = await backup.configure({ enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(scheduler.state().backup, undefined);
    fake.fail = 'quota';
    await assert.rejects(backup.snapshot({ reason: 'manual' }), (e) => e.code === 'HTTP_500');
    assert.equal(events.at(-1).payload.status, 'failed');
    assert.match(events.at(-1).payload.error, /quota/);
  } finally {
    await fake.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('over HTTP: the backup status in the state, config, a snapshot, the list, verify and restore', async () => {
  const fake = await startFakeS3();
  const srv = await startTestServer({ makeProvider: async () => ({ provider: fakeProvider([[text('ok'), end()]]), model: 'm', price: null }), env: { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: fake.accessKeyId, R2_SECRET_ACCESS_KEY: fake.secretAccessKey, R2_BUCKET: fake.bucket }, backup: { endpoint: fake.url } });
  try {
    await fsp.mkdir(path.join(srv.workspaceRoot, '_peak'), { recursive: true });
    await fsp.writeFile(path.join(srv.workspaceRoot, '_peak', 'away-log.ndjson'), '{}\n');
    const state = await srv.get('/api/state');
    assert.equal(state.body.backup.wired, true);
    assert.equal(state.body.backup.enabled, false);
    assert.equal(state.body.backup.hasKey, false);
    assert.equal((await srv.post('/api/backup/now', {})).status, 409, 'no key yet');
    const cfg = await srv.post('/api/backup/config', { enabled: true, at: '03:15' });
    assert.equal(cfg.status, 200);
    assert.match(cfg.body.keyHex, /^[0-9a-f]{64}$/);
    assert.equal(cfg.body.job.nextRunAt > 0, true);
    const stream = await srv.sse();
    const now = await srv.post('/api/backup/now', {});
    assert.equal(now.status, 200);
    assert.equal(now.body.status, 'done');
    await stream.waitFor((e) => e.type === 'backup.snapshot' && e.payload.status === 'done');
    const list = await srv.get('/api/backup/list');
    assert.deepEqual(list.body.map((i) => i.key), [now.body.key]);
    const verify = await srv.post('/api/backup/verify', {});
    assert.equal(verify.body.files, now.body.files);
    const restore = await srv.post('/api/backup/restore', {});
    assert.equal(restore.status, 200);
    assert.ok(restore.body.into.startsWith(path.join(srv.workspaceRoot, '_restore')));
    assert.equal((await srv.get('/api/backup')).body.lastRestore.key, now.body.key);
    assert.equal((await srv.post('/api/backup/config', { at: 'x' })).status, 400);
    stream.close();
  } finally {
    await srv.close();
    await fake.close();
  }
});
