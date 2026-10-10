// Model router: picks provider + model per step from a policy object.
//
// Two tiers (docs/KICKOFF_BRIEF.md, Model strategy): WORKER (local, routine turns) and
// JUDGE (Claude, the steps where quality decides the outcome). The policy is plain data
// so it can be persisted and edited; the router only reads it.
//
//   policy = {
//     version: 1,
//     tiers: { worker: { provider, model }, judge: { provider, model } },
//     steps: { turn: 'worker', plan: 'judge', review: 'judge', ambiguity: 'judge', gate_action: 'judge', reflect: 'judge' },
//     stepModels: { plan: 'claude-opus-5-5', reflect: 'claude-opus-5-5' },   // per-step model override
//     caps: { judgeCallsPerRun: 20, judgeCallsPerDay: 500, judgeUsdPerDay: 10 }
//   }
//
//   createRouter(policy).route({ kind }) -> { tier, provider, model }
//
// Owner defaults (docs/PHASE2_BRIEF.md): the judge reviews on claude-sonnet-5-5; the Chief
// Ranger plans and reflects on claude-opus-5-5; judge spend is capped at 10 USD per day.
// The judge step lives in sidecar/judge.js and hooks into runLoop({ review }).

import { validate, deepFreeze } from '../shared/schema.js';

export const STEP_KINDS = deepFreeze(['turn', 'plan', 'review', 'ambiguity', 'gate_action', 'reflect']);
export const TIERS = deepFreeze(['worker', 'judge', 'hosted_worker']);

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
    tiers: { type: 'object', required: ['worker', 'judge'], additionalProperties: false, properties: { worker: tierSpec, judge: tierSpec, hosted_worker: tierSpec } },
    // Opt-in: when the local worker is unreachable, run routine turns on the hosted worker
    // instead (recorded as tier 'hosted_worker'). Absent = no fallback (D19).
    fallback: { type: 'object', additionalProperties: false, properties: { worker: { type: 'string', enum: ['hosted_worker'] } } },
    steps: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(STEP_KINDS.map((k) => [k, { type: 'string', enum: TIERS }])),
    },
    stepModels: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(STEP_KINDS.map((k) => [k, { type: 'string', minLength: 1 }])),
    },
    caps: {
      type: 'object',
      additionalProperties: false,
      properties: { judgeCallsPerRun: { type: 'integer', minimum: 0 }, judgeCallsPerDay: { type: 'integer', minimum: 0 }, judgeUsdPerDay: { type: 'number', minimum: 0 }, hostedWorkerCallsPerDay: { type: 'integer', minimum: 0 } },
    },
  },
});

export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_CHIEF_MODEL = 'claude-opus-5-5';
export const DEFAULT_JUDGE_USD_PER_DAY = 10;
export const DEFAULT_HOSTED_WORKER_CALLS_PER_DAY = 2000;
export const DEFAULT_HOSTED_WORKER_MODEL = 'Qwen/Qwen2.5-72B-Instruct';

export function defaultPolicy() {
  return {
    version: 1,
    tiers: {
      worker: { provider: 'ollama' }, // model: first locally installed model unless set
      judge: { provider: 'anthropic', model: DEFAULT_JUDGE_MODEL },
      hosted_worker: { provider: 'huggingface', model: DEFAULT_HOSTED_WORKER_MODEL }, // used only when routed or opted in
    },
    steps: { turn: 'worker', plan: 'judge', review: 'judge', ambiguity: 'judge', gate_action: 'judge', reflect: 'judge' },
    stepModels: { plan: DEFAULT_CHIEF_MODEL, reflect: DEFAULT_CHIEF_MODEL },
    caps: { judgeCallsPerRun: 20, judgeCallsPerDay: 500, judgeUsdPerDay: DEFAULT_JUDGE_USD_PER_DAY, hostedWorkerCallsPerDay: DEFAULT_HOSTED_WORKER_CALLS_PER_DAY },
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
    route({ kind = 'turn', tier: forced = null } = {}) {
      const tier = forced || this.tierFor(kind);
      const spec = policy.tiers[tier];
      if (!spec) throw new Error(`policy has no "${tier}" tier`);
      const override = !forced && policy.stepModels && policy.stepModels[kind];
      return { tier, provider: spec.provider, model: override || spec.model || null };
    },
    fallbackFor(tier) {
      return (policy.fallback && policy.fallback[tier] && policy.tiers[policy.fallback[tier]]) ? policy.fallback[tier] : null;
    },
    caps() {
      const c = policy.caps || {};
      return {
        judgeCallsPerRun: c.judgeCallsPerRun ?? 20,
        judgeCallsPerDay: c.judgeCallsPerDay ?? 500,
        judgeUsdPerDay: c.judgeUsdPerDay ?? DEFAULT_JUDGE_USD_PER_DAY,
        hostedWorkerCallsPerDay: c.hostedWorkerCallsPerDay ?? DEFAULT_HOSTED_WORKER_CALLS_PER_DAY,
      };
    },
  };
}
