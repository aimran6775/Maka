// Department charters (D184): what each department does without being asked.
//
//   createCharters({ bus, store, scheduler, trails, agents, getLayout, ledger, clock, log })
//     -> { init(), list(), get(dept), setCharter(dept, patch), setDuty(dept, duty),
//          removeDuty(dept, dutyId), runNow(dept, dutyId), remitLines(agent), state(), tools }
//
// A department had a head and a persona, so it could answer what another department asked
// it (D178) — and nothing else. It never did anything on its own. A charter is the other
// half: a standing remit the department's head carries into every run, and duties that the
// scheduler hands it on a cadence, so the park works while nobody is watching.
//
//   remit    what this department owns, decides, and must hand to the Gate. It goes into
//            the head's system prompt, so it holds in every run, not only in a duty.
//   duties   { id, title, brief, schedule, budgetUsd, enabled } — the standing work. The
//            scheduler delegates each one to the department's head when it falls due.
//
// Two bounds, because standing work that runs for ever is standing spend that runs for
// ever. Each duty carries its own `budgetUsd`, and each charter a `dailyCapUsd` that its
// duties share — reached, the rest of the day's duties are skipped and say so. The judge's
// own daily cap stops everything above that.
//
// A duty is delegated by the Superintendent, because it is the park's standing work rather
// than one Ranger's errand, and it belongs to no venture: a department's own housekeeping
// is not a business's spend (D183).

import { makeEvent } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { DEPARTMENT_KINDS, ZONE_LABELS, departmentOf, departmentOfAgent, isDepartmentKind } from '../shared/world.js';

export const JOB_PREFIX = 'charter';
export const DEFAULT_DAILY_CAP_USD = 1;
export const MAX_DUTIES = 12;

export const DUTY_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'title', 'brief', 'schedule'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 2, maxLength: 60, pattern: '^[a-z0-9][a-z0-9-]*$' },
    title: { type: 'string', minLength: 3, maxLength: 120 },
    brief: { type: 'string', minLength: 20, maxLength: 4000, description: 'What to do, and what the deliverable is' },
    schedule: {
      type: 'object',
      additionalProperties: false,
      properties: { daily: { type: 'string', pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' }, everyMs: { type: 'number', minimum: 60000 } },
    },
    budgetUsd: { type: 'number', minimum: 0, maximum: 50 },
    enabled: { type: 'boolean' },
    evidence: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 3, maxLength: 300 } },
  },
});

// What each department does by default, so a park that has never been configured still has
// ten departments doing something rather than ten departments waiting. Every duty is a read
// and a write-up: nothing here publishes, sends, or spends outside the park, because a
// duty runs while the owner is asleep and the Gate is where outward acts belong.
export const DEFAULT_CHARTERS = Object.freeze({
  research: {
    remit: 'You own what the park knows about the outside world: opportunities, demand, competitors and prices. You bring evidence with source URLs, never estimates dressed as findings, and you say what you could not verify.',
    duties: [
      { id: 'opportunity-sweep', title: 'Weekly opportunity sweep', schedule: { everyMs: 7 * 24 * 3600 * 1000 }, budgetUsd: 0.3, brief: 'Look for two or three businesses the park could run that it is not running. Read the portfolio with venture.list first so you do not re-propose what exists or was declined. For each: what it sells, to whom, and one piece of real evidence of demand with its source URL. Write them to _teams/research/opportunities.md with the date. Do not propose anything to the owner from this sweep — that is a venture.propose of its own, once you are confident.' },
    ],
  },
  business: {
    remit: 'You own strategy and pricing. You read the books and the Scouts\' briefs and say which ventures to grow, hold or stop, with the numbers you used. A price change is money_in and a partnership is the Gate\'s.',
    duties: [
      { id: 'portfolio-review', title: 'Weekly portfolio review', schedule: { everyMs: 7 * 24 * 3600 * 1000 }, budgetUsd: 0.4, brief: 'Review every active venture with venture.list and the books with ledger.read where you have it. For each: what it has spent against what the owner approved, what it has delivered, and your call — grow, hold, or stop, with the figure behind it. A venture with no deliverable and real spend is the one to flag. Write it to _teams/business/portfolio-review.md. Recommend; do not act.' },
    ],
  },
  finance: {
    remit: 'You keep the books from real connector data only. You never estimate revenue, and a figure no source holds reads "no data".',
    duties: [
      { id: 'daily-books', title: 'Daily books', schedule: { daily: '07:30' }, budgetUsd: 0.15, brief: 'Read the park\'s books with ledger.read: model spend, and revenue, refunds and fees where a connector is synced. Write today\'s line to _teams/finance/books.md — date, each figure, and "no data" wherever nothing is connected. Never estimate a figure you cannot read.' },
    ],
  },
  legal: {
    remit: 'You own policy and risk: platform terms, consumer and labelling rules, privacy, and what the park may claim. You read the real terms before answering, you say plainly when something is not allowed or when you do not know, and you advise rather than approve.',
    duties: [
      { id: 'claims-watch', title: 'Monthly claims and terms check', schedule: { everyMs: 30 * 24 * 3600 * 1000 }, budgetUsd: 0.4, brief: 'Check the claims the park makes and the terms it operates under. Read what is in _teams/ for wording the park plans to publish, and re-read the platform terms that matter to the active ventures. Write anything that has changed or that worries you to _teams/legal/watch.md, with the rule and its source URL. Where a site refuses an automated client, say so rather than guessing.' },
    ],
  },
  infrastructure: {
    remit: 'You own the machinery: the browser, the connectors\' health and this Mac. You check a thing works before another department depends on it, and you report a failure as a failure with its exact error.',
    duties: [
      { id: 'morning-check', title: 'Morning health check', schedule: { daily: '06:45' }, budgetUsd: 0.1, brief: 'Check the park can do its work: fetch https://example.com/ and report the HTTP status you actually got, then read connector.status for every connector where you have that tool and say which are connected and which are not. Write it to _teams/infrastructure/health.md with the date and the exact errors. Where a tool you need is not granted to your camp, say which tool and what it would have told you — that is a gap for the owner to close, not something to work around. If something is broken, say what depends on it.' },
    ],
  },
  sales: {
    remit: 'You own the pipeline. You report what closed and what did not from real order and mail data, and you never claim a sale no order record shows. Every message out passes the outbound_messages leash.',
    duties: [
      { id: 'pipeline-review', title: 'Weekly pipeline', schedule: { everyMs: 7 * 24 * 3600 * 1000 }, budgetUsd: 0.2, brief: 'Report the pipeline from real data only: orders from the storefront connectors where they are synced, and anything in the station mail that is a buyer. Write it to _teams/sales/pipeline.md — what came in, what is open, and "no data" where nothing is connected. Do not contact anyone from this duty.' },
    ],
  },
  product_listings: {
    remit: 'You own the listings: original copy, pricing proposals, supplier orders and fulfilment status. Every platform action goes through its official API under its terms.',
    duties: [
      { id: 'listing-audit', title: 'Weekly listing audit', schedule: { everyMs: 7 * 24 * 3600 * 1000 }, budgetUsd: 0.2, brief: 'Audit the live listings against what the park meant to sell: read the storefront connectors where they are synced and the drafts in _teams/product_listings/. Flag anything priced below its unit cost, out of stock, or making a claim Legal has not cleared. Write it to _teams/product_listings/audit.md. Change nothing.' },
    ],
  },
  marketing: {
    remit: 'You own content, social, email and SEO, with original copy and creative, under the publishing and outbound_messages leashes. Nothing goes out without the Gate.',
    duties: [
      { id: 'performance-review', title: 'Weekly performance review', schedule: { everyMs: 7 * 24 * 3600 * 1000 }, budgetUsd: 0.25, brief: 'Read the last seven days of the ad accounts and any site traffic you can reach, and write what the spend bought: a table of spend against results per campaign, then up to three recommendations each tied to a number in the table. Write it to _teams/marketing/performance.md, with "no data" where a connector is not synced. Recommend only; change no budget or status.' },
    ],
  },
  operations_support: {
    remit: 'You handle customer mail and chat, returns and reviews, truthfully and politely, and you escalate refunds and anything irreversible to the Gate.',
    duties: [
      { id: 'inbox-sweep', title: 'Daily inbox sweep', schedule: { daily: '08:00' }, budgetUsd: 0.15, brief: 'Read the station mail with mail.search and mail.read where you have them. Write what needs an answer, what is a refund or a complaint, and what can wait to _teams/operations_support/inbox.md. Draft nothing and send nothing from this duty: a reply is outbound_messages and goes through the Gate.' },
    ],
  },
  people: {
    remit: 'You own the crew: who the park needs and who it no longer needs, and a plain record of what each department delivered. You do not hire or retire on your own word — you ask the Chief Ranger, who holds those tools.',
    duties: [
      { id: 'crew-review', title: 'Weekly crew review', schedule: { everyMs: 7 * 24 * 3600 * 1000 }, budgetUsd: 0.2, brief: 'Review the crew with dept.directory: every department, its head, its staff, and what each delivered this week (read the other teams\' folders — you may read any). Name anyone with no work and anyone carrying too much, and say what you would ask the Chief to change. Write it to _teams/people/crew-review.md. Recommend only; the Chief hires and retires.' },
    ],
  },
});

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function createCharters({
  bus,
  store,
  scheduler = null,
  trails = null,
  agents = null,
  getLayout = () => null,
  ledger = null,
  judgeCap = null, // () -> string reason | null, so a department does not spend past the park's day
  clock = { now: () => Date.now() },
  log = console,
} = {}) {
  if (!bus || !store) throw new TypeError('createCharters needs bus and store');
  let data = { version: 1, charters: {}, spend: {} };

  const emit = (payload) => bus.emit(makeEvent('charter.duty', payload, { ts: clock.now() }));
  const save = () => store.saveCharters(data);
  const charterOf = (dept) => data.charters[dept] || null;
  const jobId = (dept, dutyId) => `${JOB_PREFIX}:${dept}:${dutyId}`;

  // What this department's duties have spent today, against its own daily cap.
  function spentToday(dept) {
    const key = dayKey(clock.now());
    const row = data.spend[dept];
    return row && row.day === key ? row.usd : 0;
  }

  async function recordSpend(dept, usd) {
    const key = dayKey(clock.now());
    const row = data.spend[dept];
    data.spend[dept] = row && row.day === key ? { day: key, usd: row.usd + usd } : { day: key, usd };
    await save();
  }

  // Why this duty is not running now, or null. Checked at the moment it falls due, because
  // a cap reached hours ago may have rolled over since.
  function blocked(dept, duty) {
    const charter = charterOf(dept);
    if (!charter) return `${dept} has no charter`;
    if (duty.enabled === false) return 'the duty is switched off';
    if (charter.enabled === false) return `the ${ZONE_LABELS[dept] || dept} charter is switched off`;
    const d = departmentOf(getLayout(), dept);
    if (!d || !d.roomId) return `the ${ZONE_LABELS[dept] || dept} has not been built yet`;
    if (!d.head) return `the ${ZONE_LABELS[dept] || dept} has no head to do it`;
    const cap = typeof charter.dailyCapUsd === 'number' ? charter.dailyCapUsd : DEFAULT_DAILY_CAP_USD;
    const spent = spentToday(dept);
    const want = typeof duty.budgetUsd === 'number' ? duty.budgetUsd : 0.2;
    if (spent + want > cap + 1e-9) return `the ${ZONE_LABELS[dept] || dept} has spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} for today`;
    if (typeof judgeCap === 'function') {
      const reason = judgeCap();
      if (reason) return reason;
    }
    return null;
  }

  async function runDuty(dept, dutyId, { reason = 'due' } = {}) {
    const charter = charterOf(dept);
    const duty = charter && (charter.duties || []).find((d) => d.id === dutyId);
    if (!duty) throw fail('NOT_FOUND', `no duty "${dutyId}" in the ${ZONE_LABELS[dept] || dept} charter`, 404);
    const why = blocked(dept, duty);
    if (why) {
      // A duty that did not run says so: silence would read as work done.
      emit({ department: dept, dutyId, change: 'skipped', title: duty.title, reason: why, trigger: reason });
      return { ran: false, reason: why };
    }
    if (!trails || typeof trails.delegate !== 'function') {
      emit({ department: dept, dutyId, change: 'skipped', title: duty.title, reason: 'no trails to delegate along', trigger: reason });
      return { ran: false, reason: 'no trails to delegate along' };
    }
    const d = departmentOf(getLayout(), dept);
    const budgetUsd = typeof duty.budgetUsd === 'number' ? duty.budgetUsd : 0.2;
    const brief = [
      `Standing duty "${duty.title}" of the ${d.label} (${dept}). Nobody asked for this: it is what your department does on its own.`,
      '',
      duty.brief,
      '',
      `Your department's folder is _teams/${dept}/ — you may read any team's folder and write only your own.`,
      'If you cannot do part of this, write what you tried and what stopped you rather than leaving it out.',
    ].join('\n');
    try {
      const item = await trails.delegate(
        { toAgentId: d.head, brief, budgetUsd, evidence: duty.evidence || [], venture: null },
        { by: 'superintendent' },
      );
      await recordSpend(dept, item.budgetUsd);
      emit({ department: dept, dutyId, change: 'ran', title: duty.title, workItemId: item.id, agentId: d.head, budgetUsd: item.budgetUsd, trigger: reason });
      return { ran: true, workItemId: item.id, toAgentId: d.head };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      emit({ department: dept, dutyId, change: 'skipped', title: duty.title, reason: message, trigger: reason });
      return { ran: false, reason: message };
    }
  }

  function scheduleDuty(dept, duty) {
    if (!scheduler) return;
    const id = jobId(dept, duty.id);
    if (typeof scheduler.remove === 'function') scheduler.remove(id);
    if (duty.enabled === false) return;
    const charter = charterOf(dept);
    if (charter && charter.enabled === false) return;
    scheduler.add(id, duty.schedule, ({ reason }) => runDuty(dept, duty.id, { reason }));
  }

  function rescheduleAll() {
    for (const dept of Object.keys(data.charters)) {
      for (const duty of data.charters[dept].duties || []) scheduleDuty(dept, duty);
    }
  }

  const api = {
    tools: {},
    list: () => Object.entries(data.charters).map(([dept, c]) => ({ department: dept, label: ZONE_LABELS[dept] || dept, ...c, spentTodayUsd: spentToday(dept) })),
    get: (dept) => (data.charters[dept] ? { department: dept, label: ZONE_LABELS[dept] || dept, ...data.charters[dept], spentTodayUsd: spentToday(dept) } : null),
    runNow: (dept, dutyId) => runDuty(dept, dutyId, { reason: 'asked for' }),

    // The remit in the head's system prompt, so a department's standing instructions hold
    // in every run it does — not only in the duties the scheduler hands it.
    remitLines(agent) {
      if (!agent) return [];
      const d = departmentOfAgent(getLayout(), agent.id);
      if (!d) return [];
      const charter = charterOf(d.kind);
      if (!charter || !charter.remit) return [];
      const head = d.head === agent.id;
      const lines = [`Your department, the ${d.label}: ${charter.remit}`];
      if (head) {
        const duties = (charter.duties || []).filter((x) => x.enabled !== false);
        lines.push(`You head it: requests other departments send here come to you, and you may assign them to your team with delegate.`);
        if (duties.length) lines.push(`Its standing duties: ${duties.map((x) => x.title).join('; ')}.`);
      }
      return lines;
    },

    async setCharter(dept, patch = {}) {
      if (!isDepartmentKind(dept)) throw fail('BAD_REQUEST', `"${dept}" is not a department of the park`);
      const current = data.charters[dept] || { remit: '', duties: [] };
      const next = { ...current };
      if (patch.remit !== undefined) next.remit = String(patch.remit).slice(0, 4000);
      if (patch.dailyCapUsd !== undefined) {
        const n = Number(patch.dailyCapUsd);
        if (!(n >= 0)) throw fail('BAD_REQUEST', 'dailyCapUsd must be a number of dollars, 0 or more');
        next.dailyCapUsd = n;
      }
      if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
      data.charters[dept] = next;
      await save();
      rescheduleAll();
      emit({ department: dept, change: 'set', reason: 'the charter was changed' });
      return api.get(dept);
    },

    async setDuty(dept, duty = {}) {
      if (!isDepartmentKind(dept)) throw fail('BAD_REQUEST', `"${dept}" is not a department of the park`);
      const v = validate(DUTY_SCHEMA, duty);
      if (!v.ok) throw fail('BAD_REQUEST', `the duty is invalid: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      if (!duty.schedule.daily && !duty.schedule.everyMs) throw fail('BAD_REQUEST', 'a duty needs a schedule: { daily: "HH:MM" } or { everyMs }');
      const charter = data.charters[dept] || { remit: '', duties: [] };
      const duties = [...(charter.duties || [])];
      const at = duties.findIndex((d) => d.id === duty.id);
      if (at === -1 && duties.length >= MAX_DUTIES) throw fail('TOO_MANY', `a department keeps at most ${MAX_DUTIES} standing duties`);
      if (at === -1) duties.push({ ...duty });
      else duties[at] = { ...duties[at], ...duty };
      data.charters[dept] = { ...charter, duties };
      await save();
      scheduleDuty(dept, duties[at === -1 ? duties.length - 1 : at]);
      emit({ department: dept, dutyId: duty.id, change: 'set', title: duty.title, reason: at === -1 ? 'a duty was added' : 'a duty was changed' });
      return api.get(dept);
    },

    async removeDuty(dept, dutyId) {
      const charter = data.charters[dept];
      if (!charter) throw fail('NOT_FOUND', `no charter for "${dept}"`, 404);
      const duties = (charter.duties || []).filter((d) => d.id !== dutyId);
      if (duties.length === (charter.duties || []).length) throw fail('NOT_FOUND', `no duty "${dutyId}"`, 404);
      data.charters[dept] = { ...charter, duties };
      await save();
      if (scheduler && typeof scheduler.remove === 'function') scheduler.remove(jobId(dept, dutyId));
      emit({ department: dept, dutyId, change: 'removed', reason: 'the duty was removed' });
      return api.get(dept);
    },

    state() {
      const depts = Object.keys(data.charters);
      const duties = depts.flatMap((d) => (data.charters[d].duties || []).map((x) => ({ department: d, ...x })));
      return {
        departments: depts.length,
        duties: duties.length,
        enabled: duties.filter((d) => d.enabled !== false).length,
        spentTodayUsd: depts.reduce((n, d) => n + spentToday(d), 0),
        next: scheduler && typeof scheduler.state === 'function' ? Object.fromEntries(Object.entries(scheduler.state()).filter(([k]) => k.startsWith(`${JOB_PREFIX}:`))) : {},
      };
    },

    async init() {
      const loaded = await store.loadCharters(null);
      if (loaded && loaded.version === 1 && loaded.charters) data = { spend: {}, ...loaded };
      // A park that has never been configured still gets ten departments that do something.
      // Only the missing ones: a charter the owner has edited is never overwritten.
      let seeded = 0;
      for (const dept of DEPARTMENT_KINDS) {
        if (data.charters[dept]) continue;
        const d = DEFAULT_CHARTERS[dept];
        if (!d) continue;
        data.charters[dept] = { remit: d.remit, dailyCapUsd: DEFAULT_DAILY_CAP_USD, duties: d.duties.map((x) => ({ ...x })) };
        seeded += 1;
      }
      if (seeded) await save();
      rescheduleAll();
      return api;
    },
  };

  api.tools = {
    'charter.read': {
      name: 'charter.read',
      description:
        'Read a department\'s charter: its standing remit — what it owns and what it must hand to the Gate — and its standing duties with their cadence and budget. Yours by default. Read another department\'s before you ask it for something, so you know what it already does on its own.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { department: { type: 'string', enum: [...DEPARTMENT_KINDS], description: 'Whose charter; yours if left out' } },
      },
      confirm: false,
      async run(input, ctx) {
        const mine = departmentOfAgent(getLayout(), ctx.agentId);
        const dept = input.department || (mine ? mine.kind : null);
        if (!dept) return { ok: false, error: 'you belong to no department, so name one' };
        const c = api.get(dept);
        if (!c) return { ok: false, error: `the ${ZONE_LABELS[dept] || dept} has no charter` };
        return {
          ok: true,
          output: JSON.stringify({
            department: c.department,
            label: c.label,
            yours: Boolean(mine && mine.kind === dept),
            remit: c.remit,
            dailyCapUsd: typeof c.dailyCapUsd === 'number' ? c.dailyCapUsd : DEFAULT_DAILY_CAP_USD,
            spentTodayUsd: c.spentTodayUsd,
            folder: `_teams/${dept}/`,
            duties: (c.duties || []).map((d) => ({ id: d.id, title: d.title, schedule: d.schedule, budgetUsd: d.budgetUsd, enabled: d.enabled !== false })),
          }),
        };
      },
    },
  };

  return api;
}
