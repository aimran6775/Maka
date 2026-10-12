// D181: a recipe step with two dependencies was delegated twice.
//
// `delegateReady` computed which steps had started by reading `run.steps`, then awaited
// `trails.delegate` before writing the step's new status. Two steps that finish at nearly
// the same moment each bring a `work.done` into the recipes module, and each one calls
// `delegateReady` in a detached async call — so both read `run.steps` before either had
// marked the next step, both saw it as not started, and both delegated it. The step ran
// twice: double the work, double the model spend, and two sets of deliverables for one
// step of one recipe.
//
// It surfaced only when D180 stopped `fs.write` asking per call. The permission round trip
// had been adding an HTTP hop to every write, which serialised the two branches enough to
// hide the race almost always — the listing pipeline test passed roughly one run in three
// once the hop was gone.
//
// This test drives the shape directly: the fan-in step is claimed before the await, so a
// second concurrent pass over the same run skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readySteps } from '../sidecar/recipes/schema.js';

// The shape that breaks: two steps running in parallel, both feeding one.
const STEPS = [
  { id: 'product-data' },
  { id: 'copy', dependsOn: ['product-data'] },
  { id: 'image', dependsOn: ['product-data'] },
  { id: 'draft-listing', dependsOn: ['copy', 'image'] },
];

const startedOf = (steps) => new Set(Object.entries(steps).filter(([, s]) => s.status !== 'pending').map(([id]) => id));
const doneOf = (steps) => new Set(Object.entries(steps).filter(([, s]) => s.status === 'done').map(([id]) => id));

test('a fan-in step is claimed before its delegate is awaited, so two finishing branches cannot both delegate it', async () => {
  // Both parallel branches have just reported done; the fan-in step is still pending.
  const stepsOf = () => ({
    'product-data': { status: 'done' },
    copy: { status: 'done' },
    image: { status: 'done' },
    'draft-listing': { status: 'pending' },
  });

  // The loop as it is written now: claim synchronously, then await the delegate. Both
  // `work.done` handlers run it against the same run object, interleaved at the await.
  async function delegateReady(run, delegated, gate) {
    for (const step of readySteps(STEPS, doneOf(run.steps), startedOf(run.steps))) {
      run.steps[step.id] = { ...run.steps[step.id], status: 'delegated' };
      await gate(); // where `trails.delegate` yields
      delegated.push(step.id);
      run.steps[step.id] = { ...run.steps[step.id], workItemId: `work-${delegated.length}` };
    }
  }

  const run = { steps: stepsOf() };
  const delegated = [];
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  const gate = () => {
    if (!first) return Promise.resolve();
    first = false;
    return held; // the first pass parks inside the await, exactly where the race opened
  };
  const a = delegateReady(run, delegated, gate);
  const b = delegateReady(run, delegated, gate); // the second work.done, while the first is parked
  release();
  await Promise.all([a, b]);

  assert.deepEqual(delegated, ['draft-listing'], 'delegated exactly once, by whichever pass claimed it');
  assert.equal(run.steps['draft-listing'].workItemId, 'work-1', 'and it carries one work item');

  // The bug, for contrast: marking the step only after the await lets both passes through.
  async function delegateAfterAwait(r, out, g) {
    for (const step of readySteps(STEPS, doneOf(r.steps), startedOf(r.steps))) {
      await g();
      out.push(step.id);
      r.steps[step.id] = { ...r.steps[step.id], status: 'delegated' };
    }
  }
  const bad = { steps: stepsOf() };
  const twice = [];
  let release2;
  const held2 = new Promise((r) => { release2 = r; });
  let firstAgain = true;
  const gate2 = () => {
    if (!firstAgain) return Promise.resolve();
    firstAgain = false;
    return held2;
  };
  const c = delegateAfterAwait(bad, twice, gate2);
  const d = delegateAfterAwait(bad, twice, gate2);
  release2();
  await Promise.all([c, d]);
  assert.deepEqual(twice, ['draft-listing', 'draft-listing'], 'the old order delegates the same step twice');
});

test('readySteps holds a fan-in step until every branch is done, and never reoffers a started one', () => {
  const ready = (done, started) => readySteps(STEPS, new Set(done), new Set(started)).map((s) => s.id);
  assert.deepEqual(ready([], []), ['product-data']);
  assert.deepEqual(ready(['product-data'], ['product-data']), ['copy', 'image'], 'both branches at once');
  // One branch home is not enough for the fan-in.
  assert.deepEqual(ready(['product-data', 'copy'], ['product-data', 'copy', 'image']), [], 'image is still out');
  assert.deepEqual(ready(['product-data', 'copy', 'image'], ['product-data', 'copy', 'image']), ['draft-listing']);
  // Claimed counts as started even before it has a work item, which is what makes the
  // synchronous claim above sufficient.
  assert.deepEqual(ready(['product-data', 'copy', 'image'], ['product-data', 'copy', 'image', 'draft-listing']), []);
});
