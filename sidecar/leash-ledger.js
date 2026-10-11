// Leash ledger and leash state (phase 2 step 1).
//
// createLeashLedger({ store, clock, earnApprovals })
//   -> { init(), dayKey(), spentToday(domain), reservedToday(domain), checkCap(...),
//        reserve(...), recordAction(...), recordDecision(...), recordJudge(...),
//        judgeToday(), summary(), state() }
//
// Safety M1: a capped action is reserved before it runs (reserve → execute → commit or
// release), in one synchronous step, so concurrent runs cannot all pass the same cap
// between a check and a record. Reservations live in memory only: a crash releases
// what was in flight, and nothing is written to the day until an action succeeds.
//
// The ledger is the sidecar's memory for "what did the leash let through today" and
// "how many approvals in a row has this Ranger earned". It holds, persisted atomically:
//   days[YYYY-MM-DD].domains[domain] = { usd, actions }   executed actions per domain per day
//   days[YYYY-MM-DD].agents[agentId][domain] = { usd, actions }  the same, per agent (M2:
//                                             an agent-scoped cap is checked against these)
//   days[YYYY-MM-DD].judge           = { usd, calls }     judge-tier spend per day (step 2)
//   days[YYYY-MM-DD].hosted          = { calls, tokens }  hosted worker calls per day (step 12b)
//   streaks[agentId][domain]         = { approvals }      Gate approvals since the last
//                                                         rejection or proposal
//   holds[id]                        = { domain, amountUsd, agentId, since, note }  phase 4
//                                      step 17: a reservation that outlives its action (a
//                                      purchase waiting for the Superintendent's payment);
//                                      counted as reserved in its domain until settled
//                                      (spend at the paid amount, on that day) or released
// Days are the sidecar machine's local calendar day (docs/DECISIONS.md D36).
//
// createLeashState({ initial, store }) -> { get(), set(next), update(fn) }
//   The live leash policy. set() validates and persists to leash.json (the same file the
//   operator may edit by hand) so an approved loosening proposal survives a restart.

import { validateLeash, DEFAULT_EARN_APPROVALS, DOMAINS } from '../shared/leash.js';

function emptyLedger() {
  return { version: 1, days: {}, streaks: {}, holds: {} };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createLeashLedger({ store, clock = { now: () => Date.now() }, earnApprovals = DEFAULT_EARN_APPROVALS, keepDays = 400 } = {}) {
  if (!store) throw new TypeError('createLeashLedger needs store');
  let data = emptyLedger();
  let saving = Promise.resolve();
  const reserved = new Map(); // domain -> { usd, actions } in flight today (dayKey tracked per entry)
  let reservedDay = null;
  const reservedRow = (domain, agentId = null) => {
    const key = localDayKey(clock.now());
    if (reservedDay !== key) {
      reserved.clear();
      reservedDay = key;
    }
    const k = reserveKey(domain, agentId);
    if (!reserved.has(k)) reserved.set(k, { usd: 0, actions: 0 });
    return reserved.get(k);
  };

  const save = () => {
    saving = saving.then(() => store.saveLeashLedger(data)).catch((err) => console.error('leash ledger save failed:', err));
    return saving;
  };
  const day = () => {
    const key = localDayKey(clock.now());
    if (!data.days[key]) {
      data.days[key] = { domains: {}, judge: { usd: 0, calls: 0 }, hosted: { calls: 0, tokens: 0 } };
      const keys = Object.keys(data.days).sort();
      while (keys.length > keepDays) delete data.days[keys.shift()];
    }
    return data.days[key];
  };
  const domainRow = (domain) => {
    const d = day();
    if (!d.domains[domain]) d.domains[domain] = { usd: 0, actions: 0 };
    return d.domains[domain];
  };
  const agentRow = (agentId, domain) => {
    const d = day();
    if (!d.agents) d.agents = {};
    if (!d.agents[agentId]) d.agents[agentId] = {};
    if (!d.agents[agentId][domain]) d.agents[agentId][domain] = { usd: 0, actions: 0 };
    return d.agents[agentId][domain];
  };
  // Reservation rows are keyed by domain, and by domain@agent for the agent's own view.
  const reserveKey = (domain, agentId) => (agentId ? `${domain}@${agentId}` : domain);

  return {
    async init() {
      const loaded = await store.loadLeashLedger(null);
      if (loaded && loaded.version === 1 && loaded.days && loaded.streaks) data = loaded;
      if (!data.holds) data.holds = {};
      return this;
    },
    dayKey: () => localDayKey(clock.now()),
    earnApprovals,
    // Executed money and actions today in `domain`: the park's total, or one agent's own
    // with { agentId } (safety M2).
    spentToday(domain, { agentId = null } = {}) {
      const d = data.days[localDayKey(clock.now())];
      const row = agentId ? d && d.agents && d.agents[agentId] && d.agents[agentId][domain] : d && d.domains[domain];
      return row ? { usd: row.usd, actions: row.actions } : { usd: 0, actions: 0 };
    },
    // Money and actions reserved by actions still running today (safety M1), park-wide or
    // one agent's with { agentId }.
    reservedToday(domain, { agentId = null } = {}) {
      const r = reservedRow(domain, agentId);
      const held = Object.values(data.holds).filter((h) => h.domain === domain && (!agentId || h.agentId === agentId));
      return { usd: r.usd + held.reduce((n, h) => n + h.amountUsd, 0), actions: r.actions + held.length };
    },
    // Phase 4 step 17: a hold is a reservation that outlives the action that made it. It
    // counts as reserved (money and one action) in its domain, park-wide and under its
    // agent, across restarts and days, until it is settled or released.
    async hold({ id, domain, amountUsd, agentId = null, note = '' }) {
      if (!DOMAINS.includes(domain)) throw new Error(`unknown domain "${domain}"`);
      if (typeof id !== 'string' || !id) throw new Error('a hold needs an id');
      if (!(typeof amountUsd === 'number' && Number.isFinite(amountUsd) && amountUsd >= 0)) throw new Error('a hold needs a finite amount');
      if (data.holds[id]) throw new Error(`hold "${id}" exists`);
      data.holds[id] = { domain, amountUsd, agentId, since: clock.now(), note };
      await save();
      return { id, ...data.holds[id] };
    },
    holds: () => Object.entries(data.holds).map(([id, h]) => ({ id, ...h })),
    // The hold becomes spend at the amount actually paid, on the day it is settled.
    async settleHold(id, { amountUsd }) {
      const h = data.holds[id];
      if (!h) throw new Error(`no hold "${id}"`);
      if (!(typeof amountUsd === 'number' && Number.isFinite(amountUsd) && amountUsd >= 0)) throw new Error('settling a hold needs the paid amount');
      delete data.holds[id];
      return this.recordAction({ domain: h.domain, amountUsd, agentId: h.agentId });
    },
    async releaseHold(id) {
      if (!data.holds[id]) return false;
      delete data.holds[id];
      await save();
      return true;
    },
    // Would an action of `amountUsd` in `domain` stay under the day's caps? A null cap is
    // no cap. The money cap counts the action itself (0 + amount <= cap), so a 0 USD cap
    // sends every priced action to the Gate and lets free ones through. What other
    // actions have reserved and not yet committed counts as spent. With `scope: 'agent'`
    // (the cap came from the agent's own leash entry) the agent's own rows are compared;
    // a zone or park cap is compared with the park-wide rows (M2).
    checkCap({ domain, amountUsd = 0, dailyCapUsd = null, dailyCapActions = null, agentId = null, scope = 'park' }) {
      const own = scope === 'agent' && agentId ? { agentId } : {};
      const who = own.agentId ? ` for ${own.agentId}` : '';
      const t = this.spentToday(domain, own);
      const r = this.reservedToday(domain, own);
      if (typeof dailyCapUsd === 'number' && t.usd + r.usd + amountUsd > dailyCapUsd) {
        return { ok: false, reason: `daily cap for ${domain}${who} is $${dailyCapUsd}; $${t.usd.toFixed(2)} used today${r.usd ? ` and $${r.usd.toFixed(2)} reserved by actions in flight` : ''}, this action is $${amountUsd.toFixed(2)}` };
      }
      if (typeof dailyCapActions === 'number' && t.actions + r.actions + 1 > dailyCapActions) {
        return { ok: false, reason: `daily cap for ${domain}${who} is ${dailyCapActions} action(s); ${t.actions} used today${r.actions ? ` and ${r.actions} reserved by actions in flight` : ''}` };
      }
      return { ok: true, reason: null };
    },
    // Checks the caps and, when they hold, reserves the amount and the action in the same
    // synchronous step. Returns { ok, reason, commit(), release() }: commit() records the
    // action (the reservation becomes spend), release() drops it (the action failed or
    // never ran). Either is final; the other is then a no-op. The reservation is held in
    // the park-wide row and, with an agentId, in the agent's row too.
    reserve({ domain, amountUsd = 0, dailyCapUsd = null, dailyCapActions = null, agentId = null, scope = 'park' }) {
      if (!DOMAINS.includes(domain)) throw new Error(`unknown domain "${domain}"`);
      const cap = this.checkCap({ domain, amountUsd, dailyCapUsd, dailyCapActions, agentId, scope });
      if (!cap.ok) return { ok: false, reason: cap.reason, commit: async () => null, release: () => false };
      const rows = [reservedRow(domain)];
      if (agentId) rows.push(reservedRow(domain, agentId));
      const day = reservedDay;
      for (const row of rows) {
        row.usd += amountUsd;
        row.actions += 1;
      }
      let settled = false;
      const drop = () => {
        if (settled) return false;
        settled = true;
        if (reservedDay !== day) return true;
        for (const k of [reserveKey(domain, null), ...(agentId ? [reserveKey(domain, agentId)] : [])]) {
          const r = reserved.get(k);
          if (!r) continue;
          r.usd = Math.max(0, r.usd - amountUsd);
          r.actions = Math.max(0, r.actions - 1);
        }
        return true;
      };
      return {
        ok: true,
        reason: null,
        commit: async () => {
          if (!drop()) return null;
          return this.recordAction({ domain, amountUsd, agentId });
        },
        release: drop,
      };
    },
    // An action in a leash domain was executed (not merely allowed): count it, park-wide
    // and under the agent that did it.
    async recordAction({ domain, amountUsd = 0, agentId = null }) {
      if (!DOMAINS.includes(domain)) throw new Error(`unknown domain "${domain}"`);
      const row = domainRow(domain);
      row.usd += amountUsd;
      row.actions += 1;
      if (agentId) {
        const mine = agentRow(agentId, domain);
        mine.usd += amountUsd;
        mine.actions += 1;
      }
      await save();
      return { usd: row.usd, actions: row.actions };
    },
    // A Gate decision on an action item. Approvals in a row earn a loosening proposal once
    // they reach `earnApprovals`; a revise or reject resets the streak. Returns
    // { approvals, propose } where propose is true exactly when the streak just reached N.
    async recordDecision({ agentId, domain, decision }) {
      const agent = data.streaks[agentId] || (data.streaks[agentId] = {});
      const s = agent[domain] || (agent[domain] = { approvals: 0 });
      let propose = false;
      if (decision === 'approve') {
        s.approvals += 1;
        if (s.approvals >= earnApprovals) {
          propose = true;
          s.approvals = 0;
        }
      } else {
        s.approvals = 0;
      }
      await save();
      return { approvals: s.approvals, propose };
    },
    streak(agentId, domain) {
      const s = data.streaks[agentId] && data.streaks[agentId][domain];
      return s ? s.approvals : 0;
    },
    async recordJudge({ usd = 0 } = {}) {
      const d = day();
      d.judge.usd += usd;
      d.judge.calls += 1;
      await save();
      return { ...d.judge };
    },
    judgeToday() {
      const d = data.days[localDayKey(clock.now())];
      return d ? { ...d.judge } : { usd: 0, calls: 0 };
    },
    async recordHosted({ tokens = 0 } = {}) {
      const d = day();
      if (!d.hosted) d.hosted = { calls: 0, tokens: 0 };
      d.hosted.calls += 1;
      d.hosted.tokens += tokens;
      await save();
      return { ...d.hosted };
    },
    hostedToday() {
      const d = data.days[localDayKey(clock.now())];
      return d && d.hosted ? { ...d.hosted } : { calls: 0, tokens: 0 };
    },
    summary() {
      const key = localDayKey(clock.now());
      const d = data.days[key] || { domains: {}, judge: { usd: 0, calls: 0 } };
      return { day: key, domains: JSON.parse(JSON.stringify(d.domains)), agents: JSON.parse(JSON.stringify(d.agents || {})), judge: { ...d.judge }, hosted: { ...(d.hosted || { calls: 0, tokens: 0 }) }, streaks: JSON.parse(JSON.stringify(data.streaks)), earnApprovals, holds: Object.entries(data.holds).map(([id, h]) => ({ id, ...h })) };
    },
    state: () => data,
    flushed: () => saving,
  };
}

export function createLeashState({ initial, store }) {
  let leash = initial;
  let saving = Promise.resolve();
  return {
    get: () => leash,
    async set(next) {
      const r = validateLeash(next);
      if (!r.ok) {
        const err = new Error(`leash invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
        err.code = 'LEASH_INVALID';
        throw err;
      }
      leash = next;
      if (store) {
        saving = saving.then(() => store.saveLeash(leash));
        await saving;
      }
      return leash;
    },
    update(fn) {
      return this.set(fn(leash));
    },
  };
}
