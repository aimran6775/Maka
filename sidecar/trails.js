// Trails: delegated work items that travel between zones (phase 2 step 4).
//
//   createTrails({ bus, store, runs, agents, getLayout, clock, workspaceRoot })
//     -> { init(), delegate(spec, { by }), list(), get(id), forAgent(id), cancel(id) }
//
// A work item is { id, brief, budgetUsd, deadline, evidence[], fromAgentId, toAgentId,
// fromRoomId, toRoomId, trailId, status, runId, createdAt, startedAt, endedAt,
// deliverables[], summary, reason, spentUsd }. delegate() validates who may hand work to
// whom (the Chief to anyone, a Ranger to its Juniors or other Rangers, never a Junior and
// never to the Chief), persists the item, emits work.handoff and enqueues a run for the
// receiver with a brief built from the item. The run manager's end hook closes the item:
// the files that appeared in the receiver's outbox during the run are its deliverables and
// work.done carries them. Items persist in work-items.json.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';
import { agentOf } from '../shared/world.js';

export const WORK_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled']);
const DEFAULT_ITEM_TURNS = 12;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function briefFor(item) {
  const lines = [
    `Work item ${item.id} from ${item.fromAgentId}.`,
    '',
    'BRIEF:',
    item.brief,
    '',
    `Budget: $${item.budgetUsd.toFixed(2)} of model spend.`,
  ];
  if (item.deadline) lines.push(`Deadline: ${item.deadline}.`);
  if (item.evidence && item.evidence.length) lines.push('', 'Evidence required with the deliverable:', ...item.evidence.map((e) => `- ${e}`));
  lines.push('', 'Write finished deliverables under outbox/ with fs.write when you have it, then summarise what you delivered and what you could not.');
  return lines.join('\n');
}

async function listOutbox(dir) {
  const out = new Map();
  async function walk(rel) {
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        const st = await fsp.stat(path.join(dir, r)).catch(() => null);
        if (st) out.set(r, st.mtimeMs + ':' + st.size);
      }
    }
  }
  await walk('outbox');
  return out;
}

export function createTrails({ bus, store, runs, agents = null, getLayout, clock = { now: () => Date.now() }, workspaceRoot, maxItems = 1000 } = {}) {
  if (!bus || !store || !runs || typeof getLayout !== 'function' || !workspaceRoot) throw new TypeError('createTrails needs bus, store, runs, getLayout and workspaceRoot');
  let items = [];
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(() => store.saveWorkItems({ version: 1, items })).catch((err) => console.error('work items save failed:', err));
    return saving;
  };
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const find = (id) => items.find((it) => it.id === id) || null;
  const before = new Map(); // runId -> outbox snapshot at start

  function mayDelegate(from, to) {
    const fromRole = from.role || 'ranger';
    const toRole = to.role || 'ranger';
    if (from.id === to.id) throw fail('BAD_REQUEST', 'an agent cannot delegate to itself');
    if (fromRole === 'junior_ranger') throw fail('FORBIDDEN', 'Junior Rangers cannot delegate', 403);
    if (toRole === 'chief_ranger') throw fail('FORBIDDEN', 'work is not delegated to the Chief Ranger', 403);
    if (fromRole === 'ranger' && toRole === 'junior_ranger' && to.parentAgentId !== from.id) throw fail('FORBIDDEN', `${to.id} is not ${from.id}'s Junior`, 403);
  }

  runs.onRunEnd(async ({ runId, record, outcome, workspaceDir }) => {
    const item = items.find((it) => it.runId === runId);
    if (!item || item.status !== 'running') return;
    const start = before.get(runId) || new Map();
    before.delete(runId);
    const after = await listOutbox(workspaceDir);
    const deliverables = [...after.entries()].filter(([rel, sig]) => start.get(rel) !== sig).map(([rel]) => rel).sort();
    item.status = outcome.reason === 'completed' ? 'done' : 'failed';
    item.reason = outcome.reason;
    item.endedAt = clock.now();
    item.deliverables = deliverables;
    item.summary = (outcome.finalText || (outcome.error ? outcome.error.message : '') || '').slice(0, 2000);
    item.spentUsd = record.spentUsd || 0;
    emit('work.done', { workItemId: item.id, fromAgentId: item.fromAgentId, toAgentId: item.toAgentId, runId, status: item.status, reason: item.reason, deliverables, summary: item.summary, spentUsd: item.spentUsd });
    await save();
  });

  const api = {
    async init() {
      const loaded = await store.loadWorkItems(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.items)) items = loaded.items;
      let changed = false;
      for (const it of items) {
        if (it.status === 'queued' || it.status === 'running') {
          it.status = 'failed';
          it.reason = 'sidecar restarted';
          it.endedAt = clock.now();
          changed = true;
        }
      }
      if (changed) await save();
      return this;
    },
    list: () => items.slice().reverse(),
    get: (id) => (find(id) ? { ...find(id) } : null),
    forAgent: (agentId) => items.filter((it) => it.fromAgentId === agentId || it.toAgentId === agentId).reverse(),
    inTransit: () => items.filter((it) => it.status === 'queued' || it.status === 'running'),
    async delegate({ toAgentId, brief, budgetUsd = 0.5, deadline = null, evidence = [], maxTurns = DEFAULT_ITEM_TURNS } = {}, { by } = {}) {
      if (!by) throw fail('BAD_REQUEST', 'delegate needs a delegating agent (by)');
      if (typeof brief !== 'string' || !brief.trim()) throw fail('BAD_REQUEST', 'brief is required');
      if (typeof budgetUsd !== 'number' || !(budgetUsd >= 0)) throw fail('BAD_REQUEST', 'budgetUsd must be a non-negative number');
      if (deadline !== null && deadline !== undefined && typeof deadline !== 'string') throw fail('BAD_REQUEST', 'deadline must be a string');
      if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'string')) throw fail('BAD_REQUEST', 'evidence must be a list of strings');
      const layout = getLayout();
      const to = agentOf(layout, toAgentId);
      if (!to) throw fail('BAD_REQUEST', `unknown receiver "${toAgentId}"`);
      const from = by === 'superintendent' ? { id: 'superintendent', role: 'superintendent', roomId: 'entrance-gate' } : agentOf(layout, by);
      if (!from) throw fail('BAD_REQUEST', `unknown delegator "${by}"`);
      if (by !== 'superintendent') mayDelegate(from, to);
      const item = {
        id: `work-${randomUUID().slice(0, 8)}`,
        brief: brief.trim(),
        budgetUsd,
        deadline: deadline || null,
        evidence,
        fromAgentId: from.id,
        toAgentId: to.id,
        fromRoomId: from.roomId,
        toRoomId: to.roomId,
        trailId: `trail:${from.roomId}:${to.roomId}`,
        status: 'queued',
        runId: null,
        createdAt: clock.now(),
        startedAt: null,
        endedAt: null,
        deliverables: [],
        summary: '',
        reason: null,
        spentUsd: 0,
      };
      items.push(item);
      if (items.length > maxItems) items = items.filter((it) => it.status === 'queued' || it.status === 'running').concat(items.filter((it) => it.status !== 'queued' && it.status !== 'running').slice(-maxItems));
      emit('work.handoff', { fromAgentId: item.fromAgentId, toAgentId: item.toAgentId, fromRoomId: item.fromRoomId, toRoomId: item.toRoomId, trailId: item.trailId, workItemId: item.id, summary: item.brief.slice(0, 200) });
      let started;
      try {
        before.set('pending:' + item.id, null);
        started = await runs.start({ agentId: to.id, prompt: briefFor(item), budgetUsd, maxTurns, workItemId: item.id });
      } catch (err) {
        item.status = 'failed';
        item.reason = err.code || 'START_FAILED';
        item.summary = err.message;
        item.endedAt = clock.now();
        emit('work.done', { workItemId: item.id, fromAgentId: item.fromAgentId, toAgentId: item.toAgentId, runId: 'none', status: 'failed', reason: item.reason, deliverables: [], summary: item.summary, spentUsd: 0 });
        await save();
        throw err;
      }
      item.runId = started.runId;
      item.status = 'running';
      item.startedAt = clock.now();
      before.set(started.runId, await listOutbox(path.join(workspaceRoot, to.id)));
      await save();
      return { ...item, queued: started.queued };
    },
    async cancel(id) {
      const item = find(id);
      if (!item) throw fail('NOT_FOUND', `no work item "${id}"`, 404);
      if (item.status !== 'queued' && item.status !== 'running') throw fail('CONFLICT', `work item ${id} is already ${item.status}`, 409);
      if (item.runId) runs.cancel(item.runId);
      return { ...item };
    },
    flushed: () => saving,
  };
  return api;
}
