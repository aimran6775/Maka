// Away mode (phase 2 step 8): the Superintendent sets the leashes, leaves, and comes back
// to a full account of what happened.
//
//   createAway({ bus, store, gateQueue, workspaceRoot, clock, notify })
//     -> { init(), state(), set(away), digest(), logPath }
//
// While away (persisted in away.json so a restart keeps it):
//   - every gate.item (any status), work.done, plan.updated, reflection.posted,
//     budget.threshold and agent.run.error is appended as one JSON line to
//     <root>/_peak/away-log.ndjson (the evidence log; append + fsync per line);
//   - the Gate queue stamps `away: true` on action items (gate-queue.js isAway);
//   - counters run: actions (Gate items decided or logged by the leash), spend.
// On return a digest is written to <root>/_peak/digest-<id>.md (+ .json): the window, the
// counts by status, domain and agent, what still waits at the Gate, work finished, spend,
// and the evidence lines themselves summarised. away.digest is emitted; `notify(digest)`
// (mail to gate@ once the mail system exists) is called when provided. Nothing is hidden
// and nothing is rolled back here: the log says what happened; undo is per connector.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';

export const LOGGED_TYPES = Object.freeze(['gate.item', 'work.done', 'plan.updated', 'reflection.posted', 'budget.threshold', 'agent.run.error']);

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function digestMarkdown(d) {
  const lines = [`# Away digest ${d.digestId}`, '', `Away from ${new Date(d.since).toISOString()} to ${new Date(d.until).toISOString()} (${Math.round((d.until - d.since) / 60000)} min).`, '', `Actions at the Gate: ${d.actions} · still waiting on you: ${d.waiting} · work items finished: ${d.workDone} (${d.workFailed} failed) · spend $${d.spentUsd.toFixed(4)} · evidence lines: ${d.lines}`, ''];
  const table = (title, obj) => {
    const entries = Object.entries(obj);
    if (!entries.length) return;
    lines.push(`## ${title}`, '', ...entries.map(([k, v]) => `- ${k}: ${v}`), '');
  };
  table('Gate items by status', d.byStatus);
  table('Gate items by domain', d.byDomain);
  table('Gate items by Ranger', d.byAgent);
  if (d.waitingItems.length) lines.push('## Waiting on you', '', ...d.waitingItems.map((it) => `- [${it.domain}] ${it.agentId}: ${it.summary}`), '');
  if (d.notable.length) lines.push('## Notable', '', ...d.notable.map((n) => `- ${n}`), '');
  lines.push(`Evidence log: ${d.logPath}`);
  return lines.join('\n');
}

export function createAway({ bus, store, gateQueue = null, workspaceRoot, clock = { now: () => Date.now() }, notify = null, log = console } = {}) {
  if (!bus || !store || !workspaceRoot) throw new TypeError('createAway needs bus, store and workspaceRoot');
  const peakDir = path.join(workspaceRoot, '_peak');
  const logPath = path.join(peakDir, 'away-log.ndjson');
  let state = { version: 1, away: false, since: 0, actions: 0, spentUsd: 0, workDone: 0, workFailed: 0, lines: 0, lastDigest: null };
  let writing = Promise.resolve();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const waiting = () => (gateQueue ? gateQueue.pending().length : 0);

  const save = () => {
    writing = writing.then(() => store.saveAway(state)).catch((err) => log.error('away save failed:', err));
    return writing;
  };

  async function appendLine(entry) {
    await fsp.mkdir(peakDir, { recursive: true });
    const handle = await fsp.open(logPath, 'a');
    try {
      await handle.writeFile(JSON.stringify(entry) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  bus.listen((event) => {
    if (!state.away) return;
    if (event.type === 'cost.estimate') {
      const p = event.payload;
      if (p.reconciled && typeof p.usd === 'number') state.spentUsd += p.usd;
      return;
    }
    if (!LOGGED_TYPES.includes(event.type)) return;
    if (event.type === 'gate.item' && event.payload.status !== 'pending') state.actions += 1;
    if (event.type === 'work.done') {
      if (event.payload.status === 'done') state.workDone += 1;
      else state.workFailed += 1;
    }
    state.lines += 1;
    writing = writing.then(() => appendLine({ ts: event.ts, seq: event.seq, type: event.type, payload: event.payload })).catch((err) => log.error('away log append failed:', err));
    save();
  });

  async function readLog(since) {
    let text = '';
    try {
      text = await fsp.readFile(logPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.ts >= since) out.push(e);
      } catch {
        /* a torn line at the end of the file is skipped */
      }
    }
    return out;
  }

  async function digest() {
    const until = clock.now();
    const entries = await readLog(state.since);
    const items = entries.filter((e) => e.type === 'gate.item');
    const count = (list, key) => list.reduce((acc, e) => ((acc[key(e)] = (acc[key(e)] || 0) + 1), acc), {});
    const latestById = new Map();
    for (const e of items) latestById.set(e.payload.itemId, e.payload);
    const decided = [...latestById.values()].filter((p) => p.status !== 'pending');
    const notable = [];
    for (const e of entries) {
      if (e.type === 'plan.updated' && e.payload.change === 'submitted') notable.push(`plan v${e.payload.version} submitted: ${(e.payload.summary || '').slice(0, 120)}`);
      if (e.type === 'reflection.posted') notable.push(`reflection ${e.payload.reflectionId} ${e.payload.status}${e.payload.skipReason ? ` (${e.payload.skipReason})` : ''}`);
      if (e.type === 'budget.threshold') notable.push(`budget: ${e.payload.scope} ${e.payload.id} at ${Math.round(e.payload.fraction * 100)} %`);
      if (e.type === 'agent.run.error') notable.push(`run ${e.payload.runId} failed: ${e.payload.message.slice(0, 100)}`);
    }
    const pendingNow = gateQueue ? gateQueue.pending() : [];
    const d = {
      digestId: `digest-${new Date(until).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`,
      since: state.since,
      until,
      actions: decided.length,
      waiting: pendingNow.length,
      waitingItems: pendingNow.map((it) => ({ itemId: it.itemId, domain: it.domain, agentId: it.agentId, summary: it.summary })),
      workDone: state.workDone,
      workFailed: state.workFailed,
      spentUsd: state.spentUsd,
      lines: entries.length,
      byStatus: count(decided, (p) => p.status),
      byDomain: count(decided, (p) => p.domain),
      byAgent: count(decided, (p) => p.agentId),
      notable: notable.slice(0, 40),
      logPath: path.relative(workspaceRoot, logPath),
      path: '',
    };
    await fsp.mkdir(peakDir, { recursive: true });
    const mdPath = path.join(peakDir, `${d.digestId}.md`);
    await fsp.writeFile(mdPath, digestMarkdown(d), 'utf8');
    await fsp.writeFile(path.join(peakDir, `${d.digestId}.json`), JSON.stringify(d, null, 2) + '\n', 'utf8');
    d.path = path.relative(workspaceRoot, mdPath);
    return d;
  }

  return {
    logPath,
    async init() {
      const loaded = await store.loadAway(null);
      if (loaded && loaded.version === 1) state = { ...state, ...loaded };
      return this;
    },
    state: () => ({ away: state.away, since: state.since, actions: state.actions, waiting: waiting(), spentUsd: state.spentUsd, workDone: state.workDone, workFailed: state.workFailed, lines: state.lines, lastDigest: state.lastDigest, logPath: path.relative(workspaceRoot, logPath) }),
    async set(away) {
      if (typeof away !== 'boolean') throw fail('BAD_REQUEST', 'away must be true or false');
      if (away === state.away) return { state: this.state(), digest: null };
      if (away) {
        state = { ...state, away: true, since: clock.now(), actions: 0, spentUsd: 0, workDone: 0, workFailed: 0, lines: 0 };
        await save();
        emit('away.changed', { away: true, since: state.since, actions: 0, waiting: waiting() });
        return { state: this.state(), digest: null };
      }
      await writing; // every logged line is on disk before the digest reads them
      const d = await digest();
      state = { ...state, away: false, lastDigest: { digestId: d.digestId, since: d.since, until: d.until, actions: d.actions, waiting: d.waiting, spentUsd: d.spentUsd, path: d.path } };
      await save();
      emit('away.changed', { away: false, since: d.until, actions: d.actions, waiting: d.waiting });
      emit('away.digest', { digestId: d.digestId, since: d.since, until: d.until, actions: d.actions, waiting: d.waiting, spentUsd: d.spentUsd, path: d.path, summary: `${d.actions} Gate action(s), ${d.waiting} waiting, ${d.workDone} work item(s) done, $${d.spentUsd.toFixed(2)} spent` });
      if (notify) {
        try {
          await notify(d);
        } catch (err) {
          log.error('away digest notify failed:', err);
        }
      }
      return { state: this.state(), digest: d };
    },
    digest,
    readLog: () => readLog(0),
    flushed: () => writing,
  };
}
