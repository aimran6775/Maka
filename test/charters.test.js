// D184: what each department does without being asked.
//
// The owner: "Every department should have its own tasks and instructions. It should be
// fully autonomous company managing 100s of business on it own. 24/7."
//
// After D178 a department had a head and a persona, so it could answer what another
// department asked it — and nothing else. It never acted on its own. A charter is the
// other half: a standing remit the head carries into every run, and duties the scheduler
// hands it on a cadence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createStore } from '../sidecar/store.js';
import { createEventBus } from '../sidecar/bus.js';
import { createLayoutState } from '../sidecar/server.js';
import { createAgents } from '../sidecar/agents.js';
import { createScheduler, nextRunAt } from '../sidecar/scheduler.js';
import { createCharters, DEFAULT_CHARTERS, DUTY_SCHEMA, DEFAULT_DAILY_CAP_USD, MAX_DUTIES, JOB_PREFIX } from '../sidecar/charters.js';
import { DEPARTMENT_KINDS, defaultLayout } from '../shared/world.js';
import { PAYLOAD_SCHEMAS } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { fakeClock } from './helpers/fake-provider.js';

async function setup({ withHeads = true, judgeCap = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-charters-'));
  const store = createStore({ root: dir });
  await store.init();
  const bus = createEventBus();
  const events = [];
  bus.listen((e) => events.push(e));
  const clock = fakeClock();
  const layoutState = createLayoutState({ initial: defaultLayout(), store, bus, clock });
  const agents = createAgents({ layoutState, bus, clock });
  if (withHeads) {
    for (const kind of ['finance', 'research', 'legal']) {
      const zone = await agents.ensureZone(kind);
      const a = await agents.create({ name: `${kind} head`, role: 'ranger', zoneId: zone.id, parentAgentId: 'superintendent' }, { by: 'superintendent' });
      await agents.update(a.id, { head: true }, { by: 'superintendent' });
    }
  }
  const delegated = [];
  const trails = {
    delegate: async (spec, opts) => {
      const item = { id: `work-${delegated.length + 1}`, ...spec, ...opts, budgetUsd: spec.budgetUsd };
      delegated.push(item);
      return item;
    },
  };
  const scheduler = await createScheduler({ store, clock }).init();
  const charters = await createCharters({ bus, store, scheduler, trails, agents, getLayout: layoutState.get, judgeCap, clock, log: { error() {}, info() {} } }).init();
  return { dir, store, bus, events, clock, agents, trails, delegated, scheduler, charters, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

const dutyEvents = (events) => events.filter((e) => e.type === 'charter.duty').map((e) => e.payload);

test('the charter.duty event is in the contract and additive', () => {
  const schema = PAYLOAD_SCHEMAS['charter.duty'];
  assert.ok(schema);
  assert.deepEqual(schema.required, ['department', 'change']);
  assert.equal(validate(schema, { department: 'finance', change: 'ran', workItemId: 'w1', budgetUsd: 0.1 }).ok, true);
  assert.equal(validate(schema, { department: 'finance', change: 'skipped', reason: 'no head' }).ok, true);
  assert.equal(validate(schema, { department: 'finance', change: 'danced' }).ok, false);
});

test('every department is born with a remit and at least one standing duty', async () => {
  const h = await setup();
  try {
    // Ten departments, each with something to do: a park nobody has configured still works.
    for (const dept of DEPARTMENT_KINDS) {
      const c = h.charters.get(dept);
      assert.ok(c, `${dept} has no charter`);
      assert.ok(c.remit && c.remit.length > 40, `${dept} has no usable remit`);
      assert.ok((c.duties || []).length >= 1, `${dept} has no standing duty`);
      assert.equal(c.dailyCapUsd, DEFAULT_DAILY_CAP_USD, `${dept} has a daily cap`);
      for (const d of c.duties) {
        assert.equal(validate(DUTY_SCHEMA, d).ok, true, `${dept}/${d.id} is not a valid duty: ${JSON.stringify(validate(DUTY_SCHEMA, d).errors)}`);
        assert.ok(d.schedule.daily || d.schedule.everyMs, `${dept}/${d.id} has no cadence`);
        assert.ok(d.budgetUsd > 0 && d.budgetUsd <= 1, `${dept}/${d.id} should be a small standing cost, got ${d.budgetUsd}`);
      }
    }
    // Every duty is a read and a write-up. A duty runs while the owner is asleep, so none
    // of them may publish, send or spend outside the park — that is the Gate's.
    const allBriefs = Object.values(DEFAULT_CHARTERS).flatMap((c) => c.duties.map((d) => d.brief.toLowerCase()));
    for (const brief of allBriefs) {
      assert.match(brief, /write [^.]*_teams\//, 'every duty writes its finding into its own team folder');
    }
    // And each says so where it could be mistaken for acting.
    const marketing = DEFAULT_CHARTERS.marketing.duties[0].brief;
    assert.match(marketing, /change no budget or status/i);
    assert.match(DEFAULT_CHARTERS.operations_support.duties[0].brief, /send nothing/i);
    assert.match(DEFAULT_CHARTERS.people.duties[0].brief, /the Chief hires and retires/i);
    assert.match(DEFAULT_CHARTERS.business.duties[0].brief, /Recommend; do not act/i);

    // Each duty is on the scheduler under its own job.
    const jobs = Object.keys(h.scheduler.state()).filter((k) => k.startsWith(`${JOB_PREFIX}:`));
    assert.ok(jobs.length >= DEPARTMENT_KINDS.length, `every duty is scheduled, got ${jobs.length}`);
    assert.ok(jobs.includes(`${JOB_PREFIX}:finance:daily-books`));
  } finally {
    await h.cleanup();
  }
});

test('a duty falling due is handed to the department head, and the spend counts against the department', async () => {
  const h = await setup();
  try {
    const out = await h.charters.runNow('finance', 'daily-books');
    assert.equal(out.ran, true, out.reason);
    assert.equal(h.delegated.length, 1);
    const item = h.delegated[0];
    assert.match(item.toAgentId, /finance/, 'it went to the Finance head');
    assert.equal(item.by, 'superintendent', 'the park\'s own standing work, not one Ranger\'s errand');
    assert.equal(item.venture, null, 'a department\'s housekeeping is not a business\'s spend');
    assert.match(item.brief, /Standing duty "Daily books"/);
    assert.match(item.brief, /Nobody asked for this/);
    assert.match(item.brief, /_teams\/finance\//, 'and where its work belongs');
    // A duty is asked to date its report, and a model left to guess writes the wrong year:
    // the first live health check dated itself 2024.
    assert.match(item.brief, /Today is \d{4}-\d{2}-\d{2}\./, 'it is told the date');
    assert.match(item.brief, /not one you remember/);
    assert.match(item.brief, /never estimate a figure you cannot read/i, 'the duty\'s own instructions');

    const ran = dutyEvents(h.events).filter((e) => e.change === 'ran');
    assert.equal(ran.length, 1);
    assert.equal(ran[0].workItemId, 'work-1');
    assert.equal(ran[0].trigger, 'asked for');
    assert.equal(h.charters.get('finance').spentTodayUsd, 0.15);
    // Another department's cap is its own.
    assert.equal(h.charters.get('research').spentTodayUsd, 0);
  } finally {
    await h.cleanup();
  }
});

test('a duty that cannot run says why, every time', async () => {
  const h = await setup({ withHeads: false });
  try {
    // No camp at all.
    const unbuilt = await h.charters.runNow('sales', 'pipeline-review');
    assert.equal(unbuilt.ran, false);
    assert.match(unbuilt.reason, /has not been built yet/);

    // A camp with nobody heading it.
    await h.agents.ensureZone('finance');
    const headless = await h.charters.runNow('finance', 'daily-books');
    assert.equal(headless.ran, false);
    assert.match(headless.reason, /no head/);

    // Switched off, both ways round.
    const zone = await h.agents.ensureZone('legal');
    const head = await h.agents.create({ name: 'Legal', role: 'ranger', zoneId: zone.id, parentAgentId: 'superintendent' }, { by: 'superintendent' });
    await h.agents.update(head.id, { head: true }, { by: 'superintendent' });
    await h.charters.setDuty('legal', { ...DEFAULT_CHARTERS.legal.duties[0], enabled: false });
    const off = await h.charters.runNow('legal', 'claims-watch');
    assert.equal(off.ran, false);
    assert.match(off.reason, /switched off/);
    await h.charters.setDuty('legal', { ...DEFAULT_CHARTERS.legal.duties[0], enabled: true });
    await h.charters.setCharter('legal', { enabled: false });
    const whole = await h.charters.runNow('legal', 'claims-watch');
    assert.match(whole.reason, /charter is switched off/);

    // Each refusal is on the record: silence would read as work done.
    const skipped = dutyEvents(h.events).filter((e) => e.change === 'skipped');
    assert.equal(skipped.length, 4);
    for (const s of skipped) assert.ok(s.reason && s.reason.length > 5);
    assert.equal(h.delegated.length, 0, 'nothing was handed out');
  } finally {
    await h.cleanup();
  }
});

test('a department cannot spend past its day, and the park\'s own cap stops everything', async () => {
  const h = await setup();
  try {
    // A cap of 0.2 against a duty that costs 0.15: the first runs, the second does not.
    await h.charters.setCharter('finance', { dailyCapUsd: 0.2 });
    assert.equal((await h.charters.runNow('finance', 'daily-books')).ran, true);
    const second = await h.charters.runNow('finance', 'daily-books');
    assert.equal(second.ran, false);
    assert.match(second.reason, /spent \$0\.15 of its \$0\.20 for today/);
    assert.equal(h.delegated.length, 1);

    // Another department is unaffected by Finance's day.
    assert.equal((await h.charters.runNow('research', 'opportunity-sweep')).ran, true);

    // The park's own judge cap stops every department at once.
    const capped = await setup({ judgeCap: () => 'the park\'s judge daily cap is reached ($10.00 of $10)' });
    try {
      const out = await capped.charters.runNow('finance', 'daily-books');
      assert.equal(out.ran, false);
      assert.match(out.reason, /judge daily cap/);
      assert.equal(capped.delegated.length, 0);
    } finally {
      await capped.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test('the remit reaches the head\'s prompt, and a team member\'s too', async () => {
  const h = await setup();
  try {
    const head = h.agents.list().find((a) => a.zone && a.zone.kind === 'finance');
    const lines = h.charters.remitLines(head);
    assert.ok(lines.length >= 2);
    assert.match(lines[0], /Your department, the Finance Camp/);
    assert.match(lines[0], /books from real connector data only/);
    assert.match(lines[1], /You head it/);
    assert.match(lines[1], /requests other departments send here come to you/);
    assert.ok(lines.some((l) => /standing duties: Daily books/.test(l)));

    // A Ranger on the team gets the remit but is not told it heads anything.
    const zone = h.agents.list().find((a) => a.zone && a.zone.kind === 'finance').zone;
    const member = await h.agents.create({ name: 'Clerk', role: 'ranger', zoneId: zone.id, parentAgentId: 'superintendent' }, { by: 'superintendent' });
    const mine = h.charters.remitLines(h.agents.get(member.id));
    assert.equal(mine.length, 1);
    assert.match(mine[0], /Your department, the Finance Camp/);

    // The Chief belongs to no department, so it carries no remit.
    await h.agents.ensureChief();
    assert.deepEqual(h.charters.remitLines(h.agents.get('chief-ranger')), []);
    assert.deepEqual(h.charters.remitLines(null), []);
  } finally {
    await h.cleanup();
  }
});

test('charters are editable and survive a restart, and the owner\'s edits are never overwritten', async () => {
  const h = await setup();
  try {
    await h.charters.setCharter('finance', { remit: 'You count what the park actually earned.', dailyCapUsd: 5 });
    await h.charters.setDuty('finance', { id: 'weekly-close', title: 'Weekly close', brief: 'Close the week and write it to _teams/finance/close.md with every figure and its source.', schedule: { daily: '18:00' }, budgetUsd: 0.5 });
    const c = h.charters.get('finance');
    assert.equal(c.remit, 'You count what the park actually earned.');
    assert.equal(c.dailyCapUsd, 5);
    assert.equal(c.duties.length, 2);
    assert.ok(Object.keys(h.scheduler.state()).includes(`${JOB_PREFIX}:finance:weekly-close`));

    // Reloading keeps the edits and does not re-seed over them.
    const again = await createCharters({ bus: h.bus, store: h.store, scheduler: h.scheduler, trails: h.trails, agents: h.agents, getLayout: () => h.agents.layout(), clock: h.clock, log: { error() {}, info() {} } }).init();
    assert.equal(again.get('finance').remit, 'You count what the park actually earned.');
    assert.equal(again.get('finance').duties.length, 2);
    assert.equal(again.get('research').duties.length, 1, 'the untouched ones are still there');

    // Removing a duty takes its job off the scheduler.
    await again.removeDuty('finance', 'weekly-close');
    assert.equal(again.get('finance').duties.length, 1);
    assert.ok(!Object.keys(h.scheduler.state()).includes(`${JOB_PREFIX}:finance:weekly-close`));
    await assert.rejects(again.removeDuty('finance', 'weekly-close'), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(again.setCharter('nonsense', {}), (e) => e.code === 'BAD_REQUEST');
  } finally {
    await h.cleanup();
  }
});

test('a duty has to be well formed, and a department keeps a bounded number of them', async () => {
  const h = await setup();
  try {
    // Each case changes one thing, so each failure is the one being tested.
    const ok = { id: 'a-duty', title: 'A duty', brief: 'Read something and write it to _teams/finance/thing.md.', schedule: { daily: '09:00' } };
    // A brief too short to act on.
    await assert.rejects(h.charters.setDuty('finance', { ...ok, brief: 'do stuff' }), (e) => e.code === 'BAD_REQUEST' && /brief/.test(e.message));
    // An id that is not an id.
    await assert.rejects(h.charters.setDuty('finance', { ...ok, id: 'Bad Id' }), (e) => e.code === 'BAD_REQUEST' && /id/.test(e.message));
    // A time that is not a time.
    await assert.rejects(h.charters.setDuty('finance', { ...ok, schedule: { daily: '99:99' } }), (e) => e.code === 'BAD_REQUEST' && /schedule/.test(e.message));
    // No cadence at all: a duty with no schedule would never run and never say so.
    await assert.rejects(h.charters.setDuty('finance', { ...ok, schedule: {} }), (e) => /needs a schedule/.test(e.message));
    // A cadence under a minute would hammer the park.
    await assert.rejects(h.charters.setDuty('finance', { ...ok, schedule: { everyMs: 1000 } }), (e) => e.code === 'BAD_REQUEST' && /schedule/.test(e.message));
    // A field nobody declared.
    await assert.rejects(h.charters.setDuty('finance', { ...ok, surprise: 1 }), (e) => e.code === 'BAD_REQUEST');

    for (let i = h.charters.get('finance').duties.length; i < MAX_DUTIES; i++) {
      await h.charters.setDuty('finance', { id: `filler-${i}`, title: `Filler duty ${i}`, brief: 'Read something and write it to _teams/finance/ with the date.', schedule: { daily: '09:00' }, budgetUsd: 0 });
    }
    await assert.rejects(
      h.charters.setDuty('finance', { id: 'one-too-many', title: 'Extra', brief: 'Read something and write it to _teams/finance/ with the date.', schedule: { daily: '09:00' } }),
      (e) => e.code === 'TOO_MANY',
    );
  } finally {
    await h.cleanup();
  }
});

test('charter.read tells a Ranger its own department\'s standing instructions', async () => {
  const h = await setup();
  try {
    const tool = h.charters.tools['charter.read'];
    const head = h.agents.list().find((a) => a.zone && a.zone.kind === 'finance');

    const own = JSON.parse((await tool.run({}, { agentId: head.id })).output);
    assert.equal(own.department, 'finance');
    assert.equal(own.yours, true);
    assert.equal(own.folder, '_teams/finance/');
    assert.match(own.remit, /real connector data only/);
    assert.equal(own.duties[0].id, 'daily-books');
    assert.equal(own.duties[0].enabled, true);

    // Another department's, so a Ranger can see what it already does before asking it.
    const theirs = JSON.parse((await tool.run({ department: 'legal' }, { agentId: head.id })).output);
    assert.equal(theirs.department, 'legal');
    assert.equal(theirs.yours, false);

    // An agent in no department must name one.
    await h.agents.ensureChief();
    const nowhere = await tool.run({}, { agentId: 'chief-ranger' });
    assert.equal(nowhere.ok, false);
    assert.match(nowhere.error, /belong to no department/);
    assert.equal(JSON.parse((await tool.run({ department: 'finance' }, { agentId: 'chief-ranger' })).output).yours, false);
  } finally {
    await h.cleanup();
  }
});

test('the schedules the defaults use are ones the scheduler understands', () => {
  // A charter that cannot be scheduled is a department that silently never works.
  for (const [dept, c] of Object.entries(DEFAULT_CHARTERS)) {
    for (const d of c.duties) {
      assert.doesNotThrow(() => nextRunAt(d.schedule, 0), `${dept}/${d.id}: ${JSON.stringify(d.schedule)}`);
      const at = nextRunAt(d.schedule, 1000);
      assert.ok(at > 1000, `${dept}/${d.id} must be due in the future`);
    }
  }
});
