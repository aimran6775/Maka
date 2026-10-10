// Model router: picks provider + model per step from a policy object.
//
// Two tiers (docs/KICKOFF_BRIEF.md, Model strategy): WORKER (local, routine turns) and
// JUDGE (Claude, the steps where quality decides the outcome). The policy is plain data
// so it can be persisted and edited; the router only reads it.
//
//   policy = {
//     version: 1,
//     tiers: { worker: { provider, model }, judge: { provider, model } },
//     steps: { turn: 'worker', plan: 'judge', review: 'judge', ambiguity: 'judge', gate_action: 'judge' },
//     caps: { judgeCallsPerRun: 20, judgeCallsPerDay: 500 }
//   }
//
//   createRouter(policy).route({ kind }) -> { tier, provider, model }
//
// Phase 1 uses only kind 'turn'. The judge step in the loop is phase 2; the hook point for
// it is runLoop({ review }) in sidecar/loop.js.

import { validate, deepFreeze } from '../shared/schema.js';

export const STEP_KINDS = deepFreeze(['turn', 'plan', 'review', 'ambiguity', 'gate_action']);
export const TIERS = deepFreeze(['worker', 'judge']);

const tierSpec = {
  type: 'object',
  required: ['provider'],
  additionalProperties: false,
  properties: { provider: { type: 'string', minLength: 1 }, model: { type: 'string' } },
};

export const POLICY_SCHEMA = deepFreeze({
  type: 'object',
  required: ['version', 'tiers', 'steps'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    tiers: { type: 'object', required: ['worker', 'judge'], additionalProperties: false, properties: { worker: tierSpec, judge: tierSpec } },
    steps: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(STEP_KINDS.map((k) => [k, { type: 'string', enum: TIERS }])),
    },
    caps: {
      type: 'object',
      additionalProperties: false,
      properties: { judgeCallsPerRun: { type: 'integer', minimum: 0 }, judgeCallsPerDay: { type: 'integer', minimum: 0 } },
    },
  },
});

export function defaultPolicy() {
  return {
    version: 1,
    tiers: {
      worker: { provider: 'ollama' }, // model: first locally installed model unless set
      judge: { provider: 'anthropic' }, // model: the provider default (claude-opus-5-5)
    },
    steps: { turn: 'worker', plan: 'judge', review: 'judge', ambiguity: 'judge', gate_action: 'judge' },
    caps: { judgeCallsPerRun: 20, judgeCallsPerDay: 500 },
  };
}

export function validatePolicy(policy) {
  return validate(POLICY_SCHEMA, policy);
}

export function createRouter(policy = defaultPolicy()) {
  const r = validatePolicy(policy);
  if (!r.ok) {
    const err = new Error(`policy invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    err.code = 'POLICY_INVALID';
    throw err;
  }
  return {
    policy,
    tierFor(kind) {
      if (!STEP_KINDS.includes(kind)) throw new Error(`unknown step kind "${kind}"`);
      return policy.steps[kind] || (kind === 'turn' ? 'worker' : 'judge');
    },
    route({ kind = 'turn' } = {}) {
      const tier = this.tierFor(kind);
      const spec = policy.tiers[tier];
      return { tier, provider: spec.provider, model: spec.model || null };
    },
  };
}
