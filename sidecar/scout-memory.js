// The Scout's memory (phase 4 step 10).
//
//   createScoutMemory({ store, bus, getResults, clock, log })
//     -> { init(), record(briefRecord), decide({ briefId, decision, ventureId, reason, by }),
//          list(), history({ niche, channel }), promptLines(opts), judgeScope(brief), tools, state() }
//
// Every venture brief a Scout submits is stored here with what it estimated (`niche`,
// `channel`, `estimates`: monthly revenue, orders, ad spend, contribution per order) and
// the judge's verdict; the Chief's go / no-go lands on it through the Chief-only tool
// `brief.decide`. A brief that names a venture (its own `ventureId`, or the one the Chief
// gave it) is joined to that venture's actuals from the results engine (step 9): each
// estimate is scaled to the days observed and scored against the recorded figure
// (precision = 1 − |actual − expected| / max(actual, expected), 0 when nothing was
// recorded for an estimate's figure stays "unknown"), and a `go` is "held" when the
// venture's net is positive after 14 days, "missed" when negative, "too early" before.
// `history()` groups the scored briefs by niche and by channel; `promptLines()` turns it
// into the "what we learned" paragraph injected into a Scout's system prompt and
// `judgeScope()` into the judge's review of the next brief. Nothing is estimated here:
// a figure the results engine does not hold is unknown, and a no-go that was never
// launched has no outcome to score.

import { makeEvent } from '../shared/events.js';
import { validate } from '../shared/schema.js';

export const BRIEF_CHANNELS = Object.freeze(['etsy', 'shopify', 'stripe', 'meta_ads', 'google_ads', 'email', 'organic', 'other']);
export const ESTIMATES = Object.freeze({
  monthlyRevenueUsd: { label: 'revenue', monthly: true, actual: (v) => v.all.revenue },
  ordersPerMonth: { label: 'orders', monthly: true, actual: (v) => v.all.orders },
  monthlyAdSpendUsd: { label: 'ad spend', monthly: true, actual: (v) => v.all.adSpend },
  contributionPerOrderUsd: { label: 'contribution per order', monthly: false, actual: (v) => v.all.contributionPerOrder },
});
export const OUTCOME_MIN_DAYS = 14;
export const DECISIONS = Object.freeze(['go', 'no_go', 'needs_more_evidence']);

const DECIDE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['briefId', 'decision'],
  additionalProperties: false,
  properties: {
    briefId: { type: 'string', minLength: 1, maxLength: 80 },
    decision: { type: 'string', enum: [...DECISIONS] },
    ventureId: { type: 'string', maxLength: 80, description: 'The venture in the plan this brief now belongs to (a go), so its results score the brief' },
    reason: { type: 'string', maxLength: 1000 },
  },
});

const normNiche = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120) : '');
const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(4)) : null);

// Pure: one estimate against one recorded figure over `days` observed days.
export function scoreEstimate(estimate, actual, { days = 30, monthly = true } = {}) {
  if (typeof estimate !== 'number' || !Number.isFinite(estimate)) return null;
  if (actual === null || actual === undefined || typeof actual !== 'number') return { expected: monthly ? round((estimate * days) / 30) : estimate, actual: null, ratio: null, precision: null, unknown: true };
  const expected = monthly ? (estimate * days) / 30 : estimate;
  const denom = Math.max(Math.abs(expected), Math.abs(actual));
  const precision = denom === 0 ? 1 : Math.max(0, 1 - Math.abs(actual - expected) / denom);
  return { expected: round(expected), actual: round(actual), ratio: expected > 0 ? round(actual / expected) : null, precision: round(precision), unknown: false };
}

// Pure: what became of a recommendation, given the joined venture's economics.
export function outcomeOf(recommendation, venture) {
  if (!venture) return recommendation === 'go' ? 'not launched' : 'not launched (no outcome to score)';
  const days = venture.daysObserved || 0;
  const net = venture.all ? venture.all.net : null;
  if (days < OUTCOME_MIN_DAYS) return `too early (${days} of ${OUTCOME_MIN_DAYS} days)`;
  if (net === null || net === undefined) return 'unknown (no revenue data)';
  if (recommendation === 'go') return net > 0 ? 'held' : 'missed';
  return net > 0 ? 'missed (launched anyway and it paid)' : 'held (launched anyway and it did not pay)';
}

export function createScoutMemory({ store, bus, getResults = null, clock = { now: () => Date.now() }, log = console } = {}) {
  if (!store || !bus) throw new TypeError('createScoutMemory needs store and bus');
  let data = { version: 1, briefs: {} };
  let saving = Promise.resolve();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const save = () => {
    saving = saving.then(() => store.saveScoutMemory(data)).catch((err) => log.error('scout memory save failed:', err));
    return saving;
  };

  function entryOf(rec) {
    const b = rec.brief || {};
    return {
      id: rec.id,
      agentId: rec.agentId || null,
      runId: rec.runId || null,
      submittedAt: rec.submittedAt || clock.now(),
      title: b.title || '',
      ventureId: b.ventureId || null,
      niche: normNiche(b.niche),
      channel: BRIEF_CHANNELS.includes(b.channel) ? b.channel : 'other',
      recommendation: b.recommendation,
      confidence: typeof b.confidence === 'number' ? b.confidence : null,
      estimates: Object.fromEntries(Object.keys(ESTIMATES).filter((k) => b.estimates && typeof b.estimates[k] === 'number').map((k) => [k, b.estimates[k]])),
      totals: rec.totals || null,
      judge: rec.judge ? { verdict: rec.judge.verdict, notes: rec.judge.notes || null, reason: rec.judge.reason || null } : null,
      decision: null,
    };
  }

  // The venture a brief is joined to: the Chief's decision names one, else the brief's own.
  const ventureOf = (e) => (e.decision && e.decision.ventureId) || e.ventureId || null;

  function ventures() {
    const results = typeof getResults === 'function' ? getResults() : null;
    if (!results) return new Map();
    try {
      return new Map(results.compute().ventures.map((v) => [v.id, { ...v, daysObserved: v.proposal && v.proposal.numbers ? v.proposal.numbers.daysObserved : 0 }]));
    } catch (err) {
      log.error('scout memory could not read the results:', err);
      return new Map();
    }
  }

  function scored(e, vmap) {
    const vid = ventureOf(e);
    const v = vid ? vmap.get(vid) || null : null;
    const scores = {};
    for (const [k, spec] of Object.entries(ESTIMATES)) {
      if (typeof e.estimates[k] !== 'number') continue;
      scores[k] = v ? scoreEstimate(e.estimates[k], spec.actual(v), { days: v.daysObserved, monthly: spec.monthly }) : { expected: null, actual: null, ratio: null, precision: null, unknown: true };
    }
    return { ...e, joined: Boolean(v), ventureId: vid, daysObserved: v ? v.daysObserved : 0, actuals: v ? { revenue: v.all.revenue, orders: v.all.orders, adSpend: v.all.adSpend, modelSpend: v.all.modelSpend, net: v.all.net, contributionPerOrder: v.all.contributionPerOrder } : null, scores, outcome: outcomeOf(e.recommendation, v) };
  }

  function list() {
    const vmap = ventures();
    return Object.values(data.briefs).sort((a, b) => b.submittedAt - a.submittedAt).map((e) => scored(e, vmap));
  }

  function group(rows, key) {
    const by = new Map();
    for (const r of rows) {
      const k = r[key] || (key === 'niche' ? '(no niche given)' : 'other');
      if (!by.has(k)) by.set(k, { [key]: k, briefs: 0, go: 0, noGo: 0, needsMore: 0, joined: 0, held: 0, missed: 0, tooEarly: 0, precision: {}, latest: 0, ids: [] });
      const g = by.get(k);
      g.briefs += 1;
      g.ids.push(r.id);
      g.latest = Math.max(g.latest, r.submittedAt);
      if (r.recommendation === 'go') g.go += 1;
      else if (r.recommendation === 'no_go') g.noGo += 1;
      else g.needsMore += 1;
      if (r.joined) g.joined += 1;
      if (/^held/.test(r.outcome)) g.held += 1;
      else if (/^missed/.test(r.outcome)) g.missed += 1;
      else if (/^too early/.test(r.outcome)) g.tooEarly += 1;
      for (const [est, s] of Object.entries(r.scores)) {
        if (!s || s.unknown) continue;
        const p = g.precision[est] || (g.precision[est] = { n: 0, sum: 0, ratioSum: 0, ratios: 0 });
        p.n += 1;
        p.sum += s.precision;
        if (s.ratio !== null) {
          p.ratios += 1;
          p.ratioSum += s.ratio;
        }
      }
    }
    return [...by.values()].map((g) => ({ ...g, precision: Object.fromEntries(Object.entries(g.precision).map(([est, p]) => [est, { scored: p.n, mean: round(p.sum / p.n), meanRatio: p.ratios ? round(p.ratioSum / p.ratios) : null }])) })).sort((a, b) => b.latest - a.latest);
  }

  function history({ niche = null, channel = null } = {}) {
    const rows = list().filter((r) => (!niche || r.niche === normNiche(niche)) && (!channel || r.channel === channel));
    const totals = { briefs: rows.length, go: rows.filter((r) => r.recommendation === 'go').length, noGo: rows.filter((r) => r.recommendation === 'no_go').length, needsMore: rows.filter((r) => r.recommendation === 'needs_more_evidence').length, joined: rows.filter((r) => r.joined).length, decided: rows.filter((r) => r.decision).length };
    return { totals, byNiche: group(rows, 'niche'), byChannel: group(rows, 'channel'), briefs: rows.slice(0, 50) };
  }

  const groupLine = (g, key) => {
    const parts = [`${g.briefs} brief(s): ${g.go} go, ${g.noGo} no-go, ${g.needsMore} needs more evidence`];
    const est = Object.entries(g.precision);
    if (!g.joined) parts.push('none joined to a venture yet');
    else {
      for (const [k, p] of est) parts.push(`${ESTIMATES[k].label} estimates ${p.meanRatio === null ? '' : p.meanRatio < 1 ? `ran ${(1 / Math.max(p.meanRatio, 0.01)).toFixed(1)}× high` : p.meanRatio > 1 ? `ran ${p.meanRatio.toFixed(1)}× low` : 'were on the mark'} (precision ${p.mean.toFixed(2)} over ${p.scored})`);
      if (!est.length) parts.push(`${g.joined} joined but no checkable estimate was given`);
      if (g.held || g.missed || g.tooEarly) parts.push(`recommendations: ${g.held} held, ${g.missed} missed, ${g.tooEarly} too early`);
    }
    return `- ${key} "${g[key]}": ${parts.join('; ')}`;
  };

  function promptLines({ niche = null, channel = null, limit = 10 } = {}) {
    const h = history();
    if (!h.totals.briefs) return ['What we learned: no venture brief is recorded yet. Your estimates (monthlyRevenueUsd, ordersPerMonth, monthlyAdSpendUsd, contributionPerOrderUsd) will be scored against the venture\'s recorded results, so give figures you can defend and name the niche and channel.'];
    const lines = [`What we learned from ${h.totals.briefs} venture brief(s) so far (${h.totals.go} go, ${h.totals.noGo} no-go, ${h.totals.needsMore} needs more evidence; ${h.totals.joined} joined to a venture's recorded results):`];
    const pick = (rows, key, want) => [...rows.filter((g) => want && g[key] === want), ...rows.filter((g) => !want || g[key] !== want)];
    for (const g of pick(h.byNiche, 'niche', niche ? normNiche(niche) : null).slice(0, Math.ceil(limit / 2))) lines.push(groupLine(g, 'niche'));
    for (const g of pick(h.byChannel, 'channel', channel).slice(0, Math.floor(limit / 2))) lines.push(groupLine(g, 'channel'));
    lines.push('Give estimates you can check (monthlyRevenueUsd, ordersPerMonth, monthlyAdSpendUsd, contributionPerOrderUsd) and name the niche and channel; where past estimates ran high, bring more evidence or lower them.');
    return lines;
  }

  function judgeScope(brief) {
    const base = 'SCOPE: the worker submitted a venture brief through brief.submit. Review it: is every claim backed by the evidence given (sources with URLs), are the costs real figures with a basis, is the go / no-go consistent with the evidence? Approve, or revise with what is missing, or reject.';
    const lines = promptLines({ niche: brief && brief.niche, channel: brief && brief.channel, limit: 6 });
    return `${base}\n${lines.join('\n')}\nWeigh the recommendation against this record: where estimates in this niche or channel ran high before, demand evidence for these figures; where none were given, ask for checkable estimates.`;
  }

  const tools = Object.freeze({
    'brief.decide': {
      name: 'brief.decide',
      description: "Record your go / no-go on a Scout's venture brief (briefId from its file name under outbox/briefs/). A go names the venture in the plan the brief now belongs to, so its recorded results score the Scout's estimates later. No money moves here.",
      inputSchema: DECIDE_SCHEMA,
      confirm: false,
      summarize: (input) => `decide ${input.decision.replace(/_/g, ' ')} on brief ${input.briefId}`,
      async run(input, ctx) {
        try {
          const e = await decide({ ...input, by: ctx.agentId || 'chief-ranger' });
          return { ok: true, output: JSON.stringify({ briefId: e.id, decision: e.decision.decision, ventureId: e.decision.ventureId, recordedAt: e.decision.at }) };
        } catch (err) {
          return { ok: false, code: err.code || 'DECIDE_FAILED', error: err.message };
        }
      },
    },
  });

  async function decide({ briefId, decision, ventureId = null, reason = '', by = 'chief-ranger' } = {}) {
    const v = validate(DECIDE_SCHEMA, { briefId, decision, ...(ventureId ? { ventureId } : {}), ...(reason ? { reason } : {}) });
    if (!v.ok) {
      const err = new Error(`bad decision: ${v.errors.slice(0, 2).join('; ')}`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const e = data.briefs[briefId];
    if (!e) {
      const err = new Error(`no brief ${briefId} is recorded (brief.submit records them; the id is the file name under outbox/briefs/)`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    e.decision = { decision, ventureId: ventureId || e.ventureId || null, reason: String(reason || '').slice(0, 1000), by, at: clock.now() };
    await save();
    emit('scout.brief', { briefId, change: 'decided', agentId: e.agentId || '', title: e.title, recommendation: e.recommendation, decision, ventureId: e.decision.ventureId || '', niche: e.niche, channel: e.channel, by });
    return e;
  }

  return {
    tools,
    async init() {
      const loaded = await store.loadScoutMemory(null);
      if (loaded && loaded.version === 1 && loaded.briefs) data = loaded;
      return this;
    },
    // Called by brief.submit with the record it wrote to the outbox.
    async record(rec) {
      if (!rec || !rec.id || !rec.brief) throw new TypeError('record needs a brief record');
      const e = entryOf(rec);
      if (data.briefs[e.id]) e.decision = data.briefs[e.id].decision;
      data.briefs[e.id] = e;
      await save();
      emit('scout.brief', { briefId: e.id, change: 'recorded', agentId: e.agentId || '', title: e.title, recommendation: e.recommendation, ventureId: e.ventureId || '', niche: e.niche, channel: e.channel, estimates: Object.keys(e.estimates).length });
      return e;
    },
    decide,
    list,
    history,
    promptLines,
    judgeScope,
    summary: () => {
      const h = history();
      return { totals: h.totals, byNiche: h.byNiche.slice(0, 10).map(({ ids, ...g }) => g), byChannel: h.byChannel.slice(0, 10).map(({ ids, ...g }) => g), recent: h.briefs.slice(0, 10).map((b) => ({ id: b.id, title: b.title, niche: b.niche, channel: b.channel, recommendation: b.recommendation, decision: b.decision ? b.decision.decision : null, ventureId: b.ventureId, joined: b.joined, outcome: b.outcome })) };
    },
    state: () => data,
    flushed: () => saving,
  };
}
