// The Ledger desk (phase 4 step 16): the fixture that lets the Books Ranger read the park's
// books. One read-only tool, `ledger.read`, over what already exists: the results engine's
// day rows (revenue, refunds, fees, ad spend, orders, model spend per venture and per
// Ranger, rolled up from the ledgers and the connector syncs; D139) and today's leash ledger
// (what each domain and Ranger spent and did, judge and hosted calls). Nothing is computed
// here that the engine does not compute, and a figure no source holds reads null with its
// name under `noData`, never an estimate (D140).
//
//   createLedgerDesk({ results, ledger, getLayout, clock }) -> { tools, read(input) }

import { economics, emptyRow } from './results.js';

export const LEDGER_DESK_TOOL_NAMES = Object.freeze(['ledger.read']);
export const LEDGER_READ_DEFAULT_DAYS = 30;
export const LEDGER_READ_MAX_DAYS = 90;
export const LEDGER_SCOPES = Object.freeze(['park', 'venture', 'agent']);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const dayFields = ['revenue', 'refunds', 'fees', 'adSpend', 'orders', 'modelSpend', 'modelSpendByTier', 'unpricedTurns', 'hostedCalls', 'mailIn', 'mailOut', 'itemsDone', 'itemsFailed', 'gateApproved', 'gateRejected', 'currencies', 'notes'];

export function createLedgerDesk({ results, ledger, getLayout, clock = { now: () => Date.now() } }) {
  function read({ scope = 'park', venture = null, agentId = null, days = LEDGER_READ_DEFAULT_DAYS, detail = 'summary' } = {}) {
    if (!LEDGER_SCOPES.includes(scope)) throw fail('BAD_SCOPE', `scope must be one of ${LEDGER_SCOPES.join(', ')}`);
    const n = Math.max(1, Math.min(LEDGER_READ_MAX_DAYS, Math.floor(Number(days) || LEDGER_READ_DEFAULT_DAYS)));
    const full = results.full();
    const rows = full.days.slice(-n);
    let pick;
    const about = {};
    if (scope === 'venture') {
      const v = full.ventures.find((x) => x.id === venture);
      if (!v) throw fail('UNKNOWN_VENTURE', `no venture "${venture}" in the plan; known: ${full.ventures.map((x) => x.id).join(', ') || 'none'}`);
      pick = (d) => d.ventures[v.id] || emptyRow();
      about.venture = { id: v.id, name: v.name, budgetUsd: v.budgetUsd ?? null, spentUsd: v.spentUsd ?? null, crew: v.crew || [] };
      about.proposal = v.proposal ? { verdict: v.proposal.verdict, because: v.proposal.because } : null;
    } else if (scope === 'agent') {
      const a = getLayout().agents.find((x) => x.id === agentId);
      if (!a) throw fail('UNKNOWN_AGENT', `no Ranger "${agentId}"`);
      pick = (d) => d.agents[a.id] || emptyRow();
      about.agent = { id: a.id, name: a.name, specialty: a.specialty || null, venture: a.venture || null };
    } else {
      pick = (d) => d.park;
    }
    const series = rows.map((d) => ({ day: d.day, ...pick(d) }));
    const econ = economics(series);
    const today = ledger.summary();
    const out = {
      asOf: new Date(clock.now()).toISOString(),
      lastRollup: full.lastRollup || null,
      scope,
      ...about,
      days: series.length,
      window: { from: series.length ? series[0].day : null, to: series.length ? series[series.length - 1].day : null },
      economics: econ,
      // The components no source holds: they read null above and are named here so the
      // Books Ranger writes "no data", never 0 and never an estimate.
      noData: econ.unknown,
      sources: full.sources,
      today: {
        day: today.day,
        domains: today.domains,
        agents: scope === 'agent' ? { [agentId]: today.agents[agentId] || {} } : today.agents,
        judge: today.judge,
        hosted: today.hosted,
      },
    };
    if (detail === 'days') out.series = series.map((r) => Object.fromEntries([['day', r.day], ...dayFields.map((k) => [k, r[k]])]));
    return out;
  }

  const tool = {
    name: 'ledger.read',
    description: "Read the park's books from recorded data only: the results engine's day rows (revenue, refunds, fees, ad spend, orders, model spend) for the park, one venture or one Ranger over the last N days with their unit economics, which connectors are synced, and today's leash ledger (spend and actions per domain and per Ranger, judge and hosted calls). A figure no connector holds is null and named under noData: write it as \"no data\", never 0, never an estimate. detail: 'days' adds the day rows.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: [...LEDGER_SCOPES] },
        venture: { type: 'string', minLength: 1, maxLength: 120 },
        agentId: { type: 'string', minLength: 1, maxLength: 120 },
        days: { type: 'integer', minimum: 1, maximum: LEDGER_READ_MAX_DAYS },
        detail: { type: 'string', enum: ['summary', 'days'] },
      },
    },
    confirm: false,
    summarize: (input) => `read the books (${input.scope || 'park'}${input.venture ? ` ${input.venture}` : ''}${input.agentId ? ` ${input.agentId}` : ''}, ${input.days || LEDGER_READ_DEFAULT_DAYS} days)`,
    async run(input) {
      try {
        return { ok: true, output: JSON.stringify(read(input || {})) };
      } catch (err) {
        return { ok: false, code: err.code || 'LEDGER_READ', error: err.message };
      }
    },
  };

  return { tools: Object.freeze({ 'ledger.read': tool }), read };
}
