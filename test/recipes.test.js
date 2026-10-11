// Phase 4 step 12: recipes and skills. The schema and the pure helpers, the starter library,
// the runner over fakes (grants, the plan's refusals, steps as work items in dependency
// order, the success check, failures, a restart), skills on the prompt, and the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { RECIPE_SCHEMA, validateRecipe, validateSkill, stepOrder, readySteps, substitute, resolveParams, globToRegExp, checkSuccess, renderRecipe } from '../sidecar/recipes/schema.js';
import { RECIPES_DIR, SKILLS_DIR } from '../sidecar/recipes/index.js';
import { REPO_ROOT } from '../sidecar/index.js';
import { roleGrants, defaultLayout, LAYOUT_SCHEMA } from '../shared/world.js';
import { defaultLeash } from '../shared/leash.js';
import { validate } from '../shared/schema.js';
import { initialState, applySnapshot, applyEvent } from '../frontend/state.js';
import { makeEvent } from '../shared/events.js';
import { fakeProvider, text, end, toolCall } from './helpers/fake-provider.js';
import { startTestServer } from './helpers/test-server.js';

const STARTER = path.join(REPO_ROOT, 'recipes', 'starter');

const RECIPE = {
  id: 'two-step',
  title: 'Two steps',
  goal: 'Write a note for {venture} then a summary of it.',
  params: [{ name: 'venture', required: true }, { name: 'tone', default: 'plain' }],
  steps: [
    { id: 'note', title: 'The note', specialty: 'storefront', budgetUsd: 0.3, fixtures: ['supply_cache'], brief: 'Write outbox/notes/{venture}.md in a {tone} tone.', evidence: ['outbox/notes/{venture}.md'] },
    { id: 'summary', title: 'The summary', specialty: 'books', budgetUsd: 0.2, dependsOn: ['note'], fixtures: ['supply_cache'], brief: 'Summarise the note into outbox/notes/{venture}-summary.md.' },
  ],
  leashNeeds: [{ domain: 'publishing', level: 'draft' }],
  successCheck: { kind: 'files', patterns: ['outbox/notes/*.md', 'outbox/notes/*-summary.md'] },
};

test('the recipe schema: valid documents, duplicate and unknown steps, cycles, the success check rules', () => {
  assert.ok(validateRecipe(RECIPE).ok);
  assert.ok(validate(RECIPE_SCHEMA, RECIPE).ok);
  assert.match(validateRecipe({ ...RECIPE, steps: [RECIPE.steps[0], RECIPE.steps[0]] }).errors[0].message, /duplicate/);
  assert.match(validateRecipe({ ...RECIPE, steps: [{ ...RECIPE.steps[0], dependsOn: ['ghost'] }] }).errors[0].message, /unknown step ghost/);
  assert.match(validateRecipe({ ...RECIPE, steps: [{ ...RECIPE.steps[0], dependsOn: ['summary'] }, RECIPE.steps[1]] }).errors[0].message, /cycle/);
  assert.match(validateRecipe({ ...RECIPE, successCheck: { kind: 'files' } }).errors[0].message, /needs patterns/);
  assert.match(validateRecipe({ ...RECIPE, successCheck: { kind: 'count' } }).errors[0].message, /needs min/);
  assert.ok(!validateRecipe({ ...RECIPE, id: 'Bad Id' }).ok);
  assert.ok(!validateRecipe({ ...RECIPE, steps: [{ ...RECIPE.steps[0], specialty: 'wizard' }] }).ok);
  assert.ok(!validateRecipe({ ...RECIPE, steps: [{ ...RECIPE.steps[0], fixtures: ['fountain'] }] }).ok);
  assert.ok(validateSkill({ id: 'x-y', title: 'X', instructions: 'Do x.' }).ok);
  assert.ok(!validateSkill({ id: 'x', title: 'X', instructions: 'Do x.' }).ok, 'ids are at least two characters');
});

test('pure helpers: order, ready steps, substitution, params, globs, the success check, the markdown', () => {
  assert.deepEqual(stepOrder(RECIPE.steps).map((s) => s.id), ['note', 'summary']);
  assert.deepEqual(stepOrder([{ id: 'b', dependsOn: ['a'] }, { id: 'a' }]).map((s) => s.id), ['a', 'b']);
  assert.equal(stepOrder([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), null);
  assert.deepEqual(readySteps(RECIPE.steps, new Set(), new Set()).map((s) => s.id), ['note']);
  assert.deepEqual(readySteps(RECIPE.steps, new Set(['note']), new Set(['note'])).map((s) => s.id), ['summary']);
  assert.deepEqual(readySteps(RECIPE.steps, new Set(), new Set(['note'])), []);
  assert.equal(substitute('a {venture} b {missing} {tone}', { venture: 'v1', tone: 'warm' }), 'a v1 b {missing} warm');
  assert.deepEqual(resolveParams(RECIPE, { venture: 'v1' }), { params: { venture: 'v1', tone: 'plain' }, missing: [] });
  assert.deepEqual(resolveParams(RECIPE, { tone: 'x' }).missing, ['venture']);
  assert.ok(globToRegExp('outbox/notes/*.md').test('outbox/notes/v1.md'));
  assert.ok(!globToRegExp('outbox/notes/*.md').test('outbox/notes/deep/v1.md'));
  assert.ok(globToRegExp('outbox/**/x.json').test('outbox/a/b/x.json'));
  assert.ok(!globToRegExp('outbox/notes/*.md').test('outbox/notes/v1.mdx'));
  assert.deepEqual(checkSuccess(RECIPE, ['outbox/notes/v1.md', 'outbox/notes/v1-summary.md']), { ok: true, kind: 'files', matched: ['outbox/notes/v1.md', 'outbox/notes/v1-summary.md'], missing: [] });
  assert.deepEqual(checkSuccess(RECIPE, ['outbox/notes/v1.md']).missing, ['outbox/notes/*-summary.md']);
  assert.equal(checkSuccess({ successCheck: { kind: 'count', min: 2 } }, ['a']).ok, false);
  assert.equal(checkSuccess({}, []).ok, true);
  const md = renderRecipe({ ...RECIPE, version: 2 });
  assert.match(md, /^# Two steps \(two-step v2\)/);
  assert.match(md, /### note: The note → storefront · \$0\.30 · needs Supply cache/);
  assert.match(md, /### summary: .* · after note/);
  assert.match(md, /- publishing at draft/);
  assert.match(md, /Deliverables matching: outbox\/notes\/\*\.md/);
});

test('the starter library: five recipes and three skills, every one valid, every step with a Supply cache for its deliverable', async () => {
  const files = (await fsp.readdir(STARTER)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.sort(), ['launch-etsy-listing.json', 'monthly-books-close.json', 'supplier-reorder-check.json', 'support-inbox-sweep.json', 'weekly-ad-review.json']);
  for (const f of files) {
    const doc = JSON.parse(await fsp.readFile(path.join(STARTER, f), 'utf8'));
    const v = validateRecipe(doc);
    assert.ok(v.ok, `${f}: ${JSON.stringify(v.errors)}`);
    assert.equal(`${doc.id}.json`, f);
    assert.equal(doc.source, 'starter');
    for (const s of doc.steps) if (s.evidence && s.evidence.some((e) => /^outbox\//.test(e))) assert.ok((s.fixtures || []).includes('supply_cache'), `${f} step ${s.id} writes a deliverable and needs a Supply cache`);
    assert.ok(doc.leashNeeds.length >= 1, `${f} names its leash needs`);
  }
  const listing = JSON.parse(await fsp.readFile(path.join(STARTER, 'launch-etsy-listing.json'), 'utf8'));
  assert.deepEqual(stepOrder(listing.steps).map((s) => s.id), ['product-data', 'copy', 'image', 'draft-listing', 'price', 'publish']);
  assert.deepEqual(listing.leashNeeds.map((l) => l.domain).sort(), ['money_in', 'publishing']);
  const skills = (await fsp.readdir(path.join(STARTER, 'skills'))).sort();
  assert.deepEqual(skills, ['etsy-listing-copy.json', 'gate-etiquette.json', 'support-tone.json']);
  for (const f of skills) assert.ok(validateSkill(JSON.parse(await fsp.readFile(path.join(STARTER, 'skills', f), 'utf8'))).ok, f);
  // The grants and the layout field.
  assert.ok(roleGrants('ranger').includes('recipe.run'));
  assert.ok(roleGrants('chief_ranger').includes('recipe.run'));
  assert.ok(!roleGrants('junior_ranger').includes('recipe.run'));
  const layout = defaultLayout();
  layout.agents[0].skills = ['gate-etiquette'];
  assert.ok(validate(LAYOUT_SCHEMA, layout).ok);
});

// The Superintendent allowing every fs.write prompt (the per-call confirmation, D11), as the
// park page would; without it a Ranger's write waits for a human.
function autoApprove(srv) {
  const seen = new Set();
  const stop = srv.bus.listen((e) => {
    if (e.type !== 'permission.prompt' || seen.has(e.payload.promptId)) return;
    seen.add(e.payload.promptId);
    srv.post('/api/permission', { promptId: e.payload.promptId, runId: e.payload.runId, allow: true }).catch(() => {});
  });
  return { stop: () => { if (typeof stop === 'function') stop(); } };
}

function layoutWithCamps() {
  const layout = defaultLayout();
  layout.rooms.push({ id: 'listings', name: 'Listings Camp', kind: 'product_listings', x: 21, y: 1, w: 8, h: 6 });
  layout.rooms.push({ id: 'finance', name: 'Finance Camp', kind: 'finance', x: 31, y: 1, w: 8, h: 6 });
  layout.objects.push({ id: 'cache-l', kind: 'supply_cache', roomId: 'listings', x: 22, y: 2 });
  layout.agents.push({ id: 'sam', name: 'Sam', roomId: 'listings', x: 21, y: 1, role: 'ranger', specialty: 'storefront', venture: 'lantern-co' });
  layout.agents.push({ id: 'sue', name: 'Sue', roomId: 'listings', x: 23, y: 1, role: 'ranger', specialty: 'storefront', venture: 'other-co' });
  layout.agents.push({ id: 'bea', name: 'Bea', roomId: 'finance', x: 31, y: 1, role: 'ranger', specialty: 'books', venture: 'lantern-co' });
  layout.agents.push({ id: 'jun', name: 'Jun', roomId: 'listings', x: 24, y: 1, role: 'junior_ranger', parentAgentId: 'sam', venture: 'lantern-co' });
  return layout;
}

test('the runner: the starter library is seeded once, grants, the plan refuses honestly, steps run as work items in order, the success check closes the run, skills reach the prompt', async () => {
  // Every worker turn writes the file its brief asks for, then reports.
  const worker = fakeProvider([
    (req) => { const m = /Write (outbox\/notes\/[^\s]+\.md)/.exec(req.messages[0].content[0].text); return [...toolCall('w1', 'fs.write', { path: m[1], content: 'the note' }), end('tool_use')]; },
    [text('Note written.'), end()],
    (req) => { const m = /into (outbox\/notes\/[^\s]+\.md)/.exec(req.messages[0].content[0].text); return [...toolCall('w2', 'fs.write', { path: m[1], content: 'the summary' }), end('tool_use')]; },
    [text('Summary written.'), end()],
    [text('Skill check run.'), end()],
  ]);
  const srv = await startTestServer({ layout: layoutWithCamps(), withChief: true, makeProvider: async () => ({ provider: worker, model: 'm', price: null }), leash: { ...defaultLeash(), domains: { ...defaultLeash().domains, publishing: { level: 'draft' } } }, permissionTimeoutMs: 3000 });
  const approver = autoApprove(srv);
  try {
    // The library landed in _peak/recipes and _peak/skills, Markdown beside each version.
    const lib = (await srv.get('/api/recipes')).body;
    assert.deepEqual(lib.map((r) => r.id), ['launch-etsy-listing', 'monthly-books-close', 'supplier-reorder-check', 'support-inbox-sweep', 'weekly-ad-review']);
    assert.ok(await fsp.stat(path.join(srv.workspaceRoot, RECIPES_DIR, 'launch-etsy-listing', 'v1.json')));
    assert.ok(await fsp.stat(path.join(srv.workspaceRoot, RECIPES_DIR, 'launch-etsy-listing', 'v1.md')));
    assert.ok(await fsp.stat(path.join(srv.workspaceRoot, SKILLS_DIR, 'gate-etiquette.json')));
    assert.equal((await srv.get('/api/skills')).body.length, 3);
    const one = (await srv.get('/api/recipes/launch-etsy-listing')).body;
    assert.equal(one.steps.length, 6);
    assert.match(one.markdown, /^# Launch an Etsy listing/);
    assert.deepEqual(one.versions, [1]);
    assert.equal((await srv.get('/api/recipes/nope')).status, 404);
    // Save a new recipe (version 1), then a new version of it (2); an invalid one is refused.
    const saved = await srv.post('/api/recipes', RECIPE);
    assert.equal(saved.status, 201);
    assert.equal(saved.body.version, 1);
    const v2 = await srv.post('/api/recipes', { ...RECIPE, title: 'Two steps, revised' });
    assert.equal(v2.body.version, 2);
    assert.deepEqual((await srv.get('/api/recipes/two-step')).body.versions, [1, 2]);
    assert.equal((await srv.get('/api/recipes/two-step?version=1')).body.title, 'Two steps');
    assert.equal((await srv.post('/api/recipes', { ...RECIPE, steps: [] })).status, 400);
    // Grants: to a role or an agent, never a Junior; the lines on a Ranger's prompt follow.
    assert.equal((await srv.post('/api/recipes/two-step/grant', { role: 'junior_ranger' })).status, 400);
    assert.equal((await srv.post('/api/recipes/two-step/grant', { agentId: 'jun' })).status, 400);
    assert.equal((await srv.post('/api/recipes/two-step/grant', { role: 'ranger', agentId: 'sam' })).status, 400);
    const g = await srv.post('/api/recipes/two-step/grant', { agentId: 'sam' });
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.map((x) => x.agentId), ['sam']);
    assert.deepEqual(srv.recipes.grantsFor('sam').map((r) => r.id), ['two-step']);
    assert.deepEqual(srv.recipes.grantsFor('sue'), []);
    assert.equal(srv.recipes.mayRun('two-step', 'superintendent'), true);
    assert.equal(srv.recipes.mayRun('two-step', 'sue'), false);
    // The plan: a missing parameter, a missing fixture (Bea has no Supply cache), a leash at Observe.
    const noParam = (await srv.post('/api/recipes/two-step/plan', { ventureId: 'lantern-co' })).body;
    assert.equal(noParam.ok, false);
    assert.equal(noParam.problems[0].code, 'MISSING_PARAM');
    const noFixture = (await srv.post('/api/recipes/two-step/plan', { ventureId: 'lantern-co', params: { venture: 'lantern-co' } })).body;
    assert.equal(noFixture.ok, false);
    assert.deepEqual(noFixture.problems.map((p) => p.code), ['MISSING_FIXTURE']);
    assert.match(noFixture.problems[0].message, /step summary needs a Supply cache in finance/);
    assert.deepEqual(noFixture.assignments.note.agentId, 'sam', "the venture's own storefront Ranger, not Sue");
    await srv.layoutState.place({ kind: 'supply_cache', roomId: 'finance', x: 32, y: 2 });
    const putObserve = await srv.put('/api/leash', { ...srv.leashState.get(), agents: { bea: { domains: { publishing: { level: 'observe' } } } } });
    assert.equal(putObserve.status, 200, JSON.stringify(putObserve.body));
    const observe = (await srv.post('/api/recipes/two-step/plan', { ventureId: 'lantern-co', params: { venture: 'lantern-co' } })).body;
    assert.deepEqual(observe.problems.map((p) => p.code), ['LEASH_OBSERVE']);
    await srv.put('/api/leash', { ...srv.leashState.get(), agents: {} });
    const ok = (await srv.post('/api/recipes/two-step/plan', { ventureId: 'lantern-co', params: { venture: 'lantern-co' } })).body;
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.order, ['note', 'summary']);
    assert.deepEqual(ok.params, { venture: 'lantern-co', tone: 'plain' });
    assert.deepEqual(ok.notes, [], 'draft is what the recipe asks: no note');
    // A refused run is an event; nothing is delegated.
    const refused = await srv.post('/api/recipes/two-step/run', { ventureId: 'lantern-co' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'MISSING_PARAM');
    const stream = await srv.sse();
    // The run: the first step delegated now, the second after work.done, then the check.
    const run = await srv.post('/api/recipes/two-step/run', { ventureId: 'lantern-co', params: { venture: 'lantern-co', tone: 'warm' } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    assert.equal(run.body.status, 'running');
    assert.equal(run.body.steps.note.status, 'delegated');
    assert.equal(run.body.steps.note.agentId, 'sam');
    assert.equal(run.body.steps.summary.status, 'pending');
    const item = srv.trails.get(run.body.steps.note.workItemId);
    assert.equal(item.fromAgentId, 'superintendent');
    assert.match(item.brief, /Recipe "Two steps, revised" \(two-step v2\), step note "The note" of 2 for venture lantern-co/);
    assert.match(item.brief, /Write outbox\/notes\/lantern-co\.md in a warm tone\./);
    assert.deepEqual(item.evidence, ['outbox/notes/{venture}.md']);
    assert.equal(item.budgetUsd, 0.3);
    const done = await stream.waitFor((e) => e.type === 'recipe.run' && e.payload.recipeRunId === run.body.id && ['done', 'failed'].includes(e.payload.status), 15000);
    assert.equal(done.payload.status, 'done', JSON.stringify(done.payload));
    assert.equal(done.payload.deliverables, 2);
    const final = (await srv.get(`/api/recipe-runs/${run.body.id}`)).body;
    assert.equal(final.status, 'done');
    assert.equal(final.steps.summary.agentId, 'bea');
    assert.deepEqual(final.steps.note.deliverables, ['outbox/notes/lantern-co.md']);
    assert.deepEqual(final.steps.summary.deliverables, ['outbox/notes/lantern-co-summary.md']);
    assert.equal(final.success.ok, true);
    const summaryItem = srv.trails.get(final.steps.summary.workItemId);
    assert.match(summaryItem.brief, /Earlier steps delivered: outbox\/notes\/lantern-co\.md/);
    const statuses = stream.events.filter((e) => e.type === 'recipe.run' && e.payload.recipeRunId === run.body.id).map((e) => `${e.payload.status}${e.payload.stepId ? ':' + e.payload.stepId : ''}`);
    assert.deepEqual(statuses, ['started', 'step:note', 'step:summary', 'done']);
    assert.equal((await srv.get('/api/recipe-runs')).body[0].id, run.body.id);
    const state = (await srv.get('/api/state')).body;
    assert.equal(state.recipes.runs.done, 1);
    assert.equal(state.recipes.recipes, 6);
    // Skills: attached through the agent record, read into the system prompt with the recipe lines.
    const patched = await srv.patch('/api/agents/sam', { skills: ['gate-etiquette', 'etsy-listing-copy'] });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body.skills, ['gate-etiquette', 'etsy-listing-copy']);
    assert.equal((await srv.patch('/api/agents/sam', { skills: 'nope' })).status, 400);
    await srv.runs.waitForIdle();
    const r = await srv.post('/api/run', { prompt: 'Check in.', agentId: 'sam' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r.body.runId, 10000);
    const sys = worker.requests.at(-1).system;
    assert.match(sys, /Skill "Gate etiquette": When a tool call waits at the Entrance Gate/);
    assert.match(sys, /Skill "Etsy listing copy"/);
    assert.match(sys, /Recipes you may run with recipe.run: two-step \("Two steps, revised", 2 step\(s\), params venture\/tone\)/);
    assert.ok(!/Skill "Support tone"/.test(sys));
    // Revoke: the line leaves the prompt source.
    await srv.post('/api/recipes/two-step/revoke', { agentId: 'sam' });
    assert.deepEqual(srv.recipes.grantsFor('sam'), []);
    stream.close();
  } finally {
    approver.stop();
    await srv.close();
  }
});

test('a Ranger runs a granted recipe with recipe.run; an ungranted one is refused and logged; a failed step fails the run; a restart marks a running run failed', async () => {
  // Runs of several Rangers interleave, so the script answers by what each run asked.
  const dispatch = (req) => {
    const first = req.messages[0].content[0].text || '';
    const turn = req.messages.length;
    if (/Run the two-step recipe/.test(first)) return turn === 1 ? [...toolCall('r1', 'recipe.run', { recipeId: 'two-step', ventureId: 'lantern-co', params: { venture: 'lantern-co' } }), end('tool_use')] : [text('Started the recipe.'), end()];
    if (/step note "The note"/.test(first)) throw new Error('worker down'); // the note step's run fails outright
    if (/Run the listing recipe/.test(first)) return turn === 1 ? [...toolCall('r2', 'recipe.run', { recipeId: 'launch-etsy-listing', ventureId: 'lantern-co' }), end('tool_use')] : [text('Refused.'), end()];
    return [text('Nothing to do.'), end()];
  };
  const worker = fakeProvider(Array(10).fill(dispatch));
  const layout = layoutWithCamps();
  layout.objects.push({ id: 'cache-f', kind: 'supply_cache', roomId: 'finance', x: 32, y: 2 });
  const srv = await startTestServer({ layout, withChief: true, makeProvider: async () => ({ provider: worker, model: 'm', price: null }), permissionTimeoutMs: 3000 });
  try {
    // The Chief delegates an agent-started recipe's steps from the mission budget (L4): a mission exists.
    await srv.store.saveMission({ id: 'mission-1', text: 'Sell lanterns', budgetUsd: 5, horizon: '30 days', status: 'active', reason: '', createdAt: Date.now(), followUps: 0, runIds: [] });
    await srv.chief.init();
    await srv.post('/api/recipes', RECIPE);
    await srv.post('/api/recipes/two-step/grant', { role: 'ranger' });
    const stream = await srv.sse();
    const r = await srv.post('/api/run', { prompt: 'Run the two-step recipe for lantern-co.', agentId: 'sue' });
    assert.equal(r.status, 202);
    const started = await stream.waitFor((e) => e.type === 'recipe.run' && e.payload.status === 'started', 10000);
    assert.equal(started.payload.by, 'sue');
    const toolOut = await stream.waitFor((e) => e.type === 'agent.tool_result' && e.payload.name === 'recipe.run', 10000);
    assert.ok(toolOut.payload.ok, toolOut.payload.error);
    const out = JSON.parse(toolOut.payload.output.split('\n')[0]);
    assert.equal(out.delegated[0].step, 'note');
    assert.equal(out.delegated[0].to, 'sam', "Sue's recipe run still sends the venture's step to Lantern Co's own storefront Ranger");
    const noteItem = srv.trails.get(out.delegated[0].workItemId);
    assert.equal(noteItem.fromAgentId, 'chief-ranger', 'an agent-started recipe is delegated by the Chief under the mission budget');
    assert.equal(srv.recipes.getRun(started.payload.recipeRunId).delegatedBy, 'chief-ranger');
    const failed = await stream.waitFor((e) => e.type === 'recipe.run' && e.payload.recipeRunId === started.payload.recipeRunId && ['done', 'failed'].includes(e.payload.status), 15000);
    assert.equal(failed.payload.status, 'failed');
    assert.match(failed.payload.reason, /step note failed/);
    const run = srv.recipes.getRun(started.payload.recipeRunId);
    assert.equal(run.steps.note.status, 'failed');
    assert.equal(run.steps.summary.status, 'pending', 'nothing after a failed step is delegated');
    await srv.runs.waitForIdle();
    // Not granted: refused with the event, nothing delegated.
    const r2 = await srv.post('/api/run', { prompt: 'Run the listing recipe.', agentId: 'sue' });
    await stream.waitFor((e) => e.type === 'agent.run.end' && e.payload.runId === r2.body.runId, 10000);
    const refusedTool = stream.events.filter((e) => e.type === 'agent.tool_result' && e.payload.name === 'recipe.run').at(-1);
    assert.equal(refusedTool.payload.ok, false);
    assert.match(refusedTool.payload.error, /not granted to sue/);
    const refusedEv = stream.events.find((e) => e.type === 'recipe.run' && e.payload.status === 'refused');
    assert.match(refusedEv.payload.reason, /NOT_GRANTED/);
    assert.equal(srv.recipes.runs().length, 1);
    // A run left running across a restart is marked failed, with the reason.
    const stuck = { id: 'recipe-run-stuck', recipeId: 'two-step', version: 1, title: 'x', ventureId: null, by: 'superintendent', params: {}, startedAt: 1, endedAt: null, status: 'running', assignments: {}, order: ['note'], steps: { note: { status: 'delegated', workItemId: 'gone' } }, notes: [], success: null };
    await srv.store.saveRecipeRuns({ version: 1, runs: [stuck] });
    const { createRecipes } = await import('../sidecar/recipes/index.js');
    const again = await createRecipes({ store: srv.store, bus: srv.bus, trails: srv.trails, agents: srv.agents, getLayout: srv.layoutState.get, leashState: srv.leashState, workspaceRoot: srv.workspaceRoot, starterDir: null, log: { error() {}, warn() {} } }).init();
    assert.equal(again.getRun('recipe-run-stuck').status, 'failed');
    assert.match(again.getRun('recipe-run-stuck').notes[0], /restarted/);
    assert.equal(again.list().length, 6, 'the library is read back from _peak/recipes without re-seeding');
    stream.close();
  } finally {
    await srv.close();
  }
});

test('the frontend reducer keeps the recipe counts and marks them stale on recipe.run', () => {
  const base = { seq: 0, providers: {}, keystore: { path: '/x', problem: null }, layout: defaultLayout(), objectKinds: {}, activeRun: null, spend: { totalUsd: 0, reconciledTurns: 0, unreconciledTurns: 0 } };
  let s = applySnapshot(initialState(), { ...base, recipes: { recipes: 5, skills: 3, grants: 0, runs: { running: 0, done: 0, failed: 0 }, recent: [] } });
  assert.equal(s.recipes.recipes, 5);
  s = applyEvent(s, { ...makeEvent('recipe.run', { recipeRunId: 'rr', recipeId: 'two-step', version: 1, status: 'step', by: 'superintendent', stepId: 'note' }, { ts: 9 }), seq: 1 });
  assert.equal(s.recipes.stale, true);
  assert.equal(s.recipes.latest.stepId, 'note');
  assert.equal(s.recipes.recipes, 5);
});
