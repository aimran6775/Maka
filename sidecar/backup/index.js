// Offsite backup to Cloudflare R2 (phase 3 step 5): scheduled encrypted snapshots of the
// Peak's files, the ledgers, the mail store and the deliverables, under the
// Superintendent's control, with a restore that never writes over live data.
//
//   createBackup({ store, scheduler, bus, home, workspaceRoot, env, keystorePath, config,
//                  fetch, clock, fs, hostname, log })
//     -> { init(), status(), configure(patch), snapshot({ reason }), list(), restore({ key, into }),
//          verify({ key }), collect(), close() }
//
// What a snapshot holds (relative paths inside the tar):
//   workspace/_peak/**            the evidence log and digests
//   workspace/_mail/**            the mail store (index, messages, attachments, suppression)
//   workspace/<agent>/outbox/**   every Ranger's deliverables
//   home/<ledger>.json            spend, leash ledger, leash, layout, gate and work items,
//                                 mission, plan, away, mail addresses, scheduler
//   home/reflections/*.json, home/connectors/*.json
// Not included: run transcripts (large, and the ledgers carry the totals), browser
// profiles (cookies), the keystore (never leaves the machine).
//
// Credentials: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (env or
// the keystore / Keychain), the bucket from config.json `backup.bucket` or R2_BUCKET.
// The snapshot key (32 bytes, hex) is MAKA_BACKUP_KEY or the keystore's `backupKey`;
// `configure({ enabled: true })` makes one when none exists and returns it once so the
// owner can write it down: without it a snapshot cannot be opened anywhere.

import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeEvent } from '../../shared/events.js';
import { readJson, writeJsonAtomic } from '../store.js';
import { resolveKey, setKey } from '../providers/keys.js';
import { createS3, r2Endpoint, sha256Hex } from './s3.js';
import { seal, open as openSnapshot, keyFromHex, newKeyHex } from './archive.js';

export const DEFAULT_AT = '03:00';
export const DEFAULT_PREFIX = 'maka';
export const JOB_ID = 'backup';
export const HOME_FILES = Object.freeze(['spend.json', 'leash-ledger.json', 'leash.json', 'layout.json', 'gate-items.json', 'work-items.json', 'mission.json', 'plan.json', 'away.json', 'mail-addresses.json', 'scheduler.json', 'setup.json']);
export const HOME_DIRS = Object.freeze(['reflections', 'connectors']);
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const safeHost = (h) => String(h || 'mac').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mac';
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

export function createBackup({ store = null, scheduler = null, bus = null, home, workspaceRoot, env = process.env, keystorePath, config = {}, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, fs = fsp, hostname = os.hostname(), log = console, endpoint = null } = {}) {
  if (!home || !workspaceRoot) throw new TypeError('createBackup needs home and workspaceRoot');
  const stateFile = path.join(home, 'backups.json');
  const cfgFile = path.join(home, 'config.json');
  let cfg = { enabled: Boolean(config.enabled), at: config.at || DEFAULT_AT, bucket: config.bucket || (env.R2_BUCKET || '').trim() || null, prefix: config.prefix || DEFAULT_PREFIX };
  let state = { version: 1, history: [], lastRestore: null };
  let running = null;
  const emit = (type, payload) => bus && bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const host = safeHost(hostname);

  async function creds() {
    const [accountId, accessKeyId, secretAccessKey, keyHex] = await Promise.all([resolveKey('cloudflareAccountId', { env, keystorePath }), resolveKey('r2AccessKeyId', { env, keystorePath }), resolveKey('r2SecretAccessKey', { env, keystorePath }), resolveKey('backupKey', { env, keystorePath })]);
    return { accountId, accessKeyId, secretAccessKey, keyHex, bucket: cfg.bucket };
  }

  function missing(c) {
    const out = [];
    if (!c.accountId) out.push('CLOUDFLARE_ACCOUNT_ID');
    if (!c.accessKeyId) out.push('R2_ACCESS_KEY_ID');
    if (!c.secretAccessKey) out.push('R2_SECRET_ACCESS_KEY');
    if (!c.bucket) out.push('backup.bucket (config.json) or R2_BUCKET');
    return out;
  }

  async function client() {
    const c = await creds();
    const miss = missing(c);
    if (miss.length) throw fail('NOT_WIRED', `R2 backup is not wired: set ${miss.join(', ')}`, 409);
    if (!c.keyHex) throw fail('NO_BACKUP_KEY', 'no snapshot key: enable backups first (MAKA_BACKUP_KEY or the keystore backupKey)', 409);
    const key = keyFromHex(c.keyHex);
    const s3 = createS3({ endpoint: endpoint || r2Endpoint(c.accountId), bucket: c.bucket, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, fetch: fetchImpl, clock });
    return { s3, key };
  }

  async function walk(dir, rel, out, filter = null) {
    let names = [];
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const d of names) {
      if (d.name.startsWith('.')) continue;
      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(abs, r, out, filter);
      else if (d.isFile() && (!filter || filter(r))) out.push({ path: r, abs });
    }
  }

  // The files a snapshot carries, as { path, abs }; data is read at snapshot time.
  async function collect() {
    const files = [];
    await walk(path.join(workspaceRoot, '_peak'), 'workspace/_peak', files);
    await walk(path.join(workspaceRoot, '_mail'), 'workspace/_mail', files);
    let agents = [];
    try {
      agents = (await fs.readdir(workspaceRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')).map((d) => d.name);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const a of agents) await walk(path.join(workspaceRoot, a, 'outbox'), `workspace/${a}/outbox`, files);
    for (const f of HOME_FILES) {
      try {
        if ((await fs.stat(path.join(home, f))).isFile()) files.push({ path: `home/${f}`, abs: path.join(home, f) });
      } catch {
        /* absent */
      }
    }
    for (const d of HOME_DIRS) await walk(path.join(home, d), `home/${d}`, files, (r) => r.endsWith('.json'));
    return files;
  }

  async function save() {
    await writeJsonAtomic(stateFile, state, { fs });
  }

  function record(entry) {
    state.history = [entry, ...state.history].slice(0, 50);
  }

  function schedule() {
    if (!scheduler) return;
    scheduler.remove(JOB_ID);
    if (cfg.enabled) scheduler.add(JOB_ID, { daily: cfg.at }, ({ reason }) => api.snapshot({ reason }));
  }

  const api = {
    async init() {
      const loaded = await readJson(stateFile, null, { fs });
      if (loaded && typeof loaded === 'object' && Array.isArray(loaded.history)) state = loaded;
      schedule();
      return this;
    },
    collect,
    config: () => ({ ...cfg }),
    async status() {
      const c = await creds();
      const miss = missing(c);
      const job = scheduler ? scheduler.state()[JOB_ID] || null : null;
      return {
        enabled: cfg.enabled,
        at: cfg.at,
        bucket: cfg.bucket,
        prefix: `${cfg.prefix}/${host}`,
        endpoint: endpoint || (c.accountId ? r2Endpoint(c.accountId) : null),
        wired: miss.length === 0,
        missing: miss,
        hasKey: Boolean(c.keyHex),
        keys: { accountId: Boolean(c.accountId), accessKeyId: Boolean(c.accessKeyId), secretAccessKey: Boolean(c.secretAccessKey) },
        job: job ? { nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt, lastOk: job.lastOk, lastError: job.lastError } : null,
        running: running ? { startedAt: running.startedAt, reason: running.reason } : null,
        last: state.history[0] || null,
        lastRestore: state.lastRestore,
        history: state.history.slice(0, 10),
      };
    },
    // Writes backup settings into config.json and reschedules at once. Enabling with no
    // snapshot key makes one and returns it (`keyHex`) this one time.
    async configure({ enabled, at, bucket, prefix } = {}) {
      const next = { ...cfg };
      if (enabled !== undefined) next.enabled = Boolean(enabled);
      if (at !== undefined) {
        if (!/^\d{1,2}:\d{2}$/.test(String(at))) throw fail('BAD_REQUEST', 'at must be HH:MM');
        next.at = String(at);
      }
      if (bucket !== undefined) {
        if (bucket !== null && (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))) throw fail('BAD_REQUEST', 'bucket must be a valid bucket name');
        next.bucket = bucket;
      }
      if (prefix !== undefined) {
        if (typeof prefix !== 'string' || !/^[A-Za-z0-9_.\/-]{1,80}$/.test(prefix) || prefix.includes('..')) throw fail('BAD_REQUEST', 'prefix must be a short path without ..');
        next.prefix = prefix.replace(/^\/+|\/+$/g, '');
      }
      let keyHex = null;
      if (next.enabled && !(await resolveKey('backupKey', { env, keystorePath }))) {
        keyHex = newKeyHex();
        await setKey('backupKey', keyHex, { env, keystorePath });
      }
      let file = {};
      try {
        file = (await readJson(cfgFile, {}, { fs })) || {};
      } catch (err) {
        throw fail('CONFIG_UNREADABLE', `${cfgFile} could not be read: ${err.message}`);
      }
      const backup = { enabled: next.enabled, at: next.at, prefix: next.prefix };
      if (next.bucket) backup.bucket = next.bucket;
      await writeJsonAtomic(cfgFile, { ...file, backup }, { fs });
      cfg = next;
      schedule();
      return { ...(await api.status()), keyHex, keyNote: keyHex ? 'Write this key down somewhere safe: it is the only way to open a snapshot on another machine. Maka keeps it in the Keychain (the keystore without the app) and will not show it again.' : null };
    },
    // One snapshot now: collect → tar → gzip → encrypt → PUT, then the index object.
    async snapshot({ reason = 'manual' } = {}) {
      if (running) throw fail('BACKUP_ACTIVE', `a snapshot is already running (${running.reason})`, 409);
      const startedAt = clock.now();
      running = { startedAt, reason };
      let c;
      try {
        c = await client();
      } catch (err) {
        running = null;
        const entry = { at: startedAt, reason, status: 'skipped', error: err.message };
        record(entry);
        await save();
        emit('backup.snapshot', { status: 'skipped', reason, error: err.message });
        throw err;
      }
      emit('backup.snapshot', { status: 'started', reason });
      const key = `${cfg.prefix}/${host}/${stamp(startedAt)}.tar.gz.enc`;
      try {
        const files = await collect();
        const entries = [];
        let bytes = 0;
        for (const f of files) {
          const st = await fs.stat(f.abs);
          const data = await fs.readFile(f.abs);
          bytes += data.length;
          if (bytes > MAX_SNAPSHOT_BYTES) throw fail('TOO_LARGE', `the snapshot passed ${MAX_SNAPSHOT_BYTES} bytes at ${f.path}`);
          entries.push({ path: f.path, data, mode: st.mode & 0o777, mtime: st.mtimeMs });
        }
        const sealed = seal(entries, c.key);
        const digest = sha256Hex(sealed);
        await c.s3.put(key, sealed, { contentType: 'application/octet-stream', metadata: { files: entries.length, bytes, sha256: digest, host, reason } });
        const index = { version: 1, key, at: startedAt, files: entries.length, bytes, sealedBytes: sealed.length, sha256: digest, host, paths: entries.map((e) => e.path) };
        await c.s3.put(`${cfg.prefix}/${host}/latest.json`, JSON.stringify(index, null, 2), { contentType: 'application/json' });
        const entry = { at: startedAt, finishedAt: clock.now(), reason, status: 'done', key, files: entries.length, bytes, sealedBytes: sealed.length, sha256: digest };
        record(entry);
        await save();
        emit('backup.snapshot', { status: 'done', reason, key, files: entries.length, bytes: sealed.length });
        return entry;
      } catch (err) {
        const entry = { at: startedAt, finishedAt: clock.now(), reason, status: 'failed', key, error: err.message };
        record(entry);
        await save();
        emit('backup.snapshot', { status: 'failed', reason, key, error: err.message });
        throw err;
      } finally {
        running = null;
      }
    },
    async list() {
      const c = await client();
      const items = await c.s3.list(`${cfg.prefix}/${host}/`);
      return items.filter((i) => i.key.endsWith('.tar.gz.enc')).map((i) => ({ key: i.key, bytes: i.size, lastModified: i.lastModified })).reverse();
    },
    async latestKey(c) {
      const { body } = await c.s3.get(`${cfg.prefix}/${host}/latest.json`);
      const idx = JSON.parse(body.toString('utf8'));
      if (!idx || typeof idx.key !== 'string') throw fail('BAD_INDEX', 'latest.json is not a snapshot index', 502);
      return idx.key;
    },
    // Opens a snapshot without writing anything: the key opens it, the files are listed.
    async verify({ key = null } = {}) {
      const c = await client();
      const k = key || (await api.latestKey(c));
      try {
        const { body } = await c.s3.get(k);
        const entries = openSnapshot(body, c.key);
        emit('backup.restore', { status: 'verified', key: k, files: entries.length });
        return { key: k, files: entries.length, bytes: body.length, paths: entries.map((e) => e.path) };
      } catch (err) {
        emit('backup.restore', { status: 'failed', key: k, error: err.message });
        throw err;
      }
    },
    // Restores into a fresh directory under the workspace (`_restore/<stamp>/`) or `into`
    // (must be empty or absent); never over live data. Paths are checked to stay inside.
    async restore({ key = null, into = null } = {}) {
      const c = await client();
      const k = key || (await api.latestKey(c));
      const target = path.resolve(into || path.join(workspaceRoot, '_restore', stamp(clock.now())));
      try {
        let existing = [];
        try {
          existing = await fs.readdir(target);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        if (existing.length) throw fail('NOT_EMPTY', `${target} is not empty; restore into a fresh directory`, 409);
        const { body } = await c.s3.get(k);
        const entries = openSnapshot(body, c.key);
        for (const e of entries) {
          const dest = path.resolve(target, e.path);
          if (dest !== target && !dest.startsWith(target + path.sep)) throw fail('BAD_SNAPSHOT', `entry escapes the target: ${e.path}`, 502);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, e.data, { mode: e.mode || 0o644 });
        }
        state.lastRestore = { at: clock.now(), key: k, into: target, files: entries.length };
        await save();
        emit('backup.restore', { status: 'done', key: k, into: target, files: entries.length });
        return { ...state.lastRestore, paths: entries.map((e) => e.path) };
      } catch (err) {
        emit('backup.restore', { status: 'failed', key: k, into: target, error: err.message });
        throw err;
      }
    },
    close() {
      if (scheduler) scheduler.remove(JOB_ID);
    },
  };
  return api;
}
