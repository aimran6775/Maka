// A small cron-like scheduler (phase 2 step 6): pure next-run math, one lock per job, and
// a persisted record of the last run so a restart neither re-runs a job that already ran
// today nor forgets one that was due while the sidecar was down.
//
//   nextRunAt(spec, afterMs)  pure: the next due time strictly after `afterMs`
//     spec = { daily: 'HH:MM' }   every day at that local time
//          | { everyMs: n }       every n milliseconds (from the last run, or from now)
//
//   createScheduler({ store, clock, tickMs })
//     -> { add(id, spec, fn), remove(id), start(), stop(), tick(), trigger(id, reason), state() }
//   fn({ id, reason, scheduledFor }) runs under the job's lock; an overlapping tick skips it.
//   A job found overdue at start (the sidecar was down when it was due) runs on the first
//   tick with reason 'missed'. Used by the reflection cycle (sidecar/reflect.js) and later
//   by connector syncs.

const DAY_MS = 24 * 3600 * 1000;

function parseDaily(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!m) throw new Error(`daily time must be HH:MM, got "${text}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`daily time out of range: "${text}"`);
  return { h, min };
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  if (spec.daily !== undefined) {
    parseDaily(spec.daily);
    return { daily: spec.daily };
  }
  if (spec.everyMs !== undefined) {
    if (!Number.isFinite(spec.everyMs) || spec.everyMs < 1000) throw new Error('everyMs must be at least 1000');
    return { everyMs: spec.everyMs };
  }
  throw new Error('spec needs daily or everyMs');
}

export function nextRunAt(spec, afterMs) {
  const s = validateSpec(spec);
  if (s.everyMs) return afterMs + s.everyMs;
  const { h, min } = parseDaily(s.daily);
  const d = new Date(afterMs);
  const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, min, 0, 0).getTime();
  if (candidate > afterMs) return candidate;
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, min, 0, 0).getTime();
  return next > afterMs ? next : afterMs + DAY_MS;
}

export function createScheduler({ store = null, clock = { now: () => Date.now() }, tickMs = 60_000, log = console } = {}) {
  const jobs = new Map(); // id -> { spec, fn, lastRunAt, nextRunAt, running, lastReason, lastOk, lastError }
  let timer = null;
  let loaded = null;
  let saving = Promise.resolve();

  const save = () => {
    if (!store) return Promise.resolve();
    const state = { version: 1, jobs: {} };
    for (const [id, j] of jobs) state.jobs[id] = { lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt, lastReason: j.lastReason, lastOk: j.lastOk, lastError: j.lastError };
    saving = saving.then(() => store.saveScheduler(state)).catch((err) => log.error('scheduler save failed:', err));
    return saving;
  };

  async function runJob(j, reason, scheduledFor) {
    if (j.running) return { ran: false, why: 'already running' };
    j.running = true;
    j.lastReason = reason;
    try {
      await j.fn({ id: j.id, reason, scheduledFor });
      j.lastOk = true;
      j.lastError = null;
    } catch (err) {
      j.lastOk = false;
      j.lastError = err && err.message ? err.message : String(err);
      log.error(`scheduled job ${j.id} failed:`, err);
    } finally {
      j.running = false;
      j.lastRunAt = clock.now();
      j.nextRunAt = nextRunAt(j.spec, j.lastRunAt);
      await save();
    }
    return { ran: true, ok: j.lastOk };
  }

  return {
    async init() {
      if (store) loaded = await store.loadScheduler(null);
      return this;
    },
    add(id, spec, fn) {
      if (typeof fn !== 'function') throw new TypeError('add needs fn');
      const clean = validateSpec(spec);
      const prev = loaded && loaded.jobs && loaded.jobs[id];
      const now = clock.now();
      const j = { id, spec: clean, fn, running: false, lastRunAt: prev ? prev.lastRunAt : null, lastReason: prev ? prev.lastReason : null, lastOk: prev ? prev.lastOk : null, lastError: prev ? prev.lastError : null };
      // Next run: from the persisted last run when there was one, else from now. A job
      // whose persisted next run is already past is overdue and runs on the first tick.
      j.nextRunAt = prev && prev.nextRunAt ? prev.nextRunAt : nextRunAt(clean, j.lastRunAt || now);
      jobs.set(id, j);
      return j.nextRunAt;
    },
    remove(id) {
      return jobs.delete(id);
    },
    async tick() {
      const now = clock.now();
      const results = [];
      for (const j of jobs.values()) {
        if (j.nextRunAt <= now && !j.running) {
          const missed = now - j.nextRunAt > Math.max(2 * tickMs, 5 * 60_000);
          results.push({ id: j.id, ...(await runJob(j, missed ? 'missed' : 'scheduled', j.nextRunAt)) });
        }
      }
      return results;
    },
    trigger(id, reason = 'manual') {
      const j = jobs.get(id);
      if (!j) throw new Error(`no scheduled job "${id}"`);
      return runJob(j, reason, clock.now());
    },
    start() {
      if (timer) return;
      timer = setInterval(() => this.tick().catch((err) => log.error('scheduler tick failed:', err)), tickMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    state() {
      const out = {};
      for (const [id, j] of jobs) out[id] = { spec: j.spec, lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt, running: j.running, lastReason: j.lastReason, lastOk: j.lastOk, lastError: j.lastError };
      return out;
    },
    flushed: () => saving,
  };
}
