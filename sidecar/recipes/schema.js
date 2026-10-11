// Recipes and skills as data (phase 4 step 12). Pure: schemas, validation, ordering,
// parameter substitution and the Markdown rendering.
//
// A recipe is a versioned playbook: a goal, steps that are task briefs (each for a
// specialty, with a budget, the evidence it must leave, the fixtures its Ranger's zone
// needs, what it depends on), the leash levels it needs, and a success check over the
// deliverables. A skill is a reusable instruction pack attached to a Ranger's persona.

import { validate } from '../../shared/schema.js';
import { SPECIALTY_NAMES, OBJECT_KINDS } from '../../shared/world.js';
import { DOMAINS, LEASH_LEVELS } from '../../shared/leash.js';

const ID = { type: 'string', minLength: 2, maxLength: 60, pattern: '^[a-z][a-z0-9-]*$' };
const str = (max) => ({ type: 'string', minLength: 1, maxLength: max });

export const RECIPE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'title', 'goal', 'steps'],
  additionalProperties: false,
  properties: {
    id: ID,
    version: { type: 'integer', minimum: 1 },
    title: str(120),
    goal: str(2000),
    summary: { type: 'string', maxLength: 600 },
    params: { type: 'array', maxItems: 12, items: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-zA-Z][a-zA-Z0-9_]*$' }, description: { type: 'string', maxLength: 300 }, required: { type: 'boolean' }, default: { type: 'string', maxLength: 300 } } } },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['id', 'title', 'specialty', 'brief', 'budgetUsd'],
        additionalProperties: false,
        properties: {
          id: ID,
          title: str(120),
          specialty: { type: 'string', enum: [...SPECIALTY_NAMES] },
          brief: str(6000),
          budgetUsd: { type: 'number', minimum: 0, maximum: 100 },
          evidence: { type: 'array', maxItems: 10, items: str(300) },
          dependsOn: { type: 'array', maxItems: 10, items: ID },
          fixtures: { type: 'array', maxItems: 8, items: { type: 'string', enum: Object.keys(OBJECT_KINDS) } },
          deadline: { type: 'string', maxLength: 80 },
        },
      },
    },
    requiredFixtures: { type: 'array', maxItems: 10, items: { type: 'string', enum: Object.keys(OBJECT_KINDS) } },
    leashNeeds: { type: 'array', maxItems: 10, items: { type: 'object', required: ['domain', 'level'], additionalProperties: false, properties: { domain: { type: 'string', enum: [...DOMAINS] }, level: { type: 'string', enum: [...LEASH_LEVELS] }, why: { type: 'string', maxLength: 300 } } } },
    successCheck: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['files', 'count', 'none'] }, patterns: { type: 'array', maxItems: 10, items: str(200) }, min: { type: 'integer', minimum: 1 }, note: { type: 'string', maxLength: 300 } } },
    notes: { type: 'string', maxLength: 2000 },
    source: { type: 'string', maxLength: 120 },
  },
});

export const SKILL_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'title', 'instructions'],
  additionalProperties: false,
  properties: { id: ID, version: { type: 'integer', minimum: 1 }, title: str(120), summary: { type: 'string', maxLength: 300 }, instructions: str(4000), specialties: { type: 'array', maxItems: 6, items: { type: 'string', enum: [...SPECIALTY_NAMES] } }, source: { type: 'string', maxLength: 120 } },
});

export function validateRecipe(doc) {
  const v = validate(RECIPE_SCHEMA, doc);
  if (!v.ok) return v;
  const errors = [];
  const ids = new Set();
  for (const s of doc.steps) {
    if (ids.has(s.id)) errors.push({ path: `steps.${s.id}`, message: 'duplicate step id' });
    ids.add(s.id);
  }
  for (const s of doc.steps) for (const d of s.dependsOn || []) {
    if (!ids.has(d)) errors.push({ path: `steps.${s.id}.dependsOn`, message: `unknown step ${d}` });
    if (d === s.id) errors.push({ path: `steps.${s.id}.dependsOn`, message: 'a step cannot depend on itself' });
  }
  if (!errors.length && !stepOrder(doc.steps)) errors.push({ path: 'steps', message: 'dependencies form a cycle' });
  if (doc.successCheck && doc.successCheck.kind === 'files' && !(doc.successCheck.patterns && doc.successCheck.patterns.length)) errors.push({ path: 'successCheck', message: 'a files check needs patterns' });
  if (doc.successCheck && doc.successCheck.kind === 'count' && !doc.successCheck.min) errors.push({ path: 'successCheck', message: 'a count check needs min' });
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export const validateSkill = (doc) => validate(SKILL_SCHEMA, doc);

// Topological order of the steps, or null on a cycle.
export function stepOrder(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map();
  const out = [];
  const visit = (id) => {
    const st = state.get(id);
    if (st === 'done') return true;
    if (st === 'busy') return false;
    state.set(id, 'busy');
    for (const d of byId.get(id).dependsOn || []) if (!byId.has(d) || !visit(d)) return false;
    state.set(id, 'done');
    out.push(byId.get(id));
    return true;
  };
  for (const s of steps) if (!visit(s.id)) return null;
  return out;
}

// Steps whose dependencies are all in `done`, not themselves started.
export function readySteps(steps, done, started) {
  return steps.filter((s) => !started.has(s.id) && !done.has(s.id) && (s.dependsOn || []).every((d) => done.has(d)));
}

// `{name}` in a brief → params[name]; unknown placeholders are left as they are.
export function substitute(text, params = {}) {
  return String(text).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

// Resolves the run's parameters: defaults, then the given values; missing required ones.
export function resolveParams(recipe, given = {}) {
  const out = {};
  const missing = [];
  for (const p of recipe.params || []) {
    const v = given[p.name] !== undefined && given[p.name] !== null && String(given[p.name]).trim() !== '' ? String(given[p.name]) : p.default;
    if (v === undefined || v === null) {
      if (p.required) missing.push(p.name);
      continue;
    }
    out[p.name] = String(v).slice(0, 1000);
  }
  return { params: out, missing };
}

// A glob with `*` (no slash) and `**` (anything), anchored, over posix-style paths.
export function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

export function checkSuccess(recipe, deliverables) {
  const check = recipe.successCheck || { kind: 'none' };
  if (check.kind === 'none') return { ok: true, kind: 'none', matched: [], missing: [] };
  if (check.kind === 'count') return { ok: deliverables.length >= check.min, kind: 'count', matched: deliverables.slice(0, 50), missing: deliverables.length >= check.min ? [] : [`${check.min} deliverable(s) expected, ${deliverables.length} found`] };
  const matched = [];
  const missing = [];
  for (const p of check.patterns) {
    const re = globToRegExp(p);
    const hit = deliverables.filter((d) => re.test(d));
    if (hit.length) matched.push(...hit);
    else missing.push(p);
  }
  return { ok: missing.length === 0, kind: 'files', matched: [...new Set(matched)], missing };
}

export function renderRecipe(recipe) {
  const lines = [`# ${recipe.title} (${recipe.id} v${recipe.version || 1})`, '', recipe.goal, ''];
  if (recipe.summary) lines.push(recipe.summary, '');
  if (recipe.params && recipe.params.length) lines.push('## Parameters', '', ...recipe.params.map((p) => `- {${p.name}}${p.required ? ' (required)' : ''}${p.default !== undefined ? ` = ${p.default}` : ''}: ${p.description || ''}`), '');
  lines.push('## Steps', '');
  for (const s of recipe.steps) lines.push(`### ${s.id}: ${s.title} → ${s.specialty} · $${s.budgetUsd.toFixed(2)}${s.dependsOn && s.dependsOn.length ? ` · after ${s.dependsOn.join(', ')}` : ''}${s.fixtures && s.fixtures.length ? ` · needs ${s.fixtures.map((f) => OBJECT_KINDS[f].label).join(', ')}` : ''}`, '', s.brief, '', ...(s.evidence && s.evidence.length ? ['Evidence:', ...s.evidence.map((e) => `- ${e}`), ''] : []));
  if (recipe.leashNeeds && recipe.leashNeeds.length) lines.push('## Leash needs', '', ...recipe.leashNeeds.map((l) => `- ${l.domain} at ${l.level}${l.why ? `: ${l.why}` : ''}`), '');
  if (recipe.successCheck) lines.push('## Success check', '', recipe.successCheck.kind === 'files' ? `Deliverables matching: ${recipe.successCheck.patterns.join(', ')}` : recipe.successCheck.kind === 'count' ? `At least ${recipe.successCheck.min} deliverable(s)` : 'None (the steps finishing is the result)', recipe.successCheck.note ? `\n${recipe.successCheck.note}` : '', '');
  if (recipe.notes) lines.push('## Notes', '', recipe.notes, '');
  return lines.join('\n');
}
