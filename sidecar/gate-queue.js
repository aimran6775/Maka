// The Entrance Gate queue (phase 2 step 1): every leash decision that needs the
// Superintendent, plus the log of what the leash let through or refused.
//
//   createGateQueue({ bus, store, ledger, leashState, clock, timeoutMs, maxItems })
//     -> { init(), submit(item), log(item), resolve(itemId, { decision, notes }),
//          expireRun(runId), pending(), recent(n), get(itemId), items() }
//
// submit(item) emits gate.item { status: 'pending' } and agent.waiting, then returns a
// promise that settles with the Superintendent's decision ({ decision, notes }). The
// capability gate awaits it with the tool call parked, so a waiting run costs nothing.
// There is no timeout by default (docs/DECISIONS.md D37): a Ranger can wait at the Gate
// for hours while the owner is away. The run ending (cancel, error) expires its items.
//
// A decision on an action item feeds the ledger's approval streak; when the streak earns
// a loosening, the queue raises a kind 'proposal' item (not tied to a run). Approving a
// proposal writes the new level into the agent's leash override through leashState. In
// the money domains no proposal goes past Act with cap (safety M2).
//
// Items are persisted (gate-items.json, newest last, capped) so the Peak and the Gate card
// can show history after a restart; pending items with no live resolver become 'expired'.

import { makeEvent, GATE_ITEM_STATUSES } from '../shared/events.js';
import { LEASH_LEVEL_LABELS, nextLooser, withAgentLeash, resolveLeash, MONEY_DOMAINS } from '../shared/leash.js';
import { agentOf } from '../shared/world.js';

export const DECISIONS = Object.freeze(['approve', 'revise', 'reject']);
const DECISION_STATUS = { approve: 'approved', revise: 'revised', reject: 'rejected' };

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

const PAYLOAD_KEYS = ['itemId', 'agentId', 'kind', 'domain', 'tool', 'summary', 'status', 'runId', 'callId', 'turn', 'level', 'amountUsd', 'evidence', 'notes', 'reason', 'proposal', 'away'];

export function createGateQueue({ bus, store, ledger, leashState, getLayout = () => null, clock = { now: () => Date.now() }, timeoutMs = null, maxItems = 500, ids = null, isAway = () => false } = {}) {
  if (!bus || !store) throw new TypeError('createGateQueue needs bus and store');
  let items = []; // oldest first
  const resolvers = new Map(); // itemId -> { resolve, timer }
  let saving = Promise.resolve();
  let n = 0;
  const nextId = () => (ids ? ids.next() : `gate-${clock.now().toString(36)}-${(++n).toString(36)}`);

  const save = () => {
    saving = saving.then(() => store.saveGateItems({ version: 1, items })).catch((err) => console.error('gate queue save failed:', err));
    return saving;
  };
  const emit = (item) => {
    const payload = {};
    for (const k of PAYLOAD_KEYS) if (item[k] !== undefined && item[k] !== null) payload[k] = item[k];
    if (isAway() && item.kind === 'action') payload.away = true;
    bus.emit(makeEvent('gate.item', payload, { ts: clock.now() }));
  };
  const push = (item) => {
    items.push(item);
    if (items.length > maxItems) items = items.filter((it) => it.status === 'pending').concat(items.filter((it) => it.status !== 'pending').slice(-maxItems));
  };
  const find = (itemId) => items.find((it) => it.itemId === itemId) || null;

  function settle(item, status, extra = {}) {
    item.status = status;
    item.decidedAt = clock.now();
    Object.assign(item, extra);
    emit(item);
    const r = resolvers.get(item.itemId);
    if (r) {
      resolvers.delete(item.itemId);
      if (r.timer) clearTimeout(r.timer);
      r.resolve({ decision: status === 'approved' ? 'approve' : status === 'revised' ? 'revise' : 'reject', notes: item.notes || '', status });
    }
  }

  async function maybePropose(item) {
    if (!ledger || item.kind !== 'action') return null;
    const decision = item.status === 'approved' ? 'approve' : 'reject';
    const { propose } = await ledger.recordDecision({ agentId: item.agentId, domain: item.domain, decision });
    if (!propose) return null;
    const layout = getLayout();
    const agent = layout ? agentOf(layout, item.agentId) : null;
    const current = resolveLeash(leashState ? leashState.get() : null, { agentId: item.agentId, roomId: agent ? agent.roomId : undefined }, item.domain);
    const to = nextLooser(current.level);
    if (!to) return null;
    // Safety M2: money never loosens to Act freely by streak; Act with cap is the ceiling
    // a Ranger can earn there, and the hard cap stays the Superintendent's to raise.
    if (MONEY_DOMAINS.includes(item.domain) && to === 'act_free') return null;
    if (items.some((it) => it.kind === 'proposal' && it.status === 'pending' && it.agentId === item.agentId && it.domain === item.domain)) return null;
    const proposal = {
      itemId: nextId(),
      agentId: item.agentId,
      kind: 'proposal',
      domain: item.domain,
      tool: 'leash.loosen',
      summary: `${ledger.earnApprovals} approvals in a row in ${item.domain}: loosen ${item.agentId} from ${LEASH_LEVEL_LABELS[current.level]} to ${LEASH_LEVEL_LABELS[to]}?`,
      status: 'pending',
      level: current.level,
      proposal: { from: current.level, to },
      evidence: [{ kind: 'streak', text: `${ledger.earnApprovals} consecutive Gate approvals for ${item.agentId} in ${item.domain}` }],
      createdAt: clock.now(),
      decidedAt: null,
      caps: { dailyCapUsd: current.dailyCapUsd, dailyCapActions: current.dailyCapActions },
    };
    push(proposal);
    emit(proposal);
    await save();
    return proposal;
  }

  return {
    async init() {
      const loaded = await store.loadGateItems(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.items)) items = loaded.items;
      let changed = false;
      for (const it of items) {
        if (it.status === 'pending' && it.kind === 'action') {
          it.status = 'expired';
          it.reason = 'sidecar restarted before a decision';
          it.decidedAt = clock.now();
          changed = true;
        }
      }
      if (changed) await save();
      return this;
    },
    items: () => items.slice(),
    pending: () => items.filter((it) => it.status === 'pending'),
    recent: (count = 20) => items.filter((it) => it.status !== 'pending').slice(-count).reverse(),
    get: find,
    // Records a decision the leash made on its own (allowed / refused); no waiting.
    async log(item) {
      if (!['allowed', 'refused'].includes(item.status)) throw new Error(`log() takes allowed or refused, got ${item.status}`);
      const rec = { ...item, itemId: item.itemId || nextId(), kind: item.kind || 'action', createdAt: clock.now(), decidedAt: clock.now() };
      push(rec);
      emit(rec);
      await save();
      return rec;
    },
    // Parks an action until the Superintendent decides. Resolves with { decision, notes }.
    submit(item) {
      // D182: the kind the caller asked for, defaulting to 'action' as every caller before
      // the portfolio wanted. A 'venture' item is a business waiting for the owner's word:
      // no run parks on it, and `maybePropose` ignores anything that is not an action, so
      // approving a business does not feed the leash approval streak.
      const rec = { ...item, itemId: item.itemId || nextId(), kind: item.kind || 'action', status: 'pending', createdAt: clock.now(), decidedAt: null };
      push(rec);
      return new Promise((resolve) => {
        const timer = timeoutMs ? setTimeout(() => { if (resolvers.has(rec.itemId)) settle(rec, 'expired', { reason: `no decision within ${timeoutMs} ms` }); save(); }, timeoutMs) : null;
        resolvers.set(rec.itemId, { resolve, timer });
        emit(rec);
        if (rec.runId) bus.emit(makeEvent('agent.waiting', { runId: rec.runId, agentId: rec.agentId, itemId: rec.itemId, domain: rec.domain, tool: rec.tool }, { ts: clock.now() }));
        save();
      });
    },
    async resolve(itemId, { decision, notes = '' } = {}) {
      if (!DECISIONS.includes(decision)) throw fail('BAD_REQUEST', `decision must be one of ${DECISIONS.join(', ')}`, 400);
      if (typeof notes !== 'string') throw fail('BAD_REQUEST', 'notes must be a string', 400);
      const item = find(itemId);
      if (!item) throw fail('NOT_FOUND', `no Gate item "${itemId}"`, 404);
      if (item.status !== 'pending') throw fail('ALREADY_DECIDED', `Gate item ${itemId} is already ${item.status}`, 409);
      if (item.kind === 'proposal') {
        if (decision === 'revise') throw fail('BAD_REQUEST', 'a proposal is approved or rejected, not revised', 400);
        if (decision === 'approve') {
          if (!leashState) throw fail('NO_LEASH_STATE', 'no leash state to apply the proposal to', 500);
          const entry = { level: item.proposal.to };
          if (item.caps && typeof item.caps.dailyCapUsd === 'number') entry.dailyCapUsd = item.caps.dailyCapUsd;
          if (item.caps && typeof item.caps.dailyCapActions === 'number') entry.dailyCapActions = item.caps.dailyCapActions;
          await leashState.update((leash) => withAgentLeash(leash, item.agentId, item.domain, entry));
        } else if (ledger) {
          await ledger.recordDecision({ agentId: item.agentId, domain: item.domain, decision: 'reject' });
        }
        settle(item, DECISION_STATUS[decision], { notes });
        await save();
        return { ...item };
      }
      settle(item, DECISION_STATUS[decision], { notes });
      await save();
      await maybePropose(item);
      return { ...item };
    },
    // The run is over: anything of its still waiting is expired (the tool call gets a reject).
    async expireRun(runId, reason = 'the run ended before a decision') {
      let changed = false;
      for (const it of items) {
        if (it.status === 'pending' && it.runId === runId) {
          settle(it, 'expired', { reason });
          changed = true;
        }
      }
      if (changed) await save();
      return changed;
    },
    flushed: () => saving,
  };
}

export { GATE_ITEM_STATUSES };
