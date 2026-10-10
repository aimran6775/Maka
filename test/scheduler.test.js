import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createScheduler, nextRunAt, validateSpec } from '../sidecar/scheduler.js';

const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

test('nextRunAt is pure: daily times roll to tomorrow once passed, intervals add', () => {
  assert.equal(nextRunAt({ daily: '07:00' }, at(2026, 10, 10, 6, 59)), at(2026, 10, 10, 7, 0));
  assert.equal(nextRunAt({ daily: '07:00' }, at(2026, 10, 10, 7, 0)), at(2026, 10, 11, 7, 0), 'strictly after');
  assert.equal(nextRunAt({ daily: '23:30' }, at(2026, 12, 31, 23, 45)), at(2027, 1, 1, 23, 30));
  assert.equal(nextRunAt({ everyMs: 60_000 }, 1000), 61_000);
  assert.throws(() => nextRunAt({ daily: '25:00' }, 0), /out of range/);
  assert.throws(() => nextRunAt({ daily: 'noon' }, 0), /HH:MM/);
  assert.throws(() => validateSpec({ everyMs: 10 }), /at least 1000/);
  assert.throws(() => validateSpec({}), /daily or everyMs/);
  assert.deepEqual(validateSpec({ daily: '7:05', extra: 1 }), { daily: '7:05' });
});

test('scheduler: due jobs run once per tick under a lock, manual trigger, persistence and missed runs after a restart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-sched-'));
  try {
    const store = createStore({ root: dir });
    await store.init();
    let now = at(2026, 10, 10, 6, 0);
    const clock = { now: () => now };
    const sched = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
    const calls = [];
    let release = null;
    const next = sched.add('daily', { daily: '07:00' }, async (ctx) => {
      calls.push(ctx);
      if (release) await new Promise((r) => { release = r; });
    });
    assert.equal(next, at(2026, 10, 10, 7, 0));
    sched.add('fast', { everyMs: 60_000 }, async (ctx) => calls.push(ctx));
    assert.throws(() => sched.add('bad', { daily: 'x' }, () => {}), /HH:MM/);
    assert.deepEqual(await sched.tick(), [], 'nothing due at 06:00');
    now = at(2026, 10, 10, 7, 0);
    const r1 = await sched.tick();
    assert.deepEqual(r1.map((r) => [r.id, r.ran, r.ok]), [['daily', true, true], ['fast', true, true]]);
    assert.deepEqual(calls.map((c) => [c.id, c.reason]), [['daily', 'scheduled'], ['fast', 'missed']], 'the minute job was due at 06:01 and is 59 minutes late');
    assert.equal(sched.state().daily.nextRunAt, at(2026, 10, 11, 7, 0));
    assert.deepEqual(await sched.tick(), [], 'not due again this minute');
    // A manual trigger runs now and reschedules from then; an overlapping trigger is skipped.
    release = () => {};
    const manual = sched.trigger('daily', 'budget');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await sched.trigger('daily', 'again'), { ran: false, why: 'already running' });
    release();
    assert.deepEqual(await manual, { ran: true, ok: true });
    assert.equal(calls.at(-1).reason, 'budget');
    assert.throws(() => sched.trigger('nope'), /no scheduled job/);
    // A failing job records the error and still reschedules.
    sched.add('boom', { everyMs: 1000 }, async () => { throw new Error('kaput'); });
    now += 2000;
    await sched.tick();
    assert.equal(sched.state().boom.lastOk, false);
    assert.equal(sched.state().boom.lastError, 'kaput');
    await sched.flushed();
    const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'scheduler.json'), 'utf8'));
    assert.equal(onDisk.jobs.daily.lastReason, 'budget');

    // Restart two days later: the daily job is overdue and runs on the first tick as 'missed'.
    now = at(2026, 10, 12, 9, 0);
    const again = await createScheduler({ store, clock, tickMs: 60_000, log: { error() {} } }).init();
    const later = [];
    again.add('daily', { daily: '07:00' }, async (ctx) => later.push(ctx));
    assert.equal(again.state().daily.lastReason, 'budget', 'persisted state survives');
    const r2 = await again.tick();
    assert.deepEqual(r2.map((r) => r.id), ['daily']);
    assert.equal(later[0].reason, 'missed');
    assert.equal(again.state().daily.nextRunAt, at(2026, 10, 13, 7, 0));
    again.start();
    again.start();
    again.stop();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
