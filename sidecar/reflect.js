// The Mountain Peak's reflection cycle (phase 2 step 6).
//
//   createReflect({ bus, store, runs, agents, trails, chief, ledger, gateQueue, router,
//                   scheduler, makeProvider, getLayout, clock, workspaceRoot, env,
//                   keystorePath, fetch, schedule })
//     -> { init(), reflect({ reason }), gather(), latest(), list(), get(id), state() }
//
// On a schedule (daily, `schedule.daily`, default 07:00 local) and on budget.threshold at
// or over 100 %, the Chief Ranger reflects on the judge tier's `reflect` step model: for
// every venture in the plan, the actuals come only from real data the sidecar holds (runs
// and their reconciled spend, work items and their deliverables, Entrance Gate decisions,
// judge spend); there are no connectors yet, so revenue, orders and ad results are stated
// as unknown rather than guessed. The model answers one JSON document: a portfolio note,
// per venture what worked / what did not / whether the plan still holds / revisions /
// a morale note that must cite a number from the data (a note without one is replaced by
// a plain "no grounded note"), and one briefing per department. The document is stored
// (reflections/<id>.json, outbox/reflection-<id>.md at the Peak), each briefing is written
// to its station's notes store (<root>/_stations/<zoneId>/notes/) and, from phase 4 step 6,
// delivered as internal mail from peak@ to the camp's station address, reflection.posted is
// emitted, and the Chief gets a follow-up run to revise the plan and delegate. At the
// judge daily cap the reflection is skipped and says so.
//
// Budget watcher: every cost.estimate updates per-venture and mission spend (seeded from
// persisted runs at init) and emits budget.threshold once per threshold (80 %, 100 %) per
// scope; the judge daily cap is watched the same way.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';
import { costOf } from './loop.js';
import { createProvider as defaultMakeProvider } from './providers/provider.js';
import { CHIEF_ID } from './agents.js';
import { ZONE_LABELS, SPECIALTIES } from '../shared/world.js';

export const REFLECT_JOB_ID = 'reflection';
export const THRESHOLDS = Object.freeze([0.8, 1.0]);

export const REFLECT_SYSTEM_PROMPT = [
  'You are the Chief Ranger at the Mountain Peak of Maka, reflecting on the portfolio for the Superintendent and briefing the department camps.',
  'You see ONLY real data the harness recorded. Where a number is missing (no connector is wired) say "unknown"; never estimate revenue, orders or results.',
  'Answer with exactly one JSON object and nothing else:',
  '{"portfolio": "<3-6 sentences: actuals vs the plan, what to change>",',
  ' "ventures": [{"id": "<venture id>", "worked": ["<fact with a number>"], "didNot": ["<fact with a number>"], "planStillRight": true|false, "revisions": ["<concrete change>"], "morale": "<1-2 sentences to the Rangers citing numbers from the data>"}],',
  ' "briefings": [{"zoneId": "<zone id from the data>", "text": "<direction for that camp for the next day, concrete, with the numbers that matter>"}]}',
  'Morale notes are grounded: every claim cites a number present in the data (items done, deliverables, spend, approvals). No invented praise, no pep talk; if the data shows nothing achieved, say so plainly and name the next step.',
  'Plan revisions are concrete: which task to add, drop or re-brief and why.',
].join('\n');

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function parseReflection(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj.portfolio === 'string' && Array.isArray(obj.ventures)) return obj;
      return null;
    } catch {
      /* try a shorter slice */
    }
  }
  return null;
}

// A morale note is grounded when it cites a number. Not a proof of truth, but it stops
// the empty pep talk the brief forbids.
export function groundedNote(note) {
  if (typeof note !== 'string' || !note.trim()) return '(no note)';
  return /\d/.test(note) ? note.trim() : '(no grounded note: the model\'s note cited no number from the data)';
}

export function reflectionMarkdown(doc) {
  const lines = [`# Reflection ${doc.id} (${doc.reason})`, '', `At ${new Date(doc.at).toISOString()} · mission ${doc.missionId || 'none'} · model ${doc.model || '—'} · $${doc.usd === null || doc.usd === undefined ? '?' : doc.usd.toFixed(4)}`, '', '## Portfolio', '', doc.portfolio || '', ''];
  for (const v of doc.ventures || []) {
    lines.push(`## ${v.name || v.id} (${v.id})`, '', `Spend $${(v.spentUsd || 0).toFixed(2)} of $${(v.budgetUsd || 0).toFixed(2)} · items done ${v.itemsDone || 0}, failed ${v.itemsFailed || 0}, in flight ${v.itemsOpen || 0} · deliverables ${v.deliverables || 0} · Gate approved ${v.gateApproved || 0}, rejected ${v.gateRejected || 0}, pending ${v.gatePending || 0} · revenue unknown (no connector)`, '', `Plan still right: ${v.planStillRight ? 'yes' : 'no'}`, '');
    if (v.worked && v.worked.length) lines.push('What worked:', ...v.worked.map((x) => `- ${x}`), '');
    if (v.didNot && v.didNot.length) lines.push('What did not:', ...v.didNot.map((x) => `- ${x}`), '');
    if (v.revisions && v.revisions.length) lines.push('Revisions:', ...v.revisions.map((x) => `- ${x}`), '');
    lines.push(`Morale note: ${v.morale || '(none)'}`, '');
  }
  if (doc.proposals && doc.proposals.length) {
    lines.push('## Rule verdicts (results engine)', '');
    for (const p of doc.proposals) lines.push(`- ${p.venture}: **${p.verdict}** — ${p.because.join('; ')}`);
    lines.push('');
  }
  if (doc.kills && doc.kills.length) {
    lines.push('## Kills delegated', '');
    for (const k of doc.kills) lines.push(`- ${k.venture}: ${k.steps.length} pause(s) → work item(s) ${k.items.join(', ') || 'none'}${k.notes.length ? ` (${k.notes.join('; ')})` : ''}`);
    lines.push('');
  }
  if (doc.briefings && doc.briefings.length) {
    lines.push('## Briefings', '');
    for (const b of doc.briefings) lines.push(`### ${b.zoneId}`, '', b.text, '');
  }
  return lines.join('\n');
}

export function createReflect({
  bus,
  store,
  runs,
  getConnectors = null, // () => connectors registry (step 14); its summaries feed the reflection
  getMail = null, // () => the mail system (phase 4 step 6): briefings go into station mail from peak@
  getResults = null, // () => the results engine (phase 4 step 9): actuals per venture and the Chief rules' proposals
  agents,
  trails,
  chief,
  ledger = null,
  gateQueue = null,
  router,
  scheduler,
  makeProvider = defaultMakeProvider,
  getLayout,
  clock = { now: () => Date.now() },
  workspaceRoot,
  env = process.env,
  keystorePath,
  fetch: fetchImpl,
  schedule = { daily: '07:00' },
  log = console,
} = {}) {
  if (!bus || !store || !runs || !agents || !trails || !chief || !router || !scheduler || typeof getLayout !== 'function' || !workspaceRoot) {
    throw new TypeError('createReflect needs bus, store, runs, agents, trails, chief, router, scheduler, getLayout and workspaceRoot');
  }
  const route = router.route({ kind: 'reflect' });
  const caps = router.caps();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  let latest = null; // summary of the last reflection
  let cached = null;
  let reflecting = null;
  // Budget watcher state.
  const spentByAgent = new Map();
  const crossed = new Set(); // `${scope}:${id}:${threshold}`

  async function provider() {
    if (cached) return cached;
    cached = await makeProvider(route.provider, { model: route.model || undefined, env, keystorePath, fetch: fetchImpl });
    return cached;
  }

  function ventureOf(agentId) {
    const a = agents.get(agentId);
    return a && a.venture ? a.venture : null;
  }

  function ventureSpend(ventureId) {
    let usd = 0;
    for (const [agentId, v] of spentByAgent) if (ventureOf(agentId) === ventureId) usd += v;
    return usd;
  }

  function checkThresholds() {
    const st = chief.state();
    if (!st.mission) return;
    const plan = st.plan;
    const missionSpent = [...spentByAgent.values()].reduce((n, v) => n + v, 0);
    const scopes = [{ scope: 'mission', id: st.mission.id, budgetUsd: st.mission.budgetUsd, spentUsd: missionSpent }];
    if (plan) for (const v of plan.ventures) scopes.push({ scope: 'venture', id: v.id, budgetUsd: v.budgetUsd, spentUsd: ventureSpend(v.id) });
    if (ledger) scopes.push({ scope: 'judge', id: ledger.dayKey(), budgetUsd: caps.judgeUsdPerDay, spentUsd: ledger.judgeToday().usd });
    for (const s of scopes) {
      if (!(s.budgetUsd > 0)) continue;
      const fraction = s.spentUsd / s.budgetUsd;
      for (const t of THRESHOLDS) {
        const key = `${s.scope}:${s.id}:${t}`;
        if (fraction >= t && !crossed.has(key)) {
          crossed.add(key);
          emit('budget.threshold', { scope: s.scope, id: s.id, budgetUsd: s.budgetUsd, spentUsd: s.spentUsd, threshold: t, fraction });
          if (t >= 1 && s.scope !== 'judge') scheduler.trigger(REFLECT_JOB_ID, `budget: ${s.scope} ${s.id} at ${(fraction * 100).toFixed(0)} %`).catch((err) => log.error('reflection trigger failed:', err));
        }
      }
    }
  }

  bus.listen((event) => {
    if (event.type !== 'cost.estimate') return;
    const p = event.payload;
    if (!p.reconciled || typeof p.usd !== 'number' || !p.usd) return;
    const run = runs.active().find((r) => r.runId === p.runId);
    const agentId = run ? run.agentId : runIdAgent.get(p.runId);
    if (!agentId) return;
    spentByAgent.set(agentId, (spentByAgent.get(agentId) || 0) + p.usd);
    checkThresholds();
  });
  const runIdAgent = new Map();
  bus.listen((event) => {
    if (event.type === 'agent.run.start') runIdAgent.set(event.payload.runId, event.payload.agentId);
  });

  // Everything the reflection may know, from persisted facts only.
  async function gather() {
    const st = chief.state();
    // Phase 4 step 9: the results engine rolls the day up first, so the reflection reads
    // the same figures the Peak shows (nulls are "no data", never zero).
    const results = typeof getResults === 'function' ? getResults() : null;
    const rolled = results ? await results.rollup({ reason: 'reflection' }).catch((err) => { log.error('results rollup failed:', err); return null; }) : null;
    const resultsFor = (vid) => (rolled ? rolled.ventures.find((v) => v.id === vid) || null : null);
    const layout = getLayout();
    const allRuns = await store.listRuns();
    const since = st.mission ? st.mission.createdAt : 0;
    const items = trails.list();
    const gate = gateQueue ? gateQueue.items() : [];
    const ventures = (st.plan ? st.plan.ventures : []).map((v) => {
      const crew = layout.agents.filter((a) => a.venture === v.id);
      const ids = new Set(crew.map((a) => a.id));
      const vRuns = allRuns.filter((r) => ids.has(r.agentId) && (r.startedAt || 0) >= since);
      const vItems = items.filter((it) => ids.has(it.toAgentId));
      const vGate = gate.filter((g) => ids.has(g.agentId));
      return {
        id: v.id,
        name: v.name,
        summary: v.summary,
        budgetUsd: v.budgetUsd,
        spentUsd: vRuns.reduce((n, r) => n + (r.spentUsd || 0), 0),
        crew: crew.map((a) => ({ id: a.id, name: a.name, specialty: a.specialty || null, zoneId: a.roomId })),
        tasksPlanned: v.tasks.length,
        tasks: v.tasks.map((t) => ({ id: t.id, title: t.title, specialty: t.specialty, budgetUsd: t.budgetUsd })),
        runs: vRuns.length,
        runsFailed: vRuns.filter((r) => r.status === 'error').length,
        itemsDone: vItems.filter((it) => it.status === 'done').length,
        itemsFailed: vItems.filter((it) => it.status === 'failed' || it.status === 'cancelled').length,
        itemsOpen: vItems.filter((it) => it.status === 'queued' || it.status === 'running').length,
        deliverables: vItems.reduce((n, it) => n + (it.deliverables ? it.deliverables.length : 0), 0),
        recentItems: vItems.slice(0, 6).map((it) => ({ id: it.id, to: it.toAgentId, status: it.status, brief: it.brief.slice(0, 120), summary: (it.summary || '').slice(0, 200), deliverables: it.deliverables || [] })),
        gateApproved: vGate.filter((g) => g.status === 'approved').length,
        gateRejected: vGate.filter((g) => g.status === 'rejected' || g.status === 'revised').length,
        gatePending: vGate.filter((g) => g.status === 'pending').length,
        gateRefused: vGate.filter((g) => g.status === 'refused').length,
        revenue: 'unknown (no connector wired)',
        results: resultsFor(v.id) ? { window: resultsFor(v.id).window, all: resultsFor(v.id).all, spentUsd: resultsFor(v.id).spentUsd } : null,
        proposal: resultsFor(v.id) ? resultsFor(v.id).proposal : null,
      };
    });
    const zones = layout.rooms.filter((r) => !['entrance_gate', 'mountain_peak'].includes(r.kind)).map((r) => ({ id: r.id, name: r.name, kind: r.kind || null, crew: layout.agents.filter((a) => a.roomId === r.id).map((a) => a.id) }));
    return {
      at: clock.now(),
      mission: st.mission ? { id: st.mission.id, text: st.mission.text, budgetUsd: st.mission.budgetUsd, horizon: st.mission.horizon, status: st.mission.status, createdAt: st.mission.createdAt } : null,
      plan: st.plan ? { id: st.plan.id, version: st.plan.version, summary: st.plan.summary } : null,
      missionSpentUsd: allRuns.filter((r) => (r.startedAt || 0) >= since).reduce((n, r) => n + (r.spentUsd || 0), 0),
      judgeToday: ledger ? ledger.judgeToday() : null,
      judgeCapUsd: caps.judgeUsdPerDay,
      ventures,
      zones,
      gatePending: gate.filter((g) => g.status === 'pending').length,
      connectors: connectorLines(),
      results: rolled ? { park: rolled.park, parkWindow: rolled.parkWindow, sources: rolled.sources } : null,
    };
  }

  // Phase 4 step 9: a venture's actuals and the rule's verdict, as prompt lines. Every
  // figure is a number a source proved or "no data".
  const money = (n) => (n === null || n === undefined ? 'no data' : `$${n.toFixed(2)}`);
  function resultLines(v) {
    if (!v.results) return [];
    const w = v.results.window;
    const lines = [`  results, last ${w.days} day(s): revenue ${money(w.revenue)}, orders ${w.orders === null ? 'no data' : w.orders}, refunds ${money(w.refunds)}, fees ${money(w.fees)}, ad spend ${money(w.adSpend)}, model spend ${money(w.modelSpend)} (worker ${money(w.modelSpendByTier.worker)}, judge ${money(w.modelSpendByTier.judge)}, hosted ${money(w.modelSpendByTier.hosted_worker)}), mail in ${w.mailIn} / out ${w.mailOut}`];
    lines.push(`  unit economics: contribution per order ${money(w.contributionPerOrder)}, model cost per order ${money(w.modelCostPerOrder)}, net ${money(w.net)}${w.unknown.length ? ` (${w.unknown.join(', ')} unknown)` : ''}; payback ${v.results.all.payback ? (v.results.all.payback.reached ? `reached on ${v.results.all.payback.day}` : 'not reached') : 'no data'}`);
    if (v.proposal) lines.push(`  RULE VERDICT: ${v.proposal.verdict.toUpperCase()} because ${v.proposal.because.join('; ')}`);
    return lines;
  }

  // What the connectors' syncs hold, as plain text: real figures or "not connected".
  function connectorLines() {
    const reg = typeof getConnectors === 'function' ? getConnectors() : null;
    const rows = reg ? reg.list() : [];
    if (!rows.length) return 'none wired: revenue, orders, ad results are unknown';
    const parts = rows.map((c) => `${c.label}: ${c.connected ? (c.summary || 'connected') + (c.syncedAt ? ` (synced ${new Date(c.syncedAt).toISOString()})` : ' (not synced yet)') : 'not connected'}`);
    return parts.join('; ');
  }

  function promptFor(data) {
    const lines = [`Reflection at ${new Date(data.at).toISOString()}.`, ''];
    lines.push(data.mission ? `Mission: ${data.mission.text}\nMission budget $${data.mission.budgetUsd.toFixed(2)}, spent $${data.missionSpentUsd.toFixed(2)}, horizon ${data.mission.horizon}, status ${data.mission.status}.` : 'No mission has been given yet.');
    lines.push(data.plan ? `Plan v${data.plan.version}: ${data.plan.summary}` : 'No plan exists.');
    lines.push(`Connectors: ${data.connectors}.`, `Judge spend today $${data.judgeToday ? data.judgeToday.usd.toFixed(2) : '?'} of $${data.judgeCapUsd}. Gate items pending: ${data.gatePending}.`, '');
    lines.push('Zones (brief each one that has crew):', ...data.zones.map((z) => `- ${z.id}: ${z.name} (${z.kind || 'zone'}), crew: ${z.crew.join(', ') || 'none'}`), '');
    if (!data.ventures.length) lines.push('Ventures: none in the plan.');
    for (const v of data.ventures) {
      lines.push(`VENTURE ${v.id} "${v.name}": ${v.summary}`);
      lines.push(`  budget $${v.budgetUsd.toFixed(2)}, spent $${v.spentUsd.toFixed(2)}; crew ${v.crew.map((c) => `${c.id} (${c.specialty || 'ranger'}, ${c.zoneId})`).join(', ') || 'none'}`);
      lines.push(`  tasks planned ${v.tasksPlanned}: ${v.tasks.map((t) => `${t.id} ${t.title}`).join('; ') || 'none'}`);
      lines.push(`  runs ${v.runs} (${v.runsFailed} failed); work items done ${v.itemsDone}, failed ${v.itemsFailed}, in flight ${v.itemsOpen}; deliverables ${v.deliverables}`);
      lines.push(`  Gate: approved ${v.gateApproved}, rejected/revised ${v.gateRejected}, pending ${v.gatePending}, refused by leash ${v.gateRefused}; revenue ${v.revenue}`);
      lines.push(...resultLines(v));
      for (const it of v.recentItems) lines.push(`  item ${it.id} → ${it.to}: ${it.status}; brief "${it.brief}"; summary "${it.summary}"; files ${it.deliverables.join(', ') || 'none'}`);
      lines.push('');
    }
    if (data.results) lines.push(`Park totals, last ${data.results.parkWindow.days} day(s): revenue ${money(data.results.parkWindow.revenue)}, orders ${data.results.parkWindow.orders === null ? 'no data' : data.results.parkWindow.orders}, refunds ${money(data.results.parkWindow.refunds)}, fees ${money(data.results.parkWindow.fees)}, ad spend ${money(data.results.parkWindow.adSpend)}, model spend ${money(data.results.parkWindow.modelSpend)}. The rule verdicts above are the harness's own reading of the numbers: a KILL means pause that venture's campaigns and listings (already delegated to its Rangers through the Gate), a SCALE is a proposal only (a budget raise is money out at the Gate), HOLD and NO_DATA change nothing.`, '');
    lines.push('Answer with the JSON object only.');
    return lines.join('\n');
  }

  // Phase 4 step 6: each briefing is internal mail from peak@ to the camp's station
  // address (kind 'briefing'; never through Resend, no footer). The notes file stays the
  // on-disk copy. A camp with no station address, or no mail system, gets the file only.
  async function mailBriefings(doc) {
    const mail = typeof getMail === 'function' ? getMail() : null;
    if (!mail || typeof mail.deliverInternal !== 'function') return [];
    const layout = getLayout();
    const peak = layout.rooms.find((r) => r.kind === 'mountain_peak');
    const from = peak ? (mail.addresses.forStation(peak.id).find((r) => r.kind === 'station') || {}).address : null;
    if (!from) return [];
    const out = [];
    for (const b of doc.briefings) {
      const to = (mail.addresses.forStation(b.zoneId).find((r) => r.kind === 'station') || {}).address;
      if (!to) continue;
      try {
        const [record] = await mail.deliverInternal({ from, to, subject: `Briefing from the Mountain Peak (${doc.id})`, text: b.text, kind: 'briefing', ref: doc.id });
        out.push({ zoneId: b.zoneId, to, messageId: record.id, threadId: record.threadId });
      } catch (err) {
        log.error(`briefing mail to ${to} failed:`, err.message);
      }
    }
    return out;
  }

  // Phase 4 step 9: a KILL verdict pauses the venture's attributed campaigns and listings.
  // The pauses are work items the Chief hands to the venture's own Ads / Storefront
  // Rangers, whose tools pass the Gate as usual (a pause is a proven $0 money_out; a
  // listing change is publishing). Nothing is paused here directly, nothing twice: an
  // open kill item for the venture means no new one.
  async function delegateKills(data) {
    const results = typeof getResults === 'function' ? getResults() : null;
    if (!results || !data.mission || data.mission.status === 'done') return [];
    const out = [];
    for (const v of data.ventures) {
      if (!v.proposal || v.proposal.verdict !== 'kill') continue;
      const steps = results.killPlan(v.id);
      const record = { venture: v.id, because: v.proposal.because, steps: steps.map((s) => ({ connector: s.connector, object: s.object, tool: s.tool, agentId: s.agentId })), items: [], notes: [] };
      if (!steps.length) record.notes.push('nothing to pause: no campaign or listing is attributed to this venture');
      const open = trails.list().some((it) => it.fromAgentId === CHIEF_ID && (it.status === 'queued' || it.status === 'running') && /^KILL /.test(it.brief) && it.brief.includes(`venture ${v.id}`));
      if (open) record.notes.push('a kill item for this venture is still open: nothing new delegated');
      const byAgent = new Map();
      for (const s of steps) {
        if (!s.agentId) {
          record.notes.push(`no ${s.specialty} Ranger in the venture's crew for ${s.tool} on ${s.object}: not delegated`);
          continue;
        }
        if (!byAgent.has(s.agentId)) byAgent.set(s.agentId, []);
        byAgent.get(s.agentId).push(s);
      }
      if (!open) {
        for (const [agentId, mine] of byAgent) {
          const brief = [`KILL venture ${v.id}: the results engine's rule says kill because ${v.proposal.because.join('; ')}.`, 'Pause everything below with exactly these tool calls, one each, and report what each tool answered. Do not create, activate or change anything else.', ...mine.map((s) => `- ${s.tool} ${JSON.stringify(s.input)}  (${s.connector} ${s.object})`)].join('\n');
          try {
            const item = await trails.delegate({ toAgentId: agentId, brief, budgetUsd: 0.25, evidence: ['the tool results'], venture: v.id }, { by: CHIEF_ID });
            record.items.push(item.id);
          } catch (err) {
            record.notes.push(`delegation to ${agentId} refused: ${err.code || ''} ${err.message}`.trim());
          }
        }
      }
      out.push(record);
    }
    return out;
  }

  async function writeBriefings(doc) {
    const written = [];
    for (const b of doc.briefings) {
      const dir = path.join(workspaceRoot, '_stations', b.zoneId, 'notes');
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date(doc.at).toISOString().slice(0, 10)}-briefing-${doc.id}.md`);
      await fsp.writeFile(file, `# Briefing from the Mountain Peak (${doc.id})\n\n${b.text}\n`, 'utf8');
      written.push(path.relative(workspaceRoot, file));
    }
    return written;
  }

  async function reflect({ reason = 'manual' } = {}) {
    if (reflecting) return reflecting;
    reflecting = (async () => {
      const id = `reflection-${new Date(clock.now()).toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
      const data = await gather();
      const skip = async (skipReason) => {
        const doc = { id, at: data.at, reason, status: 'skipped', skipReason, missionId: data.mission ? data.mission.id : null, data, portfolio: '', ventures: [], briefings: [], usd: null, model: route.model || '', provider: route.provider };
        await store.saveReflection(doc);
        latest = summary(doc);
        emit('reflection.posted', { reflectionId: id, reason, status: 'skipped', skipReason, missionId: doc.missionId || '', provider: route.provider, model: route.model || '', usd: null, reconciled: false });
        return doc;
      };
      if (ledger) {
        const today = ledger.judgeToday();
        if (today.usd >= caps.judgeUsdPerDay) return skip(`judge daily cap reached: $${today.usd.toFixed(2)} of $${caps.judgeUsdPerDay}`);
        if (today.calls >= caps.judgeCallsPerDay) return skip(`judge cap reached: ${caps.judgeCallsPerDay} call(s) per day`);
      }
      let p;
      try {
        p = await provider();
      } catch (err) {
        return skip(`judge not wired: ${err && err.message ? err.message : err}`);
      }
      let text = '';
      let usage = null;
      try {
        const stream = p.provider.stream({ model: p.model, system: REFLECT_SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: promptFor(data) }] }], tools: [] }, {});
        for await (const chunk of stream) {
          if (chunk.type === 'text_delta') text += chunk.text;
          else if (chunk.type === 'message_end') usage = chunk.usage || null;
        }
      } catch (err) {
        log.error('reflection call failed:', err);
        return skip(`reflection call failed: ${err && err.message ? err.message : err}`);
      }
      const turnUsage = usage ? { inputTokens: usage.inputTokens | 0, outputTokens: usage.outputTokens | 0 } : null;
      const usd = usage && typeof usage.costUsd === 'number' && usage.costUsd >= 0 ? usage.costUsd : costOf(turnUsage, p.price);
      emit('cost.estimate', { runId: id, turn: 1, provider: p.provider.name, model: p.model, inputTokens: turnUsage ? turnUsage.inputTokens : 0, outputTokens: turnUsage ? turnUsage.outputTokens : 0, usd, reconciled: usd !== null, tier: 'judge' });
      if (ledger) await ledger.recordJudge({ usd: usd || 0 }).catch((err) => log.error('judge ledger failed:', err));
      const parsed = parseReflection(text);
      if (!parsed) return skip(`the reflection model did not return a readable document (${text.slice(0, 200) || 'empty answer'})`);
      const known = new Map(data.ventures.map((v) => [v.id, v]));
      const ventures = (parsed.ventures || []).filter((v) => v && known.has(v.id)).map((v) => {
        const d = known.get(v.id);
        return { id: v.id, name: d.name, budgetUsd: d.budgetUsd, spentUsd: d.spentUsd, itemsDone: d.itemsDone, itemsFailed: d.itemsFailed, itemsOpen: d.itemsOpen, deliverables: d.deliverables, gateApproved: d.gateApproved, gateRejected: d.gateRejected, gatePending: d.gatePending, worked: arr(v.worked), didNot: arr(v.didNot), planStillRight: v.planStillRight !== false, revisions: arr(v.revisions), morale: groundedNote(v.morale) };
      });
      const zoneIds = new Set(data.zones.map((z) => z.id));
      const briefings = (parsed.briefings || []).filter((b) => b && zoneIds.has(b.zoneId) && typeof b.text === 'string' && b.text.trim()).map((b) => ({ zoneId: b.zoneId, text: b.text.trim() }));
      const doc = { id, at: data.at, reason, status: 'posted', missionId: data.mission ? data.mission.id : null, provider: p.provider.name, model: p.model, usd, data, portfolio: String(parsed.portfolio).trim(), ventures, briefings, briefingFiles: [], path: '' };
      doc.briefingFiles = await writeBriefings(doc);
      doc.briefingMail = await mailBriefings(doc);
      doc.proposals = data.ventures.filter((v) => v.proposal).map((v) => v.proposal);
      doc.kills = await delegateKills(data);
      const outbox = path.join(workspaceRoot, CHIEF_ID, 'outbox');
      await fsp.mkdir(outbox, { recursive: true });
      const mdPath = path.join(outbox, `${id}.md`);
      await fsp.writeFile(mdPath, reflectionMarkdown(doc), 'utf8');
      doc.path = path.relative(workspaceRoot, mdPath);
      await store.saveReflection(doc);
      latest = summary(doc);
      emit('reflection.posted', { reflectionId: id, reason, status: 'posted', missionId: doc.missionId || '', provider: doc.provider, model: doc.model, usd, reconciled: usd !== null, portfolio: doc.portfolio.slice(0, 2000), ventures: ventures.map((v) => ({ id: v.id, planStillRight: v.planStillRight, spentUsd: v.spentUsd, budgetUsd: v.budgetUsd, itemsDone: v.itemsDone, itemsFailed: v.itemsFailed })), briefings: briefings.map((b) => b.zoneId), path: doc.path, mailed: doc.briefingMail.length });
      // The Chief revises the plan and delegates from the reflection (bounded like any follow-up).
      if (data.mission && data.mission.status !== 'done' && ventures.length) {
        const revisions = ventures.flatMap((v) => v.revisions.map((r) => `${v.id}: ${r}`));
        const verdicts = (doc.proposals || []).filter((p) => p.verdict !== 'hold').map((p) => `${p.venture}: ${p.verdict.toUpperCase()} (${p.because[0]})`);
        if (verdicts.length) revisions.push(`rule verdicts: ${verdicts.join('; ')}`);
        chief.followUp({ payload: { workItemId: id, toAgentId: CHIEF_ID, status: 'done', reason: 'reflection', deliverables: [doc.path], summary: `Reflection ${id}: ${doc.portfolio.slice(0, 600)}${revisions.length ? ` Revisions: ${revisions.join('; ').slice(0, 800)}` : ''}`, spentUsd: usd || 0 } }).catch((err) => log.error('reflection follow-up failed:', err));
      }
      return doc;
    })().finally(() => {
      reflecting = null;
    });
    return reflecting;
  }

  function summary(doc) {
    return { id: doc.id, at: doc.at, reason: doc.reason, status: doc.status, skipReason: doc.skipReason || null, missionId: doc.missionId || null, model: doc.model || null, usd: doc.usd ?? null, portfolio: (doc.portfolio || '').slice(0, 600), ventures: (doc.ventures || []).map((v) => ({ id: v.id, planStillRight: v.planStillRight, morale: v.morale })), briefings: (doc.briefings || []).map((b) => b.zoneId), mailed: (doc.briefingMail || []).length, proposals: (doc.proposals || []).map((p) => ({ venture: p.venture, verdict: p.verdict, because: p.because })), kills: (doc.kills || []).map((k) => ({ venture: k.venture, items: k.items, steps: k.steps.length, notes: k.notes })), path: doc.path || null };
  }

  return {
    route,
    REFLECT_JOB_ID,
    async init() {
      // Seed the budget watcher from persisted runs so a restart keeps the thresholds honest.
      for (const r of await store.listRuns()) {
        if (r.spentUsd) spentByAgent.set(r.agentId, (spentByAgent.get(r.agentId) || 0) + r.spentUsd);
      }
      const list = await store.listReflections();
      if (list.length) {
        const doc = await store.loadReflection(list[0].id);
        if (doc) latest = summary(doc);
      }
      scheduler.add(REFLECT_JOB_ID, schedule, ({ reason }) => reflect({ reason }));
      checkThresholds();
      return this;
    },
    reflect,
    gather,
    latest: () => latest,
    list: () => store.listReflections(),
    get: (id) => store.loadReflection(id),
    state: () => ({ latest, schedule, job: scheduler.state()[REFLECT_JOB_ID] || null, route, spentByAgent: Object.fromEntries(spentByAgent) }),
    checkThresholds,
  };
}

function arr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 12) : [];
}

export { ZONE_LABELS, SPECIALTIES };
