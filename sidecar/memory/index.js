// Ranger memory (phase 4 step 11).
//
//   createMemory({ store, bus, agents, getLayout, judge, clock, caps, log })
//     -> { init(), tools, itemsFor(agentId), recallFor(...), promptLines(agent, { prompt, runId }),
//          write(...), forget(id, { by }), feedback(id, { vote, by }), list({ agentId }), get(id),
//          summary(), state() }
//
// A memory item is { id, scope: agent | venture | station, owner, kind: fact | preference |
// procedure, text, tags, createdAt, by, runId, redactions, feedback: { up, down }, uses,
// lastUsedAt, forgotten }. A Ranger sees its own items, its venture's and its station's.
//
//   memory.recall  the tool: the top-k lexical matches for a query (recall.js), no domain
//   memory.write   the tool: the Ranger proposes an item; it is redacted first (redact.js:
//                  secrets and personal data never reach the disk) and stored only when the
//                  judge approves it (no judge, a judge at its cap or any other verdict means
//                  nothing is stored and the Ranger is told why, D142)
//   automatic recall: `promptLines(agent, { prompt })` puts the top matches for a run's brief
//                  into the run's system prompt (the run manager's systemExtras hook)
//   feedback       👍 / 👎 from the Superintendent on the Ranger card; a net −1 mutes the item
//                  (listed, never recalled); `forget` removes it for good
// Events (additive): memory.recall, memory.write, memory.forget, memory.feedback.

import { randomUUID } from 'node:crypto';
import { makeEvent } from '../../shared/events.js';
import { redact } from './redact.js';
import { recall, isMuted, netFeedback } from './recall.js';

export const MEMORY_SCOPES = Object.freeze(['agent', 'venture', 'station']);
export const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'procedure']);
export const DEFAULT_CAPS = Object.freeze({ perOwner: 300, total: 3000, textMax: 600, autoRecall: 5 });

export const WRITE_REVIEW_SCOPE = [
  'SCOPE: the worker proposes to store a memory item for future runs (shown below as it would be stored, already redacted).',
  'Approve only if ALL hold: (1) it is a durable fact, preference or procedure that will help a later run, not a one-off status or a result claim; (2) it is true as far as this run shows, not speculation; (3) it carries no secret and no personal data (a key, a password, a token, an email address, a phone number, a card number, a street address or a person\'s private details are a reject even if partly redacted); (4) it is specific enough to act on.',
  'Otherwise revise with what to change, or reject.',
].join(' ');

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const clean = (item) => {
  const { _terms, ...rest } = item;
  return rest;
};

export function createMemory({ store, bus, agents, getLayout, judge = null, clock = { now: () => Date.now() }, caps = {}, log = console } = {}) {
  if (!store || !bus || !agents || typeof getLayout !== 'function') throw new TypeError('createMemory needs store, bus, agents and getLayout');
  const limits = { ...DEFAULT_CAPS, ...caps };
  let data = { version: 1, items: [] };
  let saving = Promise.resolve();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const save = () => {
    saving = saving.then(() => store.saveMemory({ version: 1, items: data.items.map(clean) })).catch((err) => log.error('memory save failed:', err));
    return saving;
  };

  function agentOf(agentId) {
    return agents.get(agentId) || getLayout().agents.find((a) => a.id === agentId) || null;
  }
  // The owners an agent reads: itself, its venture, its station (zone).
  function ownersFor(agentId) {
    const a = agentOf(agentId);
    if (!a) return [];
    const out = [{ scope: 'agent', owner: agentId }];
    if (a.venture) out.push({ scope: 'venture', owner: a.venture });
    if (a.roomId) out.push({ scope: 'station', owner: a.roomId });
    return out;
  }
  function itemsFor(agentId) {
    const owners = ownersFor(agentId);
    return data.items.filter((it) => !it.forgotten && owners.some((o) => o.scope === it.scope && o.owner === it.owner));
  }
  const byId = (id) => data.items.find((it) => it.id === id) || null;

  // A tool call is always an event (the Ranger asked); an automatic recall is an event only
  // when it found something, so a park with no memory emits nothing on every run.
  function recallFor({ agentId, query, k = limits.autoRecall, runId = null, automatic = false, turn = 0 }) {
    const rows = recall(itemsFor(agentId), query, { k, now: clock.now() });
    for (const r of rows) {
      r.item.uses = (r.item.uses || 0) + 1;
      r.item.lastUsedAt = clock.now();
    }
    if (rows.length) save();
    if (rows.length || !automatic) emit('memory.recall', { agentId, runId: runId || '', query: String(query).slice(0, 300), count: rows.length, itemIds: rows.map((r) => r.item.id), automatic, turn });
    return rows.map((r) => ({ ...clean(r.item), score: Number(r.score.toFixed(3)), matched: r.matched }));
  }

  // Automatic recall into a run's system prompt: the top matches for the brief.
  function promptLines(agent, { prompt = '', runId = null } = {}) {
    if (!agent || !agent.id || !String(prompt || '').trim()) return [];
    const rows = recallFor({ agentId: agent.id, query: prompt, k: limits.autoRecall, runId, automatic: true });
    if (!rows.length) return [];
    return [`Memory recalled for this brief (${rows.length} item(s) you or your crew stored earlier; verify before acting on them): ${rows.map((r) => `[${r.kind}, ${r.scope}] ${r.text}`).join(' | ')}`];
  }

  async function write({ agentId, scope, kind, text, tags = [], runId = null, turn = 0, by = null, brief = '' }) {
    if (!MEMORY_SCOPES.includes(scope)) throw fail('BAD_SCOPE', `scope must be one of ${MEMORY_SCOPES.join(', ')}`);
    if (!MEMORY_KINDS.includes(kind)) throw fail('BAD_KIND', `kind must be one of ${MEMORY_KINDS.join(', ')}`);
    const a = agentOf(agentId);
    if (!a) throw fail('NO_AGENT', `no agent ${agentId}`, 404);
    const owner = scope === 'agent' ? agentId : scope === 'venture' ? a.venture : a.roomId;
    if (!owner) throw fail('NO_OWNER', scope === 'venture' ? 'this Ranger serves no venture: use scope agent or station' : 'this Ranger has no station');
    const raw = String(text || '').trim();
    if (!raw) throw fail('EMPTY', 'nothing to remember');
    if (raw.length > limits.textMax) throw fail('TOO_LONG', `a memory item is at most ${limits.textMax} characters; split it`);
    const red = redact(raw);
    const cleanTags = [...new Set((Array.isArray(tags) ? tags : []).map((t) => redact(String(t)).text.toLowerCase().trim().slice(0, 40)).filter(Boolean))].slice(0, 8);
    const refuse = (reason, extra = {}) => {
      emit('memory.write', { agentId, scope, owner, kind, status: 'refused', reason, redactions: red.redactions.reduce((n, r) => n + r.count, 0), runId: runId || '', ...extra });
      return { stored: false, reason, redactions: red.redactions, text: red.text };
    };
    const owned = data.items.filter((it) => !it.forgotten && it.scope === scope && it.owner === owner).length;
    if (owned >= limits.perOwner) return refuse(`memory full for ${scope} ${owner}: ${limits.perOwner} item(s); the Superintendent forgets items on the Ranger card`);
    if (data.items.filter((it) => !it.forgotten).length >= limits.total) return refuse(`the park's memory is full (${limits.total} items)`);
    if (data.items.some((it) => !it.forgotten && it.scope === scope && it.owner === owner && it.text === red.text)) return refuse('an identical item is already stored');
    // The judge decides. No judge, a judge at its cap, a failed call: nothing is stored (D142).
    if (!judge || typeof judge.reviewDocument !== 'function') return refuse('no judge is wired: memory is written only when the judge accepts it');
    let review;
    try {
      review = await judge.reviewDocument({ runId: runId || 'none', agentId, turn, tool: 'memory.write', title: 'memory item', text: `Scope: ${scope} (${owner}) · kind: ${kind} · tags: ${cleanTags.join(', ') || 'none'}${red.redactions.length ? ` · redacted before review: ${red.redactions.map((r) => `${r.count} ${r.kind}`).join(', ')}` : ''}\n\n${red.text}`, brief, scope: WRITE_REVIEW_SCOPE });
    } catch (err) {
      review = { verdict: 'skipped', reason: `judge failed: ${err.message}` };
    }
    if (review.verdict !== 'approve') return refuse(review.verdict === 'skipped' ? `the judge could not review it (${review.reason}); nothing stored` : `the judge said ${review.verdict}${review.notes ? `: ${review.notes}` : ''}`, { verdict: review.verdict });
    const item = { id: `mem-${randomUUID().slice(0, 8)}`, scope, owner, kind, text: red.text, tags: cleanTags, createdAt: clock.now(), by: by || agentId, agentId, runId: runId || null, redactions: red.redactions, feedback: { up: 0, down: 0 }, uses: 0, lastUsedAt: null, forgotten: false, judge: { verdict: review.verdict, notes: review.notes || null } };
    data.items.push(item);
    await save();
    emit('memory.write', { memoryId: item.id, agentId, scope, owner, kind, status: 'stored', redactions: red.redactions.reduce((n, r) => n + r.count, 0), runId: runId || '', verdict: 'approve', text: red.text.slice(0, 300) });
    return { stored: true, item: clean(item), redactions: red.redactions };
  }

  async function forget(id, { by = 'superintendent' } = {}) {
    const item = byId(id);
    if (!item || item.forgotten) throw fail('NOT_FOUND', `no memory item ${id}`, 404);
    item.forgotten = true;
    item.forgottenAt = clock.now();
    item.forgottenBy = by;
    await save();
    emit('memory.forget', { memoryId: id, agentId: item.agentId || '', scope: item.scope, owner: item.owner, by });
    return clean(item);
  }

  async function feedback(id, { vote, by = 'superintendent' } = {}) {
    if (!['up', 'down'].includes(vote)) throw fail('BAD_REQUEST', 'vote is up or down');
    const item = byId(id);
    if (!item || item.forgotten) throw fail('NOT_FOUND', `no memory item ${id}`, 404);
    item.feedback[vote] += 1;
    await save();
    emit('memory.feedback', { memoryId: id, agentId: item.agentId || '', vote, by, up: item.feedback.up, down: item.feedback.down, muted: isMuted(item) });
    return { ...clean(item), muted: isMuted(item), net: netFeedback(item) };
  }

  const tools = Object.freeze({
    'memory.recall': {
      name: 'memory.recall',
      description: 'Recall what you, your venture or your station stored earlier: the best lexical matches for a query (facts, preferences, procedures). The most relevant items for your brief are already in your context; use this for anything else.',
      inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, k: { type: 'integer', minimum: 1, maximum: 20 } } },
      confirm: false,
      summarize: (input) => `recall memory about "${input.query.slice(0, 60)}"`,
      async run(input, ctx) {
        if (!ctx.agentId) return { ok: false, error: 'no agent in this run' };
        const rows = recallFor({ agentId: ctx.agentId, query: input.query, k: input.k || 5, runId: ctx.runId || null, turn: ctx.turn || 0 });
        return { ok: true, output: JSON.stringify({ count: rows.length, items: rows.map((r) => ({ id: r.id, scope: r.scope, kind: r.kind, text: r.text, tags: r.tags, createdAt: new Date(r.createdAt).toISOString(), score: r.score })) }) + (rows.length ? '' : '\nNothing stored matches; proceed from the brief.') };
      },
    },
    'memory.write': {
      name: 'memory.write',
      description: 'Propose a memory item for future runs: a fact, a preference or a procedure, with a scope (agent: only you; venture: every Ranger of your venture; station: every Ranger of your camp). Secrets and personal data are removed before storage and the judge must accept the item; a refusal says why. Keep it short, specific and true.',
      inputSchema: { type: 'object', required: ['scope', 'kind', 'text'], additionalProperties: false, properties: { scope: { type: 'string', enum: [...MEMORY_SCOPES] }, kind: { type: 'string', enum: [...MEMORY_KINDS] }, text: { type: 'string', minLength: 1, maxLength: 600 }, tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 40 } } } },
      confirm: false,
      summarize: (input) => `remember (${input.scope}, ${input.kind}): ${input.text.slice(0, 60)}`,
      async run(input, ctx) {
        if (!ctx.agentId) return { ok: false, error: 'no agent in this run' };
        try {
          const r = await write({ agentId: ctx.agentId, scope: input.scope, kind: input.kind, text: input.text, tags: input.tags || [], runId: ctx.runId || null, turn: ctx.turn || 0, by: ctx.agentId, brief: ctx.brief || '' });
          const redactedNote = r.redactions.length ? ` Removed before storage: ${r.redactions.map((x) => `${x.count} ${x.kind}`).join(', ')}.` : '';
          if (!r.stored) return { ok: false, code: 'MEMORY_REFUSED', error: `not stored: ${r.reason}.${redactedNote}` };
          return { ok: true, output: JSON.stringify({ id: r.item.id, scope: r.item.scope, kind: r.item.kind, text: r.item.text, redactions: r.redactions }) + `\nStored.${redactedNote}` };
        } catch (err) {
          return { ok: false, code: err.code || 'MEMORY_FAILED', error: err.message };
        }
      },
    },
  });

  return {
    tools,
    async init() {
      const loaded = await store.loadMemory(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.items)) data = { version: 1, items: loaded.items.map((it) => ({ ...it, feedback: it.feedback || { up: 0, down: 0 } })) };
      return this;
    },
    itemsFor: (agentId) => itemsFor(agentId).map((it) => ({ ...clean(it), muted: isMuted(it), net: netFeedback(it) })),
    recallFor,
    promptLines,
    write,
    forget,
    feedback,
    list: ({ agentId = null, includeForgotten = false } = {}) => (agentId ? itemsFor(agentId) : data.items.filter((it) => includeForgotten || !it.forgotten)).map((it) => ({ ...clean(it), muted: isMuted(it), net: netFeedback(it) })).sort((a, b) => b.createdAt - a.createdAt),
    get: (id) => {
      const it = byId(id);
      return it && !it.forgotten ? { ...clean(it), muted: isMuted(it), net: netFeedback(it) } : null;
    },
    summary() {
      const live = data.items.filter((it) => !it.forgotten);
      return { items: live.length, muted: live.filter(isMuted).length, byScope: Object.fromEntries(MEMORY_SCOPES.map((s) => [s, live.filter((it) => it.scope === s).length])), byKind: Object.fromEntries(MEMORY_KINDS.map((k) => [k, live.filter((it) => it.kind === k).length])), judge: Boolean(judge), caps: limits };
    },
    state: () => data,
    flushed: () => saving,
  };
}
