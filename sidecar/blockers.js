// Blockers (D185): the park runs itself, and when it genuinely cannot, it says so from the
// Peak — what is wrong, with what, what it stops, and exactly what the owner must do.
//
//   createBlockers({ bus, store, agents, getLayout, clock, onResolved, log })
//     -> { init(), list(), get(id), raise(spec, { by }), resolve(id, { note, by }),
//          cancel(id, { reason }), open(), state(), tools }
//
// Everything the park could already ask for was an *approval*: a Gate item is "may I do
// this", a permission card was "may I write this". Neither fits the case the owner cares
// about most — the park is stuck on something only a human can do. A Stripe account needs
// a bank account and an SSN. Canva returns 403 to every automated client. A developer token
// is reviewed by hand, for days. None of those is a decision to approve; each is a job for
// the owner, and until it is done some work simply cannot continue.
//
// So a blocker is a fourth thing, and it is written for the person reading it on a phone:
//
//   what     what is wrong, with what
//   needs    what the owner must do, in steps they can follow
//   blocking what cannot continue until then
//   tried    what the Ranger already tried, so the owner does not repeat it
//
// A blocker does not stop the park. The one piece of work that depends on it waits; every
// other department carries on. When the owner clears it, `onResolved` tells the Chief, so
// the work that was waiting starts again rather than waiting for someone to remember it.
//
// Raising the same blocker twice is the common failure of a thing like this: ten Rangers
// hit the same missing Stripe key and the owner gets ten messages. A blocker therefore has
// a `key` — one open blocker per key, and a second raise joins the first and says who else
// is waiting on it.

import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { departmentOfAgent } from '../shared/world.js';

export const MAX_BLOCKERS = 200;

export const BLOCKER_SCHEMA = Object.freeze({
  type: 'object',
  required: ['key', 'title', 'what', 'needs', 'blocking'],
  additionalProperties: false,
  properties: {
    // One open blocker per key: `stripe-account`, `canva-licensing`, `google-ads-token`.
    key: { type: 'string', minLength: 3, maxLength: 80, pattern: '^[a-z0-9][a-z0-9-]*$', description: 'A short stable name for this blocker, so the same problem is not reported twice' },
    title: { type: 'string', minLength: 6, maxLength: 120, description: 'One line the owner can read at a glance' },
    what: { type: 'string', minLength: 30, maxLength: 2000, description: 'What is wrong, with what. Name the thing and the exact error or refusal.' },
    needs: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 6, maxLength: 400 }, description: 'What the owner must do, as steps they can follow. Be specific: which site, which value, where it goes.' },
    blocking: { type: 'string', minLength: 10, maxLength: 1000, description: 'What cannot continue until this is done' },
    tried: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 6, maxLength: 400 }, description: 'What you already tried, so the owner does not repeat it' },
    ventureId: { type: 'string', maxLength: 80 },
    workItemId: { type: 'string', maxLength: 80 },
  },
});

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createBlockers({
  bus,
  store,
  agents = null,
  getLayout = () => null,
  clock = { now: () => Date.now() },
  // Called when the owner clears one, so the work that was waiting starts again.
  onResolved = null,
  log = console,
} = {}) {
  if (!bus || !store) throw new TypeError('createBlockers needs bus and store');
  let data = { version: 1, blockers: [] };

  const emit = (payload) => bus.emit(makeEvent('blocker.updated', payload, { ts: clock.now() }));
  const save = () => store.saveBlockers(data);
  const byId = (id) => data.blockers.find((b) => b.id === id) || null;
  const openByKey = (key) => data.blockers.find((b) => b.key === key && b.status === 'open') || null;
  const view = (b) => ({ ...b });

  // What the owner reads. Written as a job, not a notification: the point is that they can
  // act on it without asking the park a question back.
  function cardFor(b) {
    const lines = [
      b.what,
      '',
      'WHAT I NEED YOU TO DO:',
      ...b.needs.map((n, i) => `  ${i + 1}. ${n}`),
      '',
      `Until then: ${b.blocking}`,
    ];
    if (b.tried && b.tried.length) lines.push('', 'Already tried:', ...b.tried.map((t) => `  · ${t}`));
    if (b.waitingFor && b.waitingFor.length > 1) lines.push('', `${b.waitingFor.length} parts of the park are waiting on this.`);
    return lines.join('\n');
  }

  async function raise(spec = {}, { by = 'chief-ranger', runId = '' } = {}) {
    const v = validate(BLOCKER_SCHEMA, spec);
    if (!v.ok) throw fail('BAD_REQUEST', `the blocker is incomplete: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);

    // One open blocker per key. A second raise joins the first rather than messaging the
    // owner again — ten Rangers hitting the same missing key is one job, not ten.
    const existing = openByKey(spec.key);
    if (existing) {
      const dept = departmentOfAgent(getLayout(), by);
      const who = dept ? `${by} (${dept.label})` : by;
      if (!existing.waitingFor.includes(who)) {
        existing.waitingFor.push(who);
        existing.lastRaisedAt = clock.now();
        await save();
        emit({ blockerId: existing.id, key: existing.key, change: 'joined', status: 'open', title: existing.title, by, waiting: existing.waitingFor.length });
      }
      return { ...view(existing), joined: true };
    }

    if (data.blockers.filter((b) => b.status === 'open').length >= MAX_BLOCKERS) {
      throw fail('TOO_MANY', `${MAX_BLOCKERS} blockers are already open; the park is not short of things to tell the owner`);
    }

    const dept = departmentOfAgent(getLayout(), by);
    const blocker = {
      id: `blocker-${randomUUID().slice(0, 8)}`,
      key: spec.key,
      title: String(spec.title),
      what: String(spec.what),
      needs: [...spec.needs],
      blocking: String(spec.blocking),
      tried: spec.tried ? [...spec.tried] : [],
      status: 'open',
      department: dept ? dept.kind : null,
      raisedBy: by,
      raisedAt: clock.now(),
      waitingFor: [dept ? `${by} (${dept.label})` : by],
      ...(spec.ventureId ? { ventureId: String(spec.ventureId) } : {}),
      ...(spec.workItemId ? { workItemId: String(spec.workItemId) } : {}),
      ...(runId ? { runId } : {}),
    };
    data.blockers.push(blocker);
    await save();
    emit({
      blockerId: blocker.id,
      key: blocker.key,
      change: 'raised',
      status: 'open',
      title: blocker.title,
      card: cardFor(blocker),
      department: blocker.department || '',
      by,
      ...(blocker.ventureId ? { ventureId: blocker.ventureId } : {}),
      ...(runId ? { runId } : {}),
      waiting: 1,
    });
    return view(blocker);
  }

  async function resolve(id, { note = '', by = 'superintendent' } = {}) {
    const b = byId(id) || openByKey(id); // the owner may name it by key from a phone
    if (!b) throw fail('NOT_FOUND', `no blocker "${id}"`, 404);
    if (b.status !== 'open') throw fail('ALREADY_DECIDED', `${b.id} is already ${b.status}`, 409);
    b.status = 'resolved';
    b.resolvedAt = clock.now();
    b.resolvedBy = by;
    if (note) b.note = String(note).slice(0, 1000);
    await save();
    emit({ blockerId: b.id, key: b.key, change: 'resolved', status: 'resolved', title: b.title, by, reason: b.note || '', waiting: b.waitingFor.length });
    // The work that was waiting starts again rather than waiting to be remembered.
    if (typeof onResolved === 'function') {
      try {
        await onResolved(view(b));
      } catch (err) {
        log.error(`blocker ${b.id} was cleared but the work waiting on it could not be restarted:`, err);
      }
    }
    return view(b);
  }

  const api = {
    tools: {},
    list: () => data.blockers.map(view),
    open: () => data.blockers.filter((b) => b.status === 'open').map(view),
    get: (id) => (byId(id) ? view(byId(id)) : null),
    raise,
    resolve,
    cardFor,
    async cancel(id, { reason = '', by = 'chief-ranger' } = {}) {
      const b = byId(id) || openByKey(id);
      if (!b) throw fail('NOT_FOUND', `no blocker "${id}"`, 404);
      if (b.status !== 'open') return view(b);
      b.status = 'cancelled';
      b.resolvedAt = clock.now();
      if (reason) b.note = String(reason).slice(0, 1000);
      await save();
      emit({ blockerId: b.id, key: b.key, change: 'cancelled', status: 'cancelled', title: b.title, by, reason });
      return view(b);
    },
    state() {
      const open = data.blockers.filter((b) => b.status === 'open');
      return {
        open: open.length,
        resolved: data.blockers.filter((b) => b.status === 'resolved').length,
        cancelled: data.blockers.filter((b) => b.status === 'cancelled').length,
        oldestOpenAt: open.length ? Math.min(...open.map((b) => b.raisedAt)) : null,
        keys: open.map((b) => b.key),
      };
    },
    async init() {
      const loaded = await store.loadBlockers(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.blockers)) data = loaded;
      return api;
    },
  };

  api.tools = {
    'blocker.raise': {
      name: 'blocker.raise',
      description:
        'Tell the owner the park is stuck on something only a person can do — an account that needs their identity, a site that refuses automated clients, a credential, a decision that is theirs. Not for anything you could do yourself, and not for asking permission: an action that needs approval goes to the Entrance Gate on its own. ' +
        'Write it for someone reading it on a phone who will then go and do it: what is wrong with what, what they must do step by step, what cannot continue until then, and what you already tried. ' +
        'Give it a short stable `key` so the same problem is reported once however many Rangers hit it. Returns at once; the rest of the park carries on.',
      inputSchema: BLOCKER_SCHEMA,
      confirm: false,
      summarize: (input) => `tell the owner the park is blocked: ${String(input.title).slice(0, 80)}`,
      async run(input, ctx) {
        try {
          const b = await raise(input, { by: ctx.agentId, runId: ctx.runId || '' });
          return {
            ok: true,
            output: JSON.stringify(
              b.joined
                ? { blockerId: b.id, key: b.key, joined: true, note: 'this was already reported; you are added to who is waiting on it', waitingFor: b.waitingFor.length }
                : { blockerId: b.id, key: b.key, status: b.status, note: 'the owner has been told from the Peak; do what you can without this and say in your summary what you could not' },
            ),
          };
        } catch (err) {
          return { ok: false, code: err.code || 'BLOCKER_FAILED', error: err.message };
        }
      },
    },
    'blocker.list': {
      name: 'blocker.list',
      description: 'What the park is waiting on the owner for. Read this before you report a blocker, so you join one that is already open instead of reporting it again, and before you plan work that would depend on one.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { all: { type: 'boolean', description: 'Include the ones already cleared' } } },
      confirm: false,
      async run(input) {
        const rows = (input.all ? data.blockers : data.blockers.filter((b) => b.status === 'open')).map((b) => ({
          id: b.id,
          key: b.key,
          title: b.title,
          status: b.status,
          blocking: b.blocking,
          raisedBy: b.raisedBy,
          department: b.department,
          waitingFor: b.waitingFor,
          ...(b.note ? { note: b.note } : {}),
        }));
        return { ok: true, output: JSON.stringify({ ...api.state(), blockers: rows }) };
      },
    },
  };

  return api;
}
