// Leash model: per-domain autonomy levels for an agent (docs/KICKOFF_BRIEF.md, Autonomy).
// Phase 1 defines the data (levels, domains, schema, defaults, tool → domain mapping) so
// the capability gate can enforce it in phase 2. Phase 1 only shows the current level on
// the permission card. Frozen and additive-only like shared/events.js.

import { deepFreeze, validate } from './schema.js';

// Ordered from tightest to loosest.
export const LEASH_LEVELS = deepFreeze(['observe', 'draft', 'act_capped', 'act_free']);

export const LEASH_LEVEL_LABELS = deepFreeze({
  observe: 'Observe',
  draft: 'Draft for review',
  act_capped: 'Act with cap',
  act_free: 'Act freely',
});

// Final for the phase 1 data model (docs/KICKOFF_BRIEF.md, "Leash domains").
export const DOMAINS = deepFreeze([
  'outbound_messages',
  'publishing',
  'money_out',
  'money_in',
  'data_deletion',
  'account_settings',
  'account_creation',
  'browser_control',
  'research', // read-only: fetching pages, reading workspace files
]);

// Which domain each phase 1 tool belongs to. Phase 2 connectors add their own rows.
// `fs.write` has no leash domain: it only touches the Ranger's own workspace, so it is not
// outbound, money or an account. It is still confirmed per call at the Gate (tools.js
// `confirm: true`); leashFor() returns null for it and the prompt says so.
export const TOOL_DOMAINS = deepFreeze({
  'fs.read': 'research',
  'web.fetch': 'research',
  'fs.write': null,
});

export const LEASH_SCHEMA = deepFreeze({
  type: 'object',
  required: ['version', 'domains'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    domains: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['level'],
        additionalProperties: false,
        properties: {
          level: { type: 'string', enum: LEASH_LEVELS },
          dailyCapUsd: { type: 'number', minimum: 0 },
        },
      },
    },
  },
});

// Brief defaults: everything "Draft for review" except read-only research, which is
// "Act freely"; money out carries a hard per-day cap even when loosened.
export function defaultLeash() {
  const domains = {};
  for (const d of DOMAINS) domains[d] = { level: 'draft' };
  domains.research = { level: 'act_free' };
  domains.money_out = { level: 'draft', dailyCapUsd: 0 };
  return { version: 1, domains };
}

export function validateLeash(leash) {
  const r = validate(LEASH_SCHEMA, leash);
  if (!r.ok) return r;
  const unknown = Object.keys(leash.domains).filter((d) => !DOMAINS.includes(d));
  if (unknown.length) return { ok: false, errors: unknown.map((d) => ({ path: `$.domains.${d}`, message: 'unknown domain' })) };
  return r;
}

export function domainOfTool(toolName) {
  return TOOL_DOMAINS[toolName] || null;
}

// Current level for a tool under a leash policy; null when the tool has no domain.
export function leashFor(leash, toolName) {
  const domain = domainOfTool(toolName);
  if (!domain) return null;
  const entry = leash && leash.domains && leash.domains[domain];
  return { domain, level: entry ? entry.level : 'draft', dailyCapUsd: entry && entry.dailyCapUsd !== undefined ? entry.dailyCapUsd : null };
}

export function looserThan(a, b) {
  return LEASH_LEVELS.indexOf(a) > LEASH_LEVELS.indexOf(b);
}
