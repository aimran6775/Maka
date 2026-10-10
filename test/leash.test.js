import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEASH_LEVELS, DOMAINS, TOOL_DOMAINS, LEASH_SCHEMA, defaultLeash, validateLeash, leashFor, domainOfTool, looserThan, LEASH_LEVEL_LABELS, resolveLeash, resolveAllLeash, withAgentLeash, nextLooser, DEFAULT_EARN_APPROVALS } from '../shared/leash.js';
import { TOOL_NAMES } from '../sidecar/capability/tools.js';
import { PAYLOAD_SCHEMAS } from '../shared/events.js';

test('levels are ordered, labels exist, data is frozen', () => {
  assert.deepEqual([...LEASH_LEVELS], ['observe', 'draft', 'act_capped', 'act_free']);
  for (const l of LEASH_LEVELS) assert.ok(LEASH_LEVEL_LABELS[l]);
  assert.equal(looserThan('act_free', 'draft'), true);
  assert.equal(looserThan('observe', 'draft'), false);
  assert.equal(Object.isFrozen(LEASH_SCHEMA), true);
  assert.equal(Object.isFrozen(DOMAINS), true);
  // The permission.prompt leash enum must match the leash levels (contract and model agree).
  assert.deepEqual(PAYLOAD_SCHEMAS['permission.prompt'].properties.leash.properties.level.enum, [...LEASH_LEVELS]);
});

test('domains are exactly the brief\'s final phase 1 list', () => {
  assert.deepEqual([...DOMAINS], ['outbound_messages', 'publishing', 'money_out', 'money_in', 'data_deletion', 'account_settings', 'account_creation', 'browser_control', 'research']);
});

test('defaults follow the brief: draft everywhere, research act_free, money_out capped at 0', () => {
  const leash = defaultLeash();
  assert.equal(validateLeash(leash).ok, true);
  assert.deepEqual(Object.keys(leash.domains).sort(), [...DOMAINS].sort());
  assert.equal(leash.domains.browser_control.level, 'draft');
  assert.equal(leash.domains.account_creation.level, 'draft');
  assert.equal(leash.domains.research.level, 'act_free');
  assert.equal(leash.domains.outbound_messages.level, 'draft');
  assert.equal(leash.domains.money_out.level, 'draft');
  assert.equal(leash.domains.money_out.dailyCapUsd, 0);
});

test('every phase 1 tool is mapped (to a domain or explicitly to none); leashFor reports domain and level', () => {
  for (const t of TOOL_NAMES) {
    assert.ok(t in TOOL_DOMAINS, `${t} is mapped`);
    assert.ok(TOOL_DOMAINS[t] === null || DOMAINS.includes(TOOL_DOMAINS[t]), `${t} maps to a real domain or null`);
  }
  const leash = defaultLeash();
  assert.equal(leashFor(leash, 'fs.write'), null, 'workspace writes have no leash domain');
  assert.deepEqual(leashFor(leash, 'web.fetch'), { domain: 'research', level: 'act_free', dailyCapUsd: null });
  assert.equal(leashFor(leash, 'teleport'), null);
  assert.equal(domainOfTool('fs.read'), 'research');
  assert.equal(leashFor({ version: 1, domains: {} }, 'fs.read').level, 'draft', 'missing entry defaults to draft');
});

test('validation rejects unknown domains, levels and caps', () => {
  assert.equal(validateLeash({ version: 1, domains: { research: { level: 'act_free' } } }).ok, true);
  assert.equal(validateLeash({ version: 1, domains: { piloting: { level: 'draft' } } }).ok, false);
  assert.equal(validateLeash({ version: 1, domains: { research: { level: 'yolo' } } }).ok, false);
  assert.equal(validateLeash({ version: 1, domains: { money_out: { level: 'act_capped', dailyCapUsd: -1 } } }).ok, false);
  assert.equal(validateLeash({ version: 1, domains: { money_out: { level: 'act_capped', extra: 1 } } }).ok, false);
  assert.equal(validateLeash({ version: 1 }).ok, false);
});

test('resolution order: agent override → zone default → park default → draft; proposals move one level', () => {
  const leash = defaultLeash();
  leash.zones = { camp: { domains: { publishing: { level: 'act_capped', dailyCapActions: 3 } } } };
  leash.agents = { ada: { domains: { publishing: { level: 'act_free' } } } };
  assert.equal(validateLeash(leash).ok, true);
  assert.deepEqual(resolveLeash(leash, { agentId: 'ada', roomId: 'camp' }, 'publishing'), { domain: 'publishing', level: 'act_free', dailyCapUsd: null, dailyCapActions: null, scope: 'agent' });
  assert.deepEqual(resolveLeash(leash, { agentId: 'bob', roomId: 'camp' }, 'publishing'), { domain: 'publishing', level: 'act_capped', dailyCapUsd: null, dailyCapActions: 3, scope: 'zone' });
  assert.deepEqual(resolveLeash(leash, { agentId: 'bob', roomId: 'hq' }, 'publishing').scope, 'park');
  assert.deepEqual(resolveLeash(leash, { agentId: 'bob', roomId: 'hq' }, 'money_out'), { domain: 'money_out', level: 'draft', dailyCapUsd: 0, dailyCapActions: null, scope: 'park' });
  assert.deepEqual(resolveLeash({ version: 1, domains: {} }, {}, 'money_out'), { domain: 'money_out', level: 'draft', dailyCapUsd: null, dailyCapActions: null, scope: 'default' });
  assert.equal(resolveLeash(leash, {}, 'piloting').level, 'draft');
  assert.deepEqual(Object.keys(resolveAllLeash(leash, { agentId: 'ada', roomId: 'camp' })).sort(), [...DOMAINS].sort());
  const next = withAgentLeash(leash, 'bob', 'money_out', { level: 'act_capped', dailyCapUsd: 0, dailyCapActions: null });
  assert.deepEqual(next.agents.bob.domains.money_out, { level: 'act_capped', dailyCapUsd: 0 });
  assert.deepEqual(next.agents.ada, leash.agents.ada, 'other overrides untouched');
  assert.equal(validateLeash(next).ok, true);
  assert.equal(nextLooser('draft'), 'act_capped');
  assert.equal(nextLooser('act_free'), null);
  assert.equal(DEFAULT_EARN_APPROVALS, 5);
  assert.equal(validateLeash({ ...leash, earn: { approvals: 3 } }).ok, true);
  assert.equal(validateLeash({ ...leash, earn: { approvals: 0 } }).ok, false);
  assert.equal(validateLeash({ ...leash, zones: { camp: { domains: { piloting: { level: 'draft' } } } } }).ok, false);
  assert.equal(validateLeash({ ...leash, agents: { x: { level: 'draft' } } }).ok, false);
});
