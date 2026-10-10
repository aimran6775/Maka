// Leash ledger and leash state (phase 2 step 1).
//
// createLeashLedger({ store, clock, earnApprovals })
//   -> { init(), dayKey(), spentToday(domain), checkCap(...), recordAction(...),
//        recordDecision(...), recordJudge(...), judgeToday(), summary(), state() }
//
// The ledger is the sidecar's memory for "what did the leash let through today" and
// "how many approvals in a row has this Ranger earned". It holds, persisted atomically:
//   days[YYYY-MM-DD].domains[domain] = { usd, actions }   executed actions per domain per day
//   days[YYYY-MM-DD].judge           = { usd, calls }     judge-tier spend per day (step 2)
//   days[YYYY-MM-DD].hosted          = { calls, tokens }  hosted worker calls per day (step 12b)
//   streaks[agentId][domain]         = { approvals }      Gate approvals since the last
//                                                         rejection or proposal
// Days are the sidecar machine's local calendar day (docs/DECISIONS.md D36).
//
// createLeashState({ initial, store }) -> { get(), set(next), update(fn) }
//   The live leash policy. set() validates and persists to leash.json (the same file the
//   operator may edit by hand) so an approved loosening proposal survives a restart.

import { validateLeash, DEFAULT_EARN_APPROVALS, DOMAINS } from '../shared/leash.js';

function emptyLedger() {
  return { version: 1, days: {}, streaks: {} };
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

  return {
    async init() {
      const loaded = await store.loadLeashLedger(null);
      if (loaded && loaded.version === 1 && loaded.days && loaded.streaks) data = loaded;
      return this;
    },
    dayKey: () => localDayKey(clock.now()),
    earnApprovals,
    spentToday(domain) {
      const d = data.days[localDayKey(clock.now())];
      const row = d && d.domains[domain];
      return row ? { usd: row.usd, actions: row.actions } : { usd: 0, actions: 0 };
    },
    // Would an action of `amountUsd` in `domain` stay under the day's caps? A null cap is
    // no cap. The money cap counts the action itself (0 + amount <= cap), so a 0 USD cap
    // sends every priced action to the Gate and lets free ones through.
    checkCap({ domain, amountUsd = 0, dailyCapUsd = null, dailyCapActions = null }) {
      const t = this.spentToday(domain);
      if (typeof dailyCapUsd === 'number' && t.usd + amountUsd > dailyCapUsd) {
        return { ok: false, reason: `daily cap for ${domain} is $${dailyCapUsd}; $${t.usd.toFixed(2)} used today, this action is $${amountUsd.toFixed(2)}` };
      }
      if (typeof dailyCapActions === 'number' && t.actions + 1 > dailyCapActions) {
        return { ok: false, reason: `daily cap for ${domain} is ${dailyCapActions} action(s); ${t.actions} used today` };
      }
      return { ok: true, reason: null };
    },
    // An action in a leash domain was executed (not merely allowed): count it.
    async recordAction({ domain, amountUsd = 0 }) {
      if (!DOMAINS.includes(domain)) throw new Error(`unknown domain "${domain}"`);
      const row = domainRow(domain);
      row.usd += amountUsd;
      row.actions += 1;
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
      return { day: key, domains: JSON.parse(JSON.stringify(d.domains)), judge: { ...d.judge }, hosted: { ...(d.hosted || { calls: 0, tokens: 0 }) }, streaks: JSON.parse(JSON.stringify(data.streaks)), earnApprovals };
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
