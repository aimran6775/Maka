import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEASH_LEVELS, DOMAINS, TOOL_DOMAINS, LEASH_SCHEMA, defaultLeash, validateLeash, leashFor, domainOfTool, looserThan, LEASH_LEVEL_LABELS } from '../shared/leash.js';
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
