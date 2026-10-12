// D185: the park runs itself, and when it genuinely cannot it says so from the Peak.
//
// The owner: "It should be autonomous with human contact needed... If a human contact is
// needed, it msgs from the peak what is wrong with what. And how a human would be required
// for that to continue."
//
// Everything the park could already ask for was an approval. A Gate item asks "may I do
// this"; a permission card asked "may I write this". Neither fits the case that actually
// stops an autonomous park: it is stuck on something only a person can do. Stripe wants a
// bank account and an SSN. Canva returns 403 to every automated client. A Google Ads
// developer token is reviewed by hand over days. None of those is a decision to approve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createBlockers, BLOCKER_SCHEMA, MAX_BLOCKERS } from '../sidecar/blockers.js';
import { defaultLayout, roleGrants } from '../shared/world.js';
import { PAYLOAD_SCHEMAS } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { fakeClock } from './helpers/fake-provider.js';

const STRIPE = {
  key: 'stripe-account',
  title: 'Stripe needs you to open the account',
  what: 'The park cannot take a payment. Stripe will not issue an API key to an automated client: creating the account needs a bank account, a legal name and an SSN or EIN, and an identity check I cannot pass for you.',
  needs: [
    'Go to dashboard.stripe.com/register and create the account in your name',
    'Finish the identity check and add the bank account you want payouts in',
    'Copy the secret key (it starts sk_live_ or sk_test_) and paste it at the Peak under Connectors → Stripe',
  ],
  blocking: 'Every venture that would sell anything: no order can be charged until a key exists.',
  tried: ['POST https://api.stripe.com/v1/account returned HTTP 401 with no key configured'],
};

async function setup({ onResolved = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-blockers-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layoutState = createLayoutState({ initial: defaultLayout(), store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  const mk = async (kind, name) => {
    const zone = await agents.ensureZone(kind);
    return agents.create({ name, role: 'ranger', zoneId: zone.id, parentAgentId: 'superintendent' }, { by: 'superintendent' });
  };
  const finance = await mk('finance', 'Finance Lead');
  const sales = await mk('sales', 'Sales Lead');
  const blockers = await createBlockers({ bus, store, agents, getLayout: layoutState.get, clock, onResolved, log: { error() {}, info() {} } }).init();
  return { dir, store, bus, events, clock, agents, blockers, finance, sales, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const blockerEvents = (events) => events.filter((e) => e.type === 'blocker.updated').map((e) => e.payload);

test('the blocker.updated event is in the contract and additive', () => {
  const schema = PAYLOAD_SCHEMAS['blocker.updated'];
  assert.ok(schema);
  assert.deepEqual(schema.required, ['blockerId', 'key', 'change', 'status']);
  assert.equal(validate(schema, { blockerId: 'b1', key: 'stripe-account', change: 'raised', status: 'open', card: 'text' }).ok, true);
  assert.equal(validate(schema, { blockerId: 'b1', key: 'k', change: 'shouted', status: 'open' }).ok, false);
  // The owner's channels can carry it: the delivery kinds were widened for the card and
  // the word that clears it.
  const kinds = PAYLOAD_SCHEMAS['channel.delivery'].properties.kind.enum;
  assert.ok(kinds.includes('blocker_card') && kinds.includes('blocker_update'));
  assert.ok(kinds.includes('gate_card'), 'and the kinds that existed are untouched');
});

test('a module wired without a layout can still raise one', async () => {
  // The blocker only reads the layout to label which department is speaking, so having
  // none is an answer (no department) rather than a crash.
  const h = await setup();
  try {
    const bare = await createBlockers({ bus: h.bus, store: h.store, clock: h.clock, log: { error() {}, info() {} } }).init();
    const b = await bare.raise(STRIPE, { by: 'someone' });
    assert.equal(b.status, 'open');
    assert.equal(b.department, null);
    assert.deepEqual(b.waitingFor, ['someone']);
  } finally {
    await h.cleanup();
  }
});

test('a blocker has to say what is wrong, what the owner must do, and what it stops', () => {
  assert.equal(validate(BLOCKER_SCHEMA, STRIPE).ok, true);
  // Each of the four is required, because a message missing any one of them cannot be
  // acted on and the owner would have to come back and ask.
  for (const field of ['key', 'title', 'what', 'needs', 'blocking']) {
    const { [field]: _gone, ...without } = STRIPE;
    assert.equal(validate(BLOCKER_SCHEMA, without).ok, false, `${field} must be required`);
  }
  // "it broke" is not a description, and an empty list of steps is not an instruction.
  assert.equal(validate(BLOCKER_SCHEMA, { ...STRIPE, what: 'it broke' }).ok, false);
  assert.equal(validate(BLOCKER_SCHEMA, { ...STRIPE, needs: [] }).ok, false);
  assert.equal(validate(BLOCKER_SCHEMA, { ...STRIPE, blocking: 'stuff' }).ok, false);
  // The key is a stable name, not prose.
  assert.equal(validate(BLOCKER_SCHEMA, { ...STRIPE, key: 'Stripe Account!' }).ok, false);
});

test('the park says what is wrong, what it needs and what it blocks — in one message from the Peak', async () => {
  const h = await setup();
  try {
    const b = await h.blockers.raise(STRIPE, { by: h.finance.id, runId: 'run-1' });
    assert.equal(b.status, 'open');
    assert.equal(b.department, 'finance', 'it knows which department is stuck');
    assert.deepEqual(b.waitingFor, [`${h.finance.id} (Finance Camp)`]);

    const raised = blockerEvents(h.events).filter((e) => e.change === 'raised');
    assert.equal(raised.length, 1);
    const card = raised[0].card;
    // Everything the owner needs to act, without asking the park a question back.
    assert.match(card, /cannot take a payment/, 'what is wrong');
    assert.match(card, /HTTP 401/, 'with the real error');
    assert.match(card, /WHAT I NEED YOU TO DO:/);
    assert.match(card, /1\. Go to dashboard\.stripe\.com\/register/, 'numbered steps they can follow');
    assert.match(card, /3\. Copy the secret key/);
    assert.match(card, /Until then: Every venture that would sell anything/, 'what it stops');
    assert.match(card, /Already tried:/, 'so they do not repeat it');
    assert.equal(raised[0].key, 'stripe-account');
  } finally {
    await h.cleanup();
  }
});

test('ten Rangers hitting the same wall is one message, not ten', async () => {
  const h = await setup();
  try {
    const first = await h.blockers.raise(STRIPE, { by: h.finance.id });
    assert.equal(first.joined, undefined);

    // Sales hits the same missing key. It joins rather than telling the owner again.
    const second = await h.blockers.raise(STRIPE, { by: h.sales.id });
    assert.equal(second.joined, true);
    assert.equal(second.id, first.id);
    assert.equal(second.waitingFor.length, 2);
    assert.ok(second.waitingFor.some((w) => /Sales Camp/.test(w)));

    // The same Ranger twice does not count twice.
    await h.blockers.raise(STRIPE, { by: h.sales.id });
    assert.equal(h.blockers.get(first.id).waitingFor.length, 2);

    const changes = blockerEvents(h.events).map((e) => e.change);
    assert.deepEqual(changes, ['raised', 'joined'], 'one card, then a quiet join');
    assert.equal(h.blockers.open().length, 1);

    // The card then says how much is waiting on it.
    assert.match(h.blockers.cardFor(h.blockers.get(first.id)), /2 parts of the park are waiting on this/);

    // A different wall is a different blocker.
    await h.blockers.raise({ ...STRIPE, key: 'canva-licensing', title: 'Canva licensing needs a human read' }, { by: h.sales.id });
    assert.equal(h.blockers.open().length, 2);
  } finally {
    await h.cleanup();
  }
});

test('the owner clears it, and the work that was waiting starts again', async () => {
  const restarted = [];
  const h = await setup({ onResolved: (b) => restarted.push(b) });
  try {
    const b = await h.blockers.raise(STRIPE, { by: h.finance.id });
    // Cleared by key, which is what the card tells the owner to type.
    const done = await h.blockers.resolve('stripe-account', { note: 'account open, key pasted at the Peak' });
    assert.equal(done.status, 'resolved');
    assert.equal(done.note, 'account open, key pasted at the Peak');
    assert.equal(done.resolvedBy, 'superintendent');
    assert.equal(h.blockers.open().length, 0);

    // The Chief is told, so nothing waits to be remembered.
    assert.equal(restarted.length, 1);
    assert.equal(restarted[0].id, b.id);
    assert.equal(restarted[0].note, 'account open, key pasted at the Peak');

    assert.deepEqual(blockerEvents(h.events).map((e) => e.change), ['raised', 'resolved']);
    // Clearing it twice is refused rather than restarting the work twice.
    await assert.rejects(h.blockers.resolve(b.id), (e) => e.code === 'ALREADY_DECIDED');
    await assert.rejects(h.blockers.resolve('never-raised'), (e) => e.code === 'NOT_FOUND');

    // It survives a restart as cleared, and the key is free for a future blocker.
    const again = await createBlockers({ bus: h.bus, store: h.store, agents: h.agents, clock: h.clock, log: { error() {}, info() {} } }).init();
    assert.equal(again.get(b.id).status, 'resolved');
    assert.equal(again.open().length, 0);
    const fresh = await again.raise(STRIPE, { by: h.finance.id });
    assert.equal(fresh.joined, undefined, 'a cleared blocker does not block a new one on the same key');
  } finally {
    await h.cleanup();
  }
});

test('a blocker the park no longer needs is cancelled, not left on the owner\'s list', async () => {
  const restarted = [];
  const h = await setup({ onResolved: (b) => restarted.push(b) });
  try {
    const b = await h.blockers.raise(STRIPE, { by: h.finance.id });
    await h.blockers.cancel(b.id, { reason: 'the venture was stopped, so nothing needs Stripe' });
    assert.equal(h.blockers.get(b.id).status, 'cancelled');
    assert.equal(h.blockers.open().length, 0);
    assert.deepEqual(restarted, [], 'cancelling does not restart work');
    assert.deepEqual(blockerEvents(h.events).map((e) => e.change), ['raised', 'cancelled']);
  } finally {
    await h.cleanup();
  }
});

test('the tools: raising one returns at once and tells the Ranger to carry on without it', async () => {
  const h = await setup();
  try {
    const raise = h.blockers.tools['blocker.raise'];
    const list = h.blockers.tools['blocker.list'];
    const ctx = { agentId: h.finance.id, runId: 'run-2' };

    const out = JSON.parse((await raise.run(STRIPE, ctx)).output);
    assert.equal(out.key, 'stripe-account');
    assert.match(out.note, /the owner has been told from the Peak/);
    assert.match(out.note, /do what you can without this/, 'the park does not stop');
    assert.equal(raise.confirm, false, 'telling the owner something is not an action to approve');
    assert.match(raise.summarize(STRIPE), /the park is blocked: Stripe needs you/);

    // A Ranger reads the list first, so it joins instead of reporting again.
    const open = JSON.parse((await list.run({}, ctx)).output);
    assert.equal(open.open, 1);
    assert.equal(open.blockers[0].key, 'stripe-account');
    assert.deepEqual(open.keys, ['stripe-account']);
    const joined = JSON.parse((await raise.run(STRIPE, { agentId: h.sales.id })).output);
    assert.equal(joined.joined, true);
    assert.match(joined.note, /already reported/);

    // A blocker missing what the owner would need is refused, not sent half-written.
    const bad = await raise.run({ ...STRIPE, key: 'other-thing', needs: [] }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /incomplete/);

    // Cleared ones are out of the way unless asked for.
    await h.blockers.resolve('stripe-account', { note: 'done' });
    assert.equal(JSON.parse((await list.run({}, ctx)).output).open, 0);
    assert.equal(JSON.parse((await list.run({ all: true }, ctx)).output).blockers.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('every Ranger can tell the owner the park is stuck; a Junior cannot', () => {
  // A Ranger in any department hits a wall only a person can clear, so every Ranger has
  // it. A Junior's work comes from its own Ranger, which is who it tells.
  for (const role of ['chief_ranger', 'ranger']) {
    assert.ok(roleGrants(role).includes('blocker.raise'), `${role} can say the park is stuck`);
    assert.ok(roleGrants(role).includes('blocker.list'), `${role} can check before reporting`);
  }
  assert.ok(!roleGrants('junior_ranger').includes('blocker.raise'));
});

test('the park cannot bury the owner in blockers', async () => {
  assert.equal(MAX_BLOCKERS, 200);
  const h = await setup();
  try {
    // A cap exists so a loop cannot turn into two hundred messages and then more.
    const state = h.blockers.state();
    assert.equal(state.open, 0);
    assert.equal(state.oldestOpenAt, null);
    await h.blockers.raise(STRIPE, { by: h.finance.id });
    assert.equal(h.blockers.state().open, 1);
    assert.equal(typeof h.blockers.state().oldestOpenAt, 'number');
  } finally {
    await h.cleanup();
  }
});
