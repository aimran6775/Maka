// Recipes and skills (phase 4 step 12).
//
//   createRecipes({ store, bus, trails, agents, getLayout, leashState, workspaceRoot,
//                   starterDir, clock, log })
//     -> { init(), list(), get(id), save(doc, { by }), grant(...), revoke(...), grantsFor(agentId),
//          run({ recipeId, ventureId, params, by }), runs(), getRun(id), skills(), getSkill(id),
//          saveSkill(doc, { by }), skillLines(agent), recipeLines(agent), tools, summary() }
//
// A recipe is a versioned document in `<workspaceRoot>/_peak/recipes/<id>/v<N>.json` (the
// starter library under `recipes/starter/` is copied in on the first boot and never
// overwrites a version that exists), granted to a role or a Ranger (`_peak/recipes/grants.json`).
// Running one turns its steps into work items along the trails in dependency order: each
// step goes to a Ranger of its specialty (the venture's own crew only when a venture is
// named, safety 2026-10-11 M3; the work item carries the venture), after the run
// checked that every fixture the step names stands in that Ranger's zone and that no leash
// the recipe needs is at Observe (a stricter level than needed is a note: the step will
// wait at the Gate). The steps are the Superintendent's delegations when the Superintendent
// runs the recipe and the Chief's (under the mission budget, safety L4) when an agent asked
// for the run through recipe.run (D143). `work.done` on a step delegates what it unblocked; when every step is
// done the success check reads the deliverables; a failed step fails the run. Runs persist
// in `recipe-runs.json`; one left running at boot is marked failed (its items are). Skills
// live in `_peak/skills/<id>.json` and reach a Ranger's system prompt through `skillLines`.
// Events: recipe.run (started / step / done / failed / refused).

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../../shared/events.js';
import { writeJsonAtomic, readJson } from '../store.js';
import { resolveLeash, LEASH_LEVELS } from '../../shared/leash.js';
import { OBJECT_KINDS } from '../../shared/world.js';
import { CHIEF_ID } from '../agents.js';
import { validateRecipe, validateSkill, stepOrder, readySteps, substitute, resolveParams, checkSuccess, renderRecipe } from './schema.js';

export const RECIPES_DIR = path.join('_peak', 'recipes');
export const SKILLS_DIR = path.join('_peak', 'skills');
export const GRANTEE_ROLES = Object.freeze(['chief_ranger', 'ranger']);

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const stricter = (a, b) => LEASH_LEVELS.indexOf(a) < LEASH_LEVELS.indexOf(b);

export function createRecipes({ store, bus, trails, agents, getLayout, leashState = null, workspaceRoot, starterDir = null, clock = { now: () => Date.now() }, log = console } = {}) {
  if (!store || !bus || !trails || !agents || typeof getLayout !== 'function' || !workspaceRoot) throw new TypeError('createRecipes needs store, bus, trails, agents, getLayout and workspaceRoot');
  const root = path.join(workspaceRoot, RECIPES_DIR);
  const skillsRoot = path.join(workspaceRoot, SKILLS_DIR);
  const grantsFile = path.join(root, 'grants.json');
  const recipes = new Map(); // id -> { id, versions: Map(version -> doc), latest }
  const skills = new Map(); // id -> doc
  let grants = []; // [{ recipeId, role?, agentId?, at, by }]
  let runsState = { version: 1, runs: [] };
  let saving = Promise.resolve();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const saveRuns = () => {
    saving = saving.then(() => store.saveRecipeRuns(runsState)).catch((err) => log.error('recipe runs save failed:', err));
    return saving;
  };

  async function loadDir() {
    recipes.clear();
    skills.clear();
    let ids = [];
    try {
      ids = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const dir = path.join(root, id);
      const files = (await fsp.readdir(dir)).filter((f) => /^v\d+\.json$/.test(f));
      const entry = { id, versions: new Map(), latest: 0 };
      for (const f of files) {
        const doc = await readJson(path.join(dir, f), null);
        if (doc && validateRecipe(doc).ok && doc.id === id) {
          entry.versions.set(doc.version || 1, doc);
          entry.latest = Math.max(entry.latest, doc.version || 1);
        } else log.warn && log.warn(`recipe ${id}/${f} is invalid and ignored`);
      }
      if (entry.latest) recipes.set(id, entry);
    }
    let skillFiles = [];
    try {
      skillFiles = (await fsp.readdir(skillsRoot)).filter((f) => f.endsWith('.json'));
    } catch {
      skillFiles = [];
    }
    for (const f of skillFiles) {
      const doc = await readJson(path.join(skillsRoot, f), null);
      if (doc && validateSkill(doc).ok && f === `${doc.id}.json`) skills.set(doc.id, doc);
      else log.warn && log.warn(`skill ${f} is invalid and ignored`);
    }
    grants = (await readJson(grantsFile, { grants: [] })).grants || [];
  }

  // The starter library: copied in once; an id that already has a version is left alone.
  async function seedStarter() {
    if (!starterDir) return 0;
    let n = 0;
    let files = [];
    try {
      files = (await fsp.readdir(starterDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    for (const f of files) {
      const doc = await readJson(path.join(starterDir, f), null);
      if (!doc || !validateRecipe(doc).ok) {
        log.warn && log.warn(`starter recipe ${f} is invalid and skipped`);
        continue;
      }
      if (recipes.has(doc.id)) continue;
      await writeRecipe({ ...doc, version: doc.version || 1, source: doc.source || 'starter' });
      n += 1;
    }
    let skillFiles = [];
    try {
      skillFiles = (await fsp.readdir(path.join(starterDir, 'skills'))).filter((f) => f.endsWith('.json'));
    } catch {
      skillFiles = [];
    }
    for (const f of skillFiles) {
      const doc = await readJson(path.join(starterDir, 'skills', f), null);
      if (!doc || !validateSkill(doc).ok || skills.has(doc.id)) continue;
      await writeSkill({ ...doc, version: doc.version || 1, source: doc.source || 'starter' });
      n += 1;
    }
    return n;
  }

  async function writeRecipe(doc) {
    const dir = path.join(root, doc.id);
    await fsp.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, `v${doc.version}.json`), doc);
    await fsp.writeFile(path.join(dir, `v${doc.version}.md`), renderRecipe(doc), 'utf8');
    const entry = recipes.get(doc.id) || { id: doc.id, versions: new Map(), latest: 0 };
    entry.versions.set(doc.version, doc);
    entry.latest = Math.max(entry.latest, doc.version);
    recipes.set(doc.id, entry);
    return doc;
  }
  async function writeSkill(doc) {
    await fsp.mkdir(skillsRoot, { recursive: true });
    await writeJsonAtomic(path.join(skillsRoot, `${doc.id}.json`), doc);
    skills.set(doc.id, doc);
    return doc;
  }
  const saveGrants = () => writeJsonAtomic(grantsFile, { grants });

  const latest = (id) => {
    const e = recipes.get(id);
    return e ? e.versions.get(e.latest) : null;
  };
  const summaryOf = (doc) => ({ id: doc.id, version: doc.version, title: doc.title, goal: doc.goal, summary: doc.summary || '', steps: doc.steps.length, specialties: [...new Set(doc.steps.map((s) => s.specialty))], requiredFixtures: [...new Set([...(doc.requiredFixtures || []), ...doc.steps.flatMap((s) => s.fixtures || [])])], leashNeeds: doc.leashNeeds || [], params: doc.params || [], source: doc.source || null, grants: grants.filter((g) => g.recipeId === doc.id).map(({ role, agentId }) => ({ role: role || null, agentId: agentId || null })), versions: [...recipes.get(doc.id).versions.keys()].sort((a, b) => a - b) });

  // Who may run a recipe: the Superintendent always; an agent when the recipe is granted to
  // its role or to it by id.
  function mayRun(recipeId, by) {
    if (by === 'superintendent') return true;
    const a = agents.get(by);
    if (!a) return false;
    return grants.some((g) => g.recipeId === recipeId && ((g.agentId && g.agentId === by) || (g.role && g.role === (a.role || 'ranger'))));
  }
  function grantedTo(agentId) {
    const a = agents.get(agentId);
    if (!a) return [];
    return [...recipes.keys()].filter((id) => mayRun(id, agentId)).map((id) => latest(id)).filter(Boolean);
  }

  // Receivers per step: with a venture, only that venture's crew with the specialty
  // (safety 2026-10-11 M3: a Ranger of another venture would score its own venture with
  // this one's results, and a kill of this venture would never reach what it made); with
  // no venture, any Ranger of the specialty.
  function receiverFor(step, ventureId, layout) {
    const rangers = layout.agents.filter((a) => (a.role || 'ranger') === 'ranger' && a.specialty === step.specialty);
    if (ventureId) return rangers.find((a) => a.venture === ventureId) || null;
    return rangers[0] || null;
  }

  function plan(recipe, { ventureId = null, params = {} } = {}) {
    const layout = getLayout();
    const problems = [];
    const notes = [];
    const resolved = resolveParams(recipe, params);
    if (resolved.missing.length) problems.push({ code: 'MISSING_PARAM', message: `missing parameter(s): ${resolved.missing.join(', ')}` });
    const steps = stepOrder(recipe.steps) || recipe.steps;
    const assignments = {};
    for (const s of steps) {
      const to = receiverFor(s, ventureId, layout);
      if (!to) {
        problems.push({ code: 'NO_RANGER', message: ventureId ? `step ${s.id} needs a ${s.specialty} Ranger in venture ${ventureId} (none there; a Ranger of another venture is not used, so its results and kills stay with the right venture): hire one into ${ventureId} first` : `step ${s.id} needs a ${s.specialty} Ranger: hire one first` });
        continue;
      }
      assignments[s.id] = { agentId: to.id, roomId: to.roomId };
      for (const kind of s.fixtures || []) {
        if (!layout.objects.some((o) => o.roomId === to.roomId && o.kind === kind)) problems.push({ code: 'MISSING_FIXTURE', message: `step ${s.id} needs a ${OBJECT_KINDS[kind].label} in ${to.roomId} (${to.name || to.id}'s zone): place one in BUILD` });
      }
      if (leashState) {
        const leash = leashState.get();
        for (const need of recipe.leashNeeds || []) {
          const r = resolveLeash(leash, { agentId: to.id, roomId: to.roomId }, need.domain);
          if (r.level === 'observe') problems.push({ code: 'LEASH_OBSERVE', message: `${to.name || to.id} is at Observe for ${need.domain}: step ${s.id} would be refused; raise the leash at the Gate first` });
          else if (stricter(r.level, need.level)) notes.push(`step ${s.id}: ${need.domain} is at ${r.level} for ${to.name || to.id} (the recipe asks ${need.level}): its actions wait at the Gate`);
        }
      }
    }
    return { ok: problems.length === 0, problems, notes: [...new Set(notes)], assignments, params: resolved.params, order: steps.map((s) => s.id) };
  }

  const runById = (id) => runsState.runs.find((r) => r.id === id) || null;

  async function delegateReady(run) {
    const recipe = recipes.get(run.recipeId).versions.get(run.version);
    const done = new Set(Object.entries(run.steps).filter(([, s]) => s.status === 'done').map(([id]) => id));
    const started = new Set(Object.entries(run.steps).filter(([, s]) => s.status !== 'pending').map(([id]) => id));
    for (const step of readySteps(recipe.steps, done, started)) {
      const target = run.assignments[step.id];
      const context = [`Recipe "${recipe.title}" (${recipe.id} v${recipe.version}), step ${step.id} "${step.title}" of ${recipe.steps.length}${run.ventureId ? ` for venture ${run.ventureId}` : ''}.`, `Goal of the recipe: ${substitute(recipe.goal, run.params)}`];
      const earlier = (step.dependsOn || []).map((d) => run.steps[d]).filter(Boolean);
      if (earlier.length) context.push(`Earlier steps delivered: ${earlier.map((e) => `${e.deliverables.join(', ') || 'no files'} (${(e.summary || '').slice(0, 200)})`).join(' · ')} — read them with fs.read where you need them.`);
      const brief = `${context.join('\n')}\n\n${substitute(step.brief, run.params)}`;
      try {
        const item = await trails.delegate({ toAgentId: target.agentId, brief, budgetUsd: step.budgetUsd, deadline: step.deadline || null, evidence: step.evidence || [], venture: run.ventureId || null }, { by: run.delegatedBy });
        run.steps[step.id] = { ...run.steps[step.id], status: 'delegated', workItemId: item.id, agentId: target.agentId, delegatedAt: clock.now() };
        emit('recipe.run', { recipeRunId: run.id, recipeId: run.recipeId, version: run.version, status: 'step', by: run.by, ventureId: run.ventureId || '', stepId: step.id, workItemId: item.id, agentId: target.agentId, steps: recipe.steps.length, done: done.size });
      } catch (err) {
        run.steps[step.id] = { ...run.steps[step.id], status: 'failed', reason: `${err.code || 'DELEGATE_FAILED'}: ${err.message}` };
        await finish(run, 'failed', `step ${step.id} could not be delegated: ${err.message}`);
        return;
      }
    }
    await saveRuns();
  }

  async function finish(run, status, reason = null) {
    run.status = status;
    run.endedAt = clock.now();
    if (reason) run.notes.push(reason);
    const recipe = recipes.get(run.recipeId).versions.get(run.version);
    const deliverables = Object.values(run.steps).flatMap((s) => s.deliverables || []);
    if (status === 'done') {
      run.success = checkSuccess(recipe, deliverables);
      if (!run.success.ok) {
        run.status = 'failed';
        run.notes.push(`success check failed: ${run.success.missing.join('; ')}`);
      }
    }
    await saveRuns();
    emit('recipe.run', { recipeRunId: run.id, recipeId: run.recipeId, version: run.version, status: run.status, by: run.by, ventureId: run.ventureId || '', reason: run.notes.at(-1) || '', steps: recipe.steps.length, done: Object.values(run.steps).filter((s) => s.status === 'done').length, deliverables: deliverables.length });
  }

  bus.listen((event) => {
    if (event.type !== 'work.done') return;
    const p = event.payload;
    const run = runsState.runs.find((r) => r.status === 'running' && Object.values(r.steps).some((s) => s.workItemId === p.workItemId));
    if (!run) return;
    const [stepId, step] = Object.entries(run.steps).find(([, s]) => s.workItemId === p.workItemId);
    step.status = p.status === 'done' ? 'done' : 'failed';
    step.deliverables = p.deliverables || [];
    step.summary = (p.summary || '').slice(0, 2000);
    step.spentUsd = p.spentUsd || 0;
    step.endedAt = event.ts;
    (async () => {
      if (step.status === 'failed') return finish(run, 'failed', `step ${stepId} failed: ${p.reason || p.summary || 'no reason given'}`);
      const recipe = recipes.get(run.recipeId).versions.get(run.version);
      if (Object.values(run.steps).every((s) => s.status === 'done') && Object.keys(run.steps).length === recipe.steps.length) return finish(run, 'done');
      return delegateReady(run);
    })().catch((err) => log.error('recipe step handling failed:', err));
  });

  async function run({ recipeId, ventureId = null, params = {}, by = 'superintendent', version = null } = {}) {
    const entry = recipes.get(recipeId);
    if (!entry) throw fail('NOT_FOUND', `no recipe ${recipeId}`, 404);
    const recipe = entry.versions.get(version || entry.latest);
    if (!recipe) throw fail('NOT_FOUND', `no version ${version} of ${recipeId}`, 404);
    const refuse = (code, message) => {
      emit('recipe.run', { recipeRunId: `refused-${randomUUID().slice(0, 6)}`, recipeId, version: recipe.version, status: 'refused', by, ventureId: ventureId || '', reason: `${code}: ${message}`, steps: recipe.steps.length, done: 0 });
      throw fail(code, message, code === 'NOT_GRANTED' ? 403 : 400);
    };
    if (!mayRun(recipeId, by)) return refuse('NOT_GRANTED', `recipe ${recipeId} is not granted to ${by}`);
    const p = plan(recipe, { ventureId, params });
    if (!p.ok) return refuse(p.problems[0].code, p.problems.map((x) => x.message).join('; '));
    const record = { id: `recipe-run-${randomUUID().slice(0, 8)}`, recipeId, version: recipe.version, title: recipe.title, ventureId, by, delegatedBy: by === 'superintendent' ? 'superintendent' : CHIEF_ID, params: p.params, startedAt: clock.now(), endedAt: null, status: 'running', assignments: p.assignments, order: p.order, steps: Object.fromEntries(recipe.steps.map((s) => [s.id, { status: 'pending', title: s.title, specialty: s.specialty, deliverables: [], summary: '' }])), notes: [...p.notes], success: null };
    runsState.runs.unshift(record);
    if (runsState.runs.length > 200) runsState.runs.length = 200;
    await saveRuns();
    emit('recipe.run', { recipeRunId: record.id, recipeId, version: recipe.version, status: 'started', by, ventureId: ventureId || '', steps: recipe.steps.length, done: 0 });
    await delegateReady(record);
    return runById(record.id);
  }

  const tools = Object.freeze({
    'recipe.run': {
      name: 'recipe.run',
      description: 'Run a recipe you are granted (a versioned playbook: its steps become work items for Rangers of the right specialty, in order). Give the venture and any parameters it asks for. The run id comes back; progress shows at the Peak.',
      inputSchema: { type: 'object', required: ['recipeId'], additionalProperties: false, properties: { recipeId: { type: 'string', minLength: 2, maxLength: 60 }, ventureId: { type: 'string', maxLength: 80 }, params: { type: 'object' } } },
      confirm: false,
      summarize: (input) => `run recipe ${input.recipeId}${input.ventureId ? ` for ${input.ventureId}` : ''}`,
      async run(input, ctx) {
        if (!ctx.agentId) return { ok: false, error: 'no agent in this run' };
        try {
          const r = await run({ recipeId: input.recipeId, ventureId: input.ventureId || null, params: input.params || {}, by: ctx.agentId });
          return { ok: true, output: JSON.stringify({ recipeRunId: r.id, recipeId: r.recipeId, version: r.version, steps: r.order, delegated: Object.entries(r.steps).filter(([, s]) => s.status === 'delegated').map(([id, s]) => ({ step: id, to: s.agentId, workItemId: s.workItemId })), notes: r.notes }) };
        } catch (err) {
          return { ok: false, code: err.code || 'RECIPE_FAILED', error: err.message };
        }
      },
    },
  });

  return {
    tools,
    async init() {
      await fsp.mkdir(root, { recursive: true });
      await loadDir();
      await seedStarter();
      runsState = (await store.loadRecipeRuns(null)) || { version: 1, runs: [] };
      if (!Array.isArray(runsState.runs)) runsState = { version: 1, runs: [] };
      let changed = false;
      for (const r of runsState.runs) {
        if (r.status !== 'running') continue;
        r.status = 'failed';
        r.endedAt = clock.now();
        r.notes.push('the sidecar restarted while the recipe was running; its open work items were marked failed');
        changed = true;
      }
      if (changed) await saveRuns();
      return this;
    },
    list: () => [...recipes.values()].map((e) => summaryOf(e.versions.get(e.latest))).sort((a, b) => a.id.localeCompare(b.id)),
    get: (id, version = null) => {
      const e = recipes.get(id);
      if (!e) return null;
      const doc = e.versions.get(version || e.latest);
      return doc ? { ...doc, markdown: renderRecipe(doc), versions: [...e.versions.keys()].sort((a, b) => a - b), grants: grants.filter((g) => g.recipeId === id) } : null;
    },
    // A new recipe, or the next version of one (the version is assigned here).
    async save(doc, { by = 'superintendent' } = {}) {
      const base = { ...doc };
      delete base.version;
      const e = recipes.get(base.id);
      const next = { ...base, version: e ? e.latest + 1 : 1, source: base.source || `saved by ${by}` };
      const v = validateRecipe(next);
      if (!v.ok) throw fail('INVALID_RECIPE', `the recipe is not valid: ${v.errors.slice(0, 3).map((x) => `${x.path}: ${x.message}`).join('; ')}`);
      await writeRecipe(next);
      return summaryOf(next);
    },
    async grant({ recipeId, role = null, agentId = null, by = 'superintendent' }) {
      if (!recipes.has(recipeId)) throw fail('NOT_FOUND', `no recipe ${recipeId}`, 404);
      if ((role && agentId) || (!role && !agentId)) throw fail('BAD_REQUEST', 'grant to a role or to one agent');
      if (role && !GRANTEE_ROLES.includes(role)) throw fail('BAD_REQUEST', `role must be one of ${GRANTEE_ROLES.join(', ')} (Juniors do not run recipes)`);
      if (agentId) {
        const a = agents.get(agentId);
        if (!a) throw fail('NOT_FOUND', `no agent ${agentId}`, 404);
        if ((a.role || 'ranger') === 'junior_ranger') throw fail('BAD_REQUEST', 'Juniors do not run recipes');
      }
      if (!grants.some((g) => g.recipeId === recipeId && g.role === role && g.agentId === agentId)) {
        grants.push({ recipeId, role, agentId, at: clock.now(), by });
        await saveGrants();
      }
      return grants.filter((g) => g.recipeId === recipeId);
    },
    async revoke({ recipeId, role = null, agentId = null }) {
      const before = grants.length;
      grants = grants.filter((g) => !(g.recipeId === recipeId && (g.role || null) === role && (g.agentId || null) === agentId));
      if (grants.length !== before) await saveGrants();
      return grants.filter((g) => g.recipeId === recipeId);
    },
    grantsFor: (agentId) => grantedTo(agentId).map((d) => ({ id: d.id, title: d.title, version: d.version })),
    mayRun,
    plan: (recipeId, opts) => {
      const doc = latest(recipeId);
      if (!doc) throw fail('NOT_FOUND', `no recipe ${recipeId}`, 404);
      return plan(doc, opts);
    },
    run,
    runs: ({ limit = 50 } = {}) => runsState.runs.slice(0, limit),
    getRun: (id) => runById(id),
    skills: () => [...skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
    getSkill: (id) => skills.get(id) || null,
    async saveSkill(doc, { by = 'superintendent' } = {}) {
      const next = { ...doc, version: (skills.get(doc.id) ? (skills.get(doc.id).version || 1) + 1 : 1), source: doc.source || `saved by ${by}` };
      const v = validateSkill(next);
      if (!v.ok) throw fail('INVALID_SKILL', `the skill is not valid: ${v.errors.slice(0, 3).map((x) => `${x.path}: ${x.message}`).join('; ')}`);
      await writeSkill(next);
      return next;
    },
    // The lines a run's system prompt gets: the Ranger's skills (their instructions) and
    // the recipes it may run (ids and titles, so it knows what recipe.run offers).
    skillLines(agent) {
      if (!agent || !Array.isArray(agent.skills) || !agent.skills.length) return [];
      return agent.skills.map((id) => skills.get(id)).filter(Boolean).map((s) => `Skill "${s.title}": ${s.instructions}`);
    },
    recipeLines(agent) {
      if (!agent || !agent.id) return [];
      const mine = grantedTo(agent.id);
      return mine.length ? [`Recipes you may run with recipe.run: ${mine.map((d) => `${d.id} ("${d.title}", ${d.steps.length} step(s)${d.params && d.params.length ? `, params ${d.params.map((p) => p.name).join('/')}` : ''})`).join('; ')}.`] : [];
    },
    summary: () => ({ recipes: recipes.size, skills: skills.size, grants: grants.length, runs: { running: runsState.runs.filter((r) => r.status === 'running').length, done: runsState.runs.filter((r) => r.status === 'done').length, failed: runsState.runs.filter((r) => r.status === 'failed').length }, recent: runsState.runs.slice(0, 5).map((r) => ({ id: r.id, recipeId: r.recipeId, status: r.status, startedAt: r.startedAt, ventureId: r.ventureId, done: Object.values(r.steps).filter((s) => s.status === 'done').length, steps: Object.keys(r.steps).length })) }),
    flushed: () => saving,
    CHIEF_ID,
  };
}
