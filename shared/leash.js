// Leash model: per-domain autonomy levels for an agent (docs/KICKOFF_BRIEF.md, Autonomy).
// Phase 1 defined the data (levels, domains, schema, defaults, tool → domain mapping);
// phase 2 step 1 enforces it in the capability gate (sidecar/capability/gate.js) and adds
// zone defaults, per-agent overrides, action caps and the earned-loosening setting. Frozen
// and additive-only like shared/events.js.
//
// Resolution order for an agent's level in a domain (resolveLeash):
//   leash.agents[agentId].domains[d]  →  leash.zones[roomId].domains[d]  →  leash.domains[d]
//   →  'draft' when nothing names the domain.

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
  // Phase 2 step 18: the Scout's kit. The brief is a workspace deliverable (no domain);
  // the judge reviews it inside the tool.
  'web.search': 'research',
  'web.read': 'research',
  'web.trends': 'research',
  'brief.submit': null,
  // Phase 2 step 12 mail tools. `mail.send` decides between outbound_messages and
  // publishing from its input (the tool declares a domain function); listed here as its
  // default so coverage checks see it.
  'mail.search': 'research',
  'mail.read': 'research',
  'mail.draft': null,
  'mail.send': 'outbound_messages',
  'mail.create_address': 'account_creation',
  // Phase 2 step 14: connector framework tools (reads from the local store / a sync).
  'connector.status': 'research',
  'connector.sync': 'research',
  // Phase 2 step 15: Stripe. A refund moves money out.
  'stripe.balance': 'research',
  'stripe.charges': 'research',
  'stripe.payouts': 'research',
  'stripe.refunds': 'research',
  'stripe.refund': 'money_out',
  // Phase 2 step 16: storefronts. Listing create / update is publishing; a price change is
  // money_in. A supplier or dropship purchase would be money_out, but neither platform's
  // API buys from suppliers, so no such tool exists (docs/DECISIONS.md D80).
  'shopify.products': 'research',
  'shopify.orders': 'research',
  'shopify.inventory': 'research',
  'shopify.create_product': 'publishing',
  'shopify.update_product': 'publishing',
  'shopify.set_price': 'money_in',
  'etsy.listings': 'research',
  'etsy.receipts': 'research',
  'etsy.inventory': 'research',
  'etsy.create_listing': 'publishing',
  'etsy.update_listing': 'publishing',
  'etsy.set_price': 'money_in',
  // Phase 2 step 17: ad networks. Budgets and new campaigns are money out (the daily
  // budget is the amount; activating a paused campaign counts its budget, pausing is 0).
  'meta_ads.campaigns': 'research',
  'meta_ads.insights': 'research',
  'meta_ads.create_campaign': 'money_out',
  'meta_ads.set_budget': 'money_out',
  'meta_ads.set_status': 'money_out',
  'google_ads.campaigns': 'research',
  'google_ads.metrics': 'research',
  'google_ads.create_campaign': 'money_out',
  'google_ads.set_budget': 'money_out',
  'google_ads.set_status': 'money_out',
  // Phase 2 step 13: every browser action is browser_control, reads included (a real
  // browser with the Ranger's cookies is never just research).
  'browser.open': 'browser_control',
  'browser.read': 'browser_control',
  'browser.click': 'browser_control',
  'browser.type': 'browser_control',
  'browser.upload': 'browser_control',
  'browser.download': 'browser_control',
  'browser.screenshot': 'browser_control',
});

// One domain entry. `dailyCapUsd` and `dailyCapActions` matter at 'act_capped': an action
// that would push the day's total over either cap becomes a Gate item instead.
const domainEntry = {
  type: 'object',
  required: ['level'],
  additionalProperties: false,
  properties: {
    level: { type: 'string', enum: LEASH_LEVELS },
    dailyCapUsd: { type: 'number', minimum: 0 },
    dailyCapActions: { type: 'integer', minimum: 0 },
  },
};
const domainMap = { type: 'object', additionalProperties: domainEntry };
const scoped = { type: 'object', additionalProperties: { type: 'object', required: ['domains'], additionalProperties: false, properties: { domains: domainMap } } };

export const LEASH_SCHEMA = deepFreeze({
  type: 'object',
  required: ['version', 'domains'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    domains: domainMap, // park default
    zones: scoped, // zone default, keyed by room id (added in phase 2, optional)
    agents: scoped, // per-agent override, keyed by agent id (added in phase 2, optional)
    // Earned loosening: after `approvals` Gate approvals in a row in one domain, the
    // ledger raises a proposal item to move that agent one level looser.
    earn: { type: 'object', additionalProperties: false, properties: { approvals: { type: 'integer', minimum: 1 } } },
  },
});

export const DEFAULT_EARN_APPROVALS = 5;

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
  const errors = [];
  const checkDomains = (domains, path) => {
    for (const d of Object.keys(domains || {})) if (!DOMAINS.includes(d)) errors.push({ path: `${path}.${d}`, message: 'unknown domain' });
  };
  checkDomains(leash.domains, '$.domains');
  for (const [k, v] of Object.entries(leash.zones || {})) checkDomains(v.domains, `$.zones.${k}.domains`);
  for (const [k, v] of Object.entries(leash.agents || {})) checkDomains(v.domains, `$.agents.${k}.domains`);
  return errors.length ? { ok: false, errors } : r;
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

// The next looser level, or null at the loosest.
export function nextLooser(level) {
  const i = LEASH_LEVELS.indexOf(level);
  return i >= 0 && i < LEASH_LEVELS.length - 1 ? LEASH_LEVELS[i + 1] : null;
}

// Resolves the effective entry for one agent and domain: agent override → zone default →
// park default → { level: 'draft' }. `scope` says which layer answered. Caps are taken
// from the same layer that set the level (an override replaces the whole entry).
export function resolveLeash(leash, { agentId, roomId } = {}, domain) {
  const pick = (entry, scope) => (entry ? { domain, level: entry.level, dailyCapUsd: entry.dailyCapUsd ?? null, dailyCapActions: entry.dailyCapActions ?? null, scope } : null);
  if (!leash || !DOMAINS.includes(domain)) return pick({ level: 'draft' }, 'default');
  const agent = agentId && leash.agents && leash.agents[agentId] && leash.agents[agentId].domains[domain];
  if (agent) return pick(agent, 'agent');
  const zone = roomId && leash.zones && leash.zones[roomId] && leash.zones[roomId].domains[domain];
  if (zone) return pick(zone, 'zone');
  const park = leash.domains && leash.domains[domain];
  if (park) return pick(park, 'park');
  return pick({ level: 'draft' }, 'default');
}

// Every domain resolved for one agent (for the inspector and the Gate card).
export function resolveAllLeash(leash, agent) {
  const out = {};
  for (const d of DOMAINS) out[d] = resolveLeash(leash, agent, d);
  return out;
}

// Returns a new leash policy with one agent's level in one domain set (caps carried over
// from the level the agent had). Used when a loosening proposal is approved.
export function withAgentLeash(leash, agentId, domain, entry) {
  const agents = { ...(leash.agents || {}) };
  const current = agents[agentId] ? { ...agents[agentId], domains: { ...agents[agentId].domains } } : { domains: {} };
  const clean = { level: entry.level };
  if (typeof entry.dailyCapUsd === 'number') clean.dailyCapUsd = entry.dailyCapUsd;
  if (typeof entry.dailyCapActions === 'number') clean.dailyCapActions = entry.dailyCapActions;
  current.domains[domain] = clean;
  agents[agentId] = current;
  return { ...leash, agents };
}
