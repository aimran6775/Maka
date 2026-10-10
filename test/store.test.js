import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { writeJsonAtomic, readJson, createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { makeEvent } from '../shared/events.js';

test('writeJsonAtomic: temp file in the same dir, fsync, rename; no temp left; overwrite is whole', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-store-'));
  const file = path.join(dir, 'nested', 'a.json');
  await writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(await readJson(file), { a: 1 });
  await writeJsonAtomic(file, { a: 2, b: [1, 2] });
  assert.deepEqual(await readJson(file), { a: 2, b: [1, 2] });
  const names = await fsp.readdir(path.join(dir, 'nested'));
  assert.deepEqual(names, ['a.json']);
  assert.equal(await readJson(path.join(dir, 'missing.json'), 'fallback'), 'fallback');

  // A failed rename (target is a directory) leaves no temp file and throws.
  await fsp.mkdir(path.join(dir, 'isdir'));
  await assert.rejects(writeJsonAtomic(path.join(dir, 'isdir'), { x: 1 }));
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['isdir', 'nested']);

  // The write path uses open → writeFile → sync → close → rename, in that order.
  const calls = [];
  const spyFs = {
    mkdir: fsp.mkdir.bind(fsp),
    rm: fsp.rm.bind(fsp),
    rename: async (a, b) => { calls.push('rename'); return fsp.rename(a, b); },
    open: async (p, flags, mode) => {
      const h = await fsp.open(p, flags, mode);
      calls.push(`open:${flags}`);
      return {
        writeFile: async (...args) => { calls.push('write'); return h.writeFile(...args); },
        sync: async () => { calls.push(`sync:${flags}`); return h.sync(); },
        close: async () => { calls.push(`close:${flags}`); return h.close(); },
      };
    },
  };
  await writeJsonAtomic(path.join(dir, 'spy.json'), { s: 1 }, { fs: spyFs });
  assert.deepEqual(calls, ['open:w', 'write', 'sync:w', 'close:w', 'rename', 'open:r', 'sync:r', 'close:r']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('store: layout, spend, runs round-trip; listRuns sorts newest first and skips junk', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-store2-'));
  const store = createStore({ root: dir });
  await store.init();
  assert.equal(await store.loadLayout(null), null);
  await store.saveLayout({ version: 1, rooms: [], objects: [], agents: [] });
  assert.deepEqual(await store.loadLayout(null), { version: 1, rooms: [], objects: [], agents: [] });
  const spend = await store.loadSpend();
  assert.equal(spend.totalUsd, 0);
  spend.totalUsd = 0.5;
  await store.saveSpend(spend);
  assert.equal((await store.loadSpend()).totalUsd, 0.5);

  await store.saveRun({ runId: 'run-a', agentId: 'hero', provider: 'fake', model: 'm', status: 'ended', startedAt: 10, prompt: 'p', events: [] });
  await store.saveRun({ runId: 'run-b', agentId: 'hero', provider: 'fake', model: 'm', status: 'running', startedAt: 20, prompt: 'q', events: [] });
  await fsp.writeFile(path.join(dir, 'runs', 'notes.txt'), 'ignored');
  const list = await store.listRuns();
  assert.deepEqual(list.map((r) => r.runId), ['run-b', 'run-a']);
  assert.equal(list[0].spentUsd, 0);
  assert.equal((await store.loadRun('run-a')).prompt, 'p');
  assert.equal(await store.loadRun('run-zzz'), null);
  await assert.rejects(store.loadRun('../etc/passwd'), /bad runId/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('event bus: validates, numbers, buffers, replays, notifies listeners', () => {
  const bus = createEventBus({ bufferSize: 3 });
  const seen = [];
  const off = bus.listen((e) => seen.push(e.seq));
  const ev = (i) => makeEvent('agent.token', { runId: 'r', turn: 1, text: String(i) }, { ts: i });
  for (let i = 1; i <= 5; i++) bus.emit(ev(i));
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.deepEqual(bus.since(3).map((e) => e.seq), [4, 5]);
  assert.deepEqual(bus.recent(10).map((e) => e.payload.text), ['3', '4', '5']);
  assert.equal(bus.seq, 5);
  off();
  bus.emit(ev(6));
  assert.equal(seen.length, 5);
  assert.throws(() => bus.emit({ v: 1, id: 'x', type: 'agent.token', ts: 1, payload: {} }), /failed validation/);
  assert.equal(bus.seq, 6, 'an invalid event consumes no seq');
  // A throwing listener does not stop delivery.
  bus.listen(() => { throw new Error('boom'); });
  const got = [];
  bus.listen((e) => got.push(e.seq));
  const origError = console.error;
  console.error = () => {};
  try {
    bus.emit(ev(7));
  } finally {
    console.error = origError;
  }
  assert.deepEqual(got, [7]);
});
