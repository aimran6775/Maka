// The portfolio (D182): every business the park runs, and the one place a new one can
// start — the owner's word at the Entrance Gate.
//
//   createPortfolio({ bus, store, gateQueue, clock, onApproved, ceilingUsd, log })
//     -> { init(), tools, list(), get(id), propose(spec), decide(id, d), pause(id),
//          resume(id), stop(id, reason), state() }
//
// The park used to run one mission with one plan and one budget, so "a venture" was a line
// item inside whatever the Chief last submitted and there was no way to have two businesses
// with separate money. A venture is now a record of its own:
//
//   proposed  the park wants to run it; a 'venture' item is waiting at the Gate
//   active    the owner approved it, with the budget they approved
//   paused    stopped for now, its budget intact
//   stopped   finished or abandoned
//   declined  the owner said no
//
// Nothing starts itself. `propose()` raises the Gate item and returns at once — the
// proposing run does not park, because a business decision can sit for hours (D37) and a
// Ranger should not hold a slot waiting for it. When the decision lands, the venture
// becomes active and `onApproved` is called so the Chief can staff and start it.
//
// The budget is the owner's to set: `askUsd` is what the park asked for, `budgetUsd` is
// what the owner granted, and they are kept apart so the record shows both. `ceilingUsd`
// caps the committed total across every active venture, so a hundred approvals cannot add
// up to more than the park is allowed to spend.

import { randomUUID } from 'node:crypto';
import { makeEvent, VENTURE_STATUSES } from '../shared/events.js';
import { validate } from '../shared/schema.js';

export const DEFAULT_CEILING_USD = 100;
export const MAX_VENTURES = 500;

// What a Ranger must say to propose a business. Deliberately demanding: a proposal the
// owner is meant to decide on is worthless without the numbers and where they came from.
export const PROPOSAL_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name', 'thesis', 'askUsd', 'firstSteps'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 80, description: 'What the business is called' },
    thesis: { type: 'string', minLength: 40, maxLength: 4000, description: 'What it sells, to whom, why it can work, and what you are not sure about' },
    askUsd: { type: 'number', minimum: 0, maximum: 10000, description: 'The model-spend budget you are asking the owner to commit to it' },
    firstSteps: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 4, maxLength: 400 }, description: 'What the park does first if the owner says yes' },
    briefId: { type: 'string', maxLength: 200, description: 'The Scout brief under outbox/briefs/ this rests on, if any' },
    monthlyRevenueUsd: { type: 'number', minimum: 0, description: 'First-month revenue estimate, if you have one' },
    contributionPerOrderUsd: { type: 'number', description: 'Contribution per order, if you have one' },
    risks: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 4, maxLength: 400 } },
    evidence: {
      type: 'array',
      maxItems: 20,
      items: { type: 'object', required: ['kind', 'text'], additionalProperties: false, properties: { kind: { type: 'string', minLength: 1 }, text: { type: 'string' }, ref: { type: 'string' } } },
      description: 'What backs the numbers: a source URL per figure, a file you wrote, a connector reading',
    },
  },
});

const DECISIONS = Object.freeze(['approve', 'decline']);

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const slug = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'venture';

export function createPortfolio({
  bus,
  store,
  gateQueue = null,
  clock = { now: () => Date.now() },
  // Called when the owner approves, so the Chief can staff and start the business. Kept as
  // an injected edge: the portfolio records the decision, it does not do the work.
  onApproved = null,
  ceilingUsd = DEFAULT_CEILING_USD,
  log = console,
} = {}) {
  if (!bus || !store) throw new TypeError('createPortfolio needs bus and store');
  let data = { version: 1, ventures: [] };

  const emit = (payload) => bus.emit(makeEvent('venture.updated', payload, { ts: clock.now() }));
  const save = () => store.savePortfolio(data);
  const byId = (id) => data.ventures.find((v) => v.id === id) || null;
  const view = (v) => ({ ...v });

  // The money already committed: what every active or paused venture may still spend.
  function committedUsd() {
    return data.ventures.filter((v) => v.status === 'active' || v.status === 'paused').reduce((n, v) => n + (v.budgetUsd || 0), 0);
  }

  function uniqueId(name) {
    const base = slug(name);
    if (!byId(base)) return base;
    for (let n = 2; n < 1000; n++) if (!byId(`${base}-${n}`)) return `${base}-${n}`;
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  // The card the owner reads. A proposal they cannot judge from the card alone is a
  // proposal that will be approved on trust, which is the thing to avoid.
  function cardFor(v) {
    const lines = [
      v.thesis,
      '',
      `Asking for: $${Number(v.askUsd).toFixed(2)} of model spend.`,
      `Already committed across the portfolio: $${committedUsd().toFixed(2)} of $${Number(ceilingUsd).toFixed(2)}.`,
      '',
      'First steps if you say yes:',
      ...v.firstSteps.map((s, i) => `  ${i + 1}. ${s}`),
    ];
    if (typeof v.monthlyRevenueUsd === 'number') lines.push('', `Estimated first month: $${v.monthlyRevenueUsd.toFixed(2)} revenue` + (typeof v.contributionPerOrderUsd === 'number' ? `, $${v.contributionPerOrderUsd.toFixed(2)} contribution per order` : ''));
    if (v.risks && v.risks.length) lines.push('', 'Risks it names:', ...v.risks.map((r) => `  · ${r}`));
    if (!v.evidence || !v.evidence.length) lines.push('', 'No evidence was attached, so none of the above is verified.');
    return lines.join('\n');
  }

  async function propose(spec = {}, { by = 'chief-ranger', runId = '' } = {}) {
    const v = validate(PROPOSAL_SCHEMA, spec);
    if (!v.ok) throw fail('BAD_REQUEST', `the proposal is incomplete: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    if (data.ventures.length >= MAX_VENTURES) throw fail('TOO_MANY', `the portfolio holds ${MAX_VENTURES} ventures; stop one before proposing another`);
    // Checked when it is proposed and again when it is approved: the owner may sit on a
    // card for hours, and other ventures may be approved in between.
    const room = Number(ceilingUsd) - committedUsd();
    if (spec.askUsd > room + 1e-9) {
      throw fail('OVER_CEILING', `the portfolio has $${room.toFixed(2)} of its $${Number(ceilingUsd).toFixed(2)} ceiling left and this asks for $${Number(spec.askUsd).toFixed(2)}; propose less, or ask the owner to stop a venture or raise the ceiling`);
    }
    if (!gateQueue || typeof gateQueue.submit !== 'function') throw fail('GATE_UNAVAILABLE', 'a venture needs the owner at the Entrance Gate and no Gate queue is available');

    const venture = {
      id: uniqueId(spec.name),
      name: String(spec.name),
      thesis: String(spec.thesis),
      status: 'proposed',
      askUsd: Number(spec.askUsd),
      budgetUsd: 0,
      spentUsd: 0,
      firstSteps: [...spec.firstSteps],
      ...(spec.briefId ? { briefId: String(spec.briefId) } : {}),
      ...(typeof spec.monthlyRevenueUsd === 'number' ? { monthlyRevenueUsd: spec.monthlyRevenueUsd } : {}),
      ...(typeof spec.contributionPerOrderUsd === 'number' ? { contributionPerOrderUsd: spec.contributionPerOrderUsd } : {}),
      ...(spec.risks && spec.risks.length ? { risks: [...spec.risks] } : {}),
      evidence: spec.evidence ? spec.evidence.map((e) => ({ ...e })) : [],
      proposedBy: by,
      proposedAt: clock.now(),
      history: [],
    };
    data.ventures.push(venture);
    await save();

    // The portfolio names the Gate item so it knows the id before the decision lands —
    // `submit` honours an id the caller supplies and only invents one when it has to.
    const itemId = `venture-${randomUUID().slice(0, 8)}`;
    const item = {
      itemId,
      agentId: by,
      kind: 'venture',
      domain: 'account_creation',
      tool: 'venture.propose',
      summary: `start a business: ${venture.name} — $${venture.askUsd.toFixed(2)} asked`,
      amountUsd: venture.askUsd,
      evidence: [{ kind: 'proposal', text: cardFor(venture), ref: venture.id }, ...venture.evidence],
      reason: 'Nothing starts without your word: approving this commits the budget and the park begins work on it.',
      ...(runId ? { runId } : {}),
    };
    venture.itemId = itemId;
    await save();
    emit({ ventureId: venture.id, change: 'proposed', status: 'proposed', name: venture.name, thesis: venture.thesis.slice(0, 1000), askUsd: venture.askUsd, by, itemId, ...(venture.briefId ? { briefId: venture.briefId } : {}), ...(runId ? { runId } : {}), evidence: venture.evidence });

    // The proposing run does not wait: a business decision can sit for hours, and parking
    // a Ranger on it would hold a run slot for nothing. The decision is picked up here.
    Promise.resolve(gateQueue.submit(item))
      .then((decision) => settle(venture.id, decision))
      .catch((err) => log.error(`venture ${venture.id}: the Gate decision failed:`, err));
    return view(venture);
  }

  // The owner's decision came back from the Gate. 'approve' starts the business; anything
  // else declines it, with the notes kept as the reason.
  async function settle(id, decision = {}) {
    const venture = byId(id);
    if (!venture || venture.status !== 'proposed') return null;
    const yes = decision && decision.decision === 'approve';
    const notes = String((decision && decision.notes) || '').slice(0, 1000);
    if (!yes) {
      venture.status = 'declined';
      venture.decidedAt = clock.now();
      if (notes) venture.reason = notes;
      venture.history.push({ change: 'declined', at: venture.decidedAt, reason: notes });
      await save();
      emit({ ventureId: id, change: 'declined', status: 'declined', name: venture.name, by: 'superintendent', reason: notes });
      return view(venture);
    }
    // Re-check the ceiling: other ventures may have been approved while this card waited.
    const room = Number(ceilingUsd) - committedUsd();
    if (venture.askUsd > room + 1e-9) {
      venture.status = 'declined';
      venture.decidedAt = clock.now();
      venture.reason = `approved, but the portfolio had only $${room.toFixed(2)} left of its $${Number(ceilingUsd).toFixed(2)} ceiling by then`;
      venture.history.push({ change: 'declined', at: venture.decidedAt, reason: venture.reason });
      await save();
      emit({ ventureId: id, change: 'declined', status: 'declined', name: venture.name, by: 'superintendent', reason: venture.reason });
      return view(venture);
    }
    venture.status = 'active';
    venture.budgetUsd = venture.askUsd;
    venture.decidedAt = clock.now();
    venture.startedAt = venture.decidedAt;
    if (notes) venture.reason = notes;
    venture.history.push({ change: 'approved', at: venture.decidedAt, budgetUsd: venture.budgetUsd, reason: notes });
    await save();
    emit({ ventureId: id, change: 'approved', status: 'active', name: venture.name, budgetUsd: venture.budgetUsd, askUsd: venture.askUsd, by: 'superintendent', reason: notes, evidence: venture.evidence });
    // Approval is what starts it. The portfolio records the decision; the Chief does the work.
    if (typeof onApproved === 'function') {
      try {
        await onApproved(view(venture));
      } catch (err) {
        log.error(`venture ${id} was approved but could not be started:`, err);
      }
    }
    return view(venture);
  }

  async function transition(id, change, { status, reason = '', by = 'superintendent' } = {}) {
    const venture = byId(id);
    if (!venture) throw fail('NOT_FOUND', `no venture "${id}"`, 404);
    venture.status = status;
    venture.history.push({ change, at: clock.now(), reason });
    if (reason) venture.reason = reason;
    if (status === 'stopped') venture.stoppedAt = clock.now();
    await save();
    emit({ ventureId: id, change, status, name: venture.name, budgetUsd: venture.budgetUsd, spentUsd: venture.spentUsd, by, reason });
    return view(venture);
  }

  const api = {
    tools: {},
    list: () => data.ventures.map(view),
    get: (id) => (byId(id) ? view(byId(id)) : null),
    active: () => data.ventures.filter((v) => v.status === 'active').map(view),
    propose,
    settle,
    ceilingUsd: () => Number(ceilingUsd),
    committedUsd,
    async pause(id, reason = '') {
      const v = byId(id);
      if (!v) throw fail('NOT_FOUND', `no venture "${id}"`, 404);
      if (v.status !== 'active') throw fail('CONFLICT', `${id} is ${v.status}, not active`, 409);
      return transition(id, 'paused', { status: 'paused', reason });
    },
    async resume(id, reason = '') {
      const v = byId(id);
      if (!v) throw fail('NOT_FOUND', `no venture "${id}"`, 404);
      if (v.status !== 'paused') throw fail('CONFLICT', `${id} is ${v.status}, not paused`, 409);
      return transition(id, 'resumed', { status: 'active', reason });
    },
    async stop(id, reason = '') {
      const v = byId(id);
      if (!v) throw fail('NOT_FOUND', `no venture "${id}"`, 404);
      if (v.status === 'stopped') return view(v);
      return transition(id, 'stopped', { status: 'stopped', reason });
    },
    state() {
      const counts = {};
      for (const s of VENTURE_STATUSES) counts[s] = data.ventures.filter((v) => v.status === s).length;
      return {
        ventures: data.ventures.length,
        counts,
        committedUsd: committedUsd(),
        ceilingUsd: Number(ceilingUsd),
        spentUsd: data.ventures.reduce((n, v) => n + (v.spentUsd || 0), 0),
      };
    },
    async init() {
      const loaded = await store.loadPortfolio(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.ventures)) data = loaded;
      // A venture left 'proposed' by a restart has no live resolver at the Gate, so its
      // card is gone. Say so rather than leaving it waiting on a decision that can never
      // arrive; the park can propose it again.
      let stale = 0;
      for (const v of data.ventures) {
        if (v.status !== 'proposed') continue;
        v.status = 'declined';
        v.reason = 'the park restarted while this was waiting at the Gate; propose it again';
        v.history.push({ change: 'declined', at: clock.now(), reason: v.reason });
        stale += 1;
      }
      if (stale) {
        await save();
        log.info(`  portfolio: ${stale} venture(s) were waiting at the Gate when the park stopped; they need proposing again`);
      }
      return api;
    },
  };

  // Tools. Proposing is a Ranger's and the Chief's; reading the portfolio is anyone's who
  // is granted it, because a department cannot plan around businesses it cannot see.
  api.tools = {
    'venture.propose': {
      name: 'venture.propose',
      description:
        'Propose a business for the owner to approve. They see your thesis, the budget you are asking for, the first steps and your evidence, and nothing starts until they say yes — so write it as something they can decide on without asking you a question. Returns at once with the venture id; the owner may take hours. Check it later with venture.list.',
      inputSchema: PROPOSAL_SCHEMA,
      confirm: false,
      summarize: (input) => `propose the business "${String(input.name).slice(0, 60)}" for $${Number(input.askUsd).toFixed(2)}`,
      async run(input, ctx) {
        try {
          const v = await propose(input, { by: ctx.agentId, runId: ctx.runId || '' });
          return { ok: true, output: JSON.stringify({ ventureId: v.id, status: v.status, askUsd: v.askUsd, waitingFor: 'the owner at the Entrance Gate' }) };
        } catch (err) {
          return { ok: false, code: err.code || 'PROPOSE_FAILED', error: err.message };
        }
      },
    },
    'venture.list': {
      name: 'venture.list',
      description: 'The park\'s portfolio: every business, its status (proposed, active, paused, stopped, declined), the budget the owner approved and what it has spent. Read this before proposing another, so you know what the park is already running and how much of its ceiling is committed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { type: 'string', enum: [...VENTURE_STATUSES], description: 'Only ventures in this state' } },
      },
      confirm: false,
      async run(input) {
        const rows = data.ventures
          .filter((v) => !input.status || v.status === input.status)
          .map((v) => ({ id: v.id, name: v.name, status: v.status, budgetUsd: v.budgetUsd, spentUsd: v.spentUsd, askUsd: v.askUsd, thesis: v.thesis.slice(0, 300) }));
        return { ok: true, output: JSON.stringify({ ...api.state(), ventures: rows }) };
      },
    },
  };

  return api;
}
