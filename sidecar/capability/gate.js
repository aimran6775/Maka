// Layout → tool allowlist → leash → the `tools` object the loop consumes.
//
//   createToolGate({ getLayout, agentId, registry, workspaceDir, fetch, ask, leash | getLeash,
//                    ledger, submit, grants })
//     -> { definitions(), execute(call, ctx), granted(), leashFor(toolName) }
//
// definitions() lists only the tools the agent's room currently grants, so the model never
// sees a tool it cannot use. execute() re-checks the grant at call time (the user may
// reclaim an object mid-run), validates the input against the tool's schema, then applies
// the leash (phase 2 step 1) for tools that have a domain:
//
//   observe     refused with a typed result ({ code: 'LEASH_OBSERVE' }); logged at the Gate
//   draft       parked as a pending Gate item via submit(); approve runs it, revise/reject
//               answer the call with the notes ({ code: 'GATE_REVISE' | 'GATE_REJECT' })
//   act_capped  reserves the amount in the ledger (safety M1: reserve → run → commit or
//               release, so concurrent runs cannot all pass the same cap) and runs while
//               the daily caps hold, else a Gate item
//   act_free    runs; logged in the ledger (and at the Gate for non-research domains);
//               in money_out / money_in a daily cap still holds here (safety M2)
//
// A tool's domain is `tool.domain` when the tool declares one (a string, or a function of
// the input for tools whose domain depends on what they send), else shared/leash.js
// TOOL_DOMAINS; a domain function that throws falls back to TOOL_DOMAINS, and with no
// fallback the call is refused DOMAIN_UNKNOWN (safety L3). Tools with no domain (fs.write) keep the phase 1 per-call confirmation
// through ask() when they are marked `confirm: true`. A tool may declare
// `amountUsd(input, toolContext)` (money the action moves: a finite number ≥ 0, where 0 is a
// proven "moves nothing"; null / NaN / a throw mean unknown, and an unknown money_out amount
// always goes to the Gate, safety H2) and `summarize(input)` (one line for the Gate card).
//
// ask({ runId, callId, tool, reason, input }) -> Promise<boolean>   (permission.prompt)
// submit(item) -> Promise<{ decision, notes, status }>              (gate.item, see
//   sidecar/gate-queue.js). When no submit is provided, draft actions are refused.
// ledger: sidecar/leash-ledger.js. Without one, act_capped cannot prove its cap and is
//   treated as draft.
// grants(): optional override of the fixture-derived grant list (roles and connectors in
//   later steps grant tools without a fixture).

import { grantsFor, agentOf } from '../../shared/world.js';
import { domainOfTool, resolveLeash, defaultLeash, LEASH_LEVEL_LABELS, MONEY_DOMAINS } from '../../shared/leash.js';
import { TOOLS, inputProblem } from './tools.js';

const DOMAIN_LOGGED_AT_GATE = (domain) => domain !== 'research';

export function summarizeCall(tool, input) {
  if (tool && typeof tool.summarize === 'function') {
    try {
      const s = tool.summarize(input);
      if (typeof s === 'string' && s) return s.slice(0, 200);
    } catch {
      /* fall through */
    }
  }
  let text = '';
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return `${tool ? tool.name : '?'} ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`;
}

export function createToolGate({
  getLayout,
  agentId,
  registry = TOOLS,
  workspaceDir,
  fetch: fetchImpl,
  ask,
  fetchTimeoutMs,
  leash = null,
  getLeash = null,
  ledger = null,
  submit = null,
  grants = null,
  toolContext = {},
} = {}) {
  if (typeof getLayout !== 'function') throw new TypeError('createToolGate needs getLayout()');
  if (!agentId) throw new TypeError('createToolGate needs agentId');
  if (!workspaceDir) throw new TypeError('createToolGate needs workspaceDir');

  const currentLeash = typeof getLeash === 'function' ? getLeash : () => leash || defaultLeash();
  const granted = () => {
    const base = typeof grants === 'function' ? grants(getLayout(), agentId) : grantsFor(getLayout(), agentId);
    return [...new Set(base)].filter((name) => registry[name]).sort();
  };
  // The tool's leash domain. Safety L3: a domain() that throws does not make the tool
  // domain-free; it falls back to the tool's known domain in TOOL_DOMAINS, and a tool with
  // no fallback is refused (`failed` says so) rather than run under the no-domain path.
  const domainOf = (tool, input) => {
    if (typeof tool.domain === 'function') {
      try {
        return { domain: tool.domain(input || {}) || null, failed: false };
      } catch (err) {
        const fallback = domainOfTool(tool.name);
        return fallback ? { domain: fallback, failed: false, fellBack: true } : { domain: null, failed: true, error: err && err.message ? err.message : String(err) };
      }
    }
    return { domain: tool.domain !== undefined ? tool.domain : domainOfTool(tool.name), failed: false };
  };
  const leashFor = (toolName, input) => {
    const tool = registry[toolName];
    if (!tool) return null;
    const { domain } = domainOf(tool, input);
    if (!domain) return null;
    const agent = agentOf(getLayout(), agentId);
    return resolveLeash(currentLeash(), { agentId, roomId: agent ? agent.roomId : undefined }, domain);
  };

  async function run(tool, call, ctx) {
    try {
      return await tool.run(call.input, { ...toolContext, workspaceDir, fetch: fetchImpl, signal: ctx.signal, runId: ctx.runId, agentId, turn: ctx.turn, fetchTimeoutMs });
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  // Phase 4 step 17: a tool with `settlesLater: true` proves its amount for the cap check
  // and the Gate card but moves no money when it runs (a purchase request holds the amount
  // in the ledger itself and settles it at the receipt), so the action is counted at $0.
  async function runAndRecord(tool, call, ctx, domain, amountUsd) {
    const result = await run(tool, call, ctx);
    if (result && result.ok && ledger) {
      try {
        await ledger.recordAction({ domain, amountUsd: tool.settlesLater ? 0 : amountUsd, agentId });
      } catch (err) {
        console.error('leash ledger record failed:', err);
      }
    }
    return result;
  }

  // Safety M1: a capped action holds its reservation while it runs; success commits it
  // (the ledger records the action), anything else releases it.
  async function runReserved(tool, call, ctx, reservation) {
    let result;
    try {
      result = await run(tool, call, ctx);
    } catch (err) {
      reservation.release();
      throw err;
    }
    if (result && result.ok) {
      try {
        if (tool.settlesLater) {
          reservation.release();
          await ledger.recordAction({ domain: reservation.domain, amountUsd: 0, agentId });
        } else await reservation.commit();
      } catch (err) {
        console.error('leash ledger record failed:', err);
      }
    } else reservation.release();
    return result;
  }

  return {
    granted,
    leashFor,
    tool: (name) => registry[name] || null,
    definitions() {
      return granted().map((name) => {
        const t = registry[name];
        return { name: t.name, description: t.description, inputSchema: t.inputSchema };
      });
    },
    async execute(call, ctx = {}) {
      const tool = registry[call.name];
      if (!tool) return { ok: false, error: `unknown tool "${call.name}"` };
      if (!granted().includes(call.name)) {
        return { ok: false, error: `tool "${call.name}" is not granted: no object providing it is placed in this agent's room` };
      }
      const problem = inputProblem(tool, call.input);
      if (problem) return { ok: false, error: `invalid input for ${call.name}: ${problem}` };

      const resolved = domainOf(tool, call.input);
      if (resolved.failed) return { ok: false, code: 'DOMAIN_UNKNOWN', error: `${call.name} could not say which leash domain it falls under (${resolved.error}) and has no known domain to fall back on, so it does not run` };
      const domain = resolved.domain;
      if (domain) {
        const entry = leashFor(call.name, call.input);
        // The money an action moves, as the tool proves it. Safety H2: for money_out a
        // tool must prove its amount (a finite number ≥ 0, where 0 means "proven to move
        // nothing", e.g. pausing a campaign); null, NaN, a negative, a throw or no
        // amountUsd at all is "unknown", and an unknown amount always needs the Gate,
        // whatever the leash level, because no cap can be checked against it.
        const amount = amountOf(tool, call.input, { ...toolContext, agentId });
        const amountUnknown = domain === 'money_out' ? amount === null : false;
        const amountUsd = amount === null ? 0 : amount;
        const base = {
          agentId,
          kind: 'action',
          domain,
          tool: call.name,
          summary: summarizeCall(tool, call.input),
          runId: ctx.runId,
          callId: call.id,
          turn: ctx.turn,
          level: entry.level,
          amountUsd: amountUnknown ? undefined : amountUsd,
          evidence: evidenceFor(call, ctx),
        };
        const log = async (status, reason) => {
          if (!submit || !submit.log) return;
          try {
            await submit.log({ ...base, status, reason });
          } catch (err) {
            console.error('gate log failed:', err);
          }
        };
        if (entry.level === 'observe') {
          await log('refused', `leash for ${domain} is ${LEASH_LEVEL_LABELS.observe}`);
          return { ok: false, code: 'LEASH_OBSERVE', error: `refused by the leash: ${domain} is at "${LEASH_LEVEL_LABELS.observe}" for this Ranger, so ${call.name} cannot run` };
        }
        let viaGate = entry.level === 'draft';
        let gateReason = viaGate ? `leash for ${domain} is ${LEASH_LEVEL_LABELS.draft}` : null;
        let reservation = null; // safety M1: the cap is reserved before the action runs
        // A tool may hold itself at the Gate whatever the leash says (safety 2026-10-11 M1:
        // an MCP tool that is new or changed since the Superintendent accepted the server's
        // tools waits at the Gate until accepted). The hook answers a reason or nothing.
        if (!viaGate && typeof tool.holdAtGate === 'function') {
          let hold = null;
          try {
            hold = tool.holdAtGate(call.input, { ...ctx, agentId });
          } catch (err) {
            hold = `the tool could not say whether it may run (${err && err.message ? err.message : err})`;
          }
          if (hold) {
            viaGate = true;
            gateReason = String(hold);
          }
        }
        if (amountUnknown) {
          viaGate = true;
          gateReason = `the amount this ${domain} action moves cannot be proven (${call.name} names no campaign-level or record-level figure), so no cap can be checked; it needs a decision at the Entrance Gate`;
        } else if (entry.level === 'act_capped' || (entry.level === 'act_free' && MONEY_DOMAINS.includes(domain) && hasCap(entry))) {
          // Safety M2: in the money domains a cap holds at Act freely too, so an approved
          // proposal or a hand-set level never silently removes the hard daily cap.
          if (!ledger) {
            viaGate = true;
            gateReason = `leash for ${domain} is ${LEASH_LEVEL_LABELS[entry.level]} but no ledger can prove the cap`;
          } else if (!viaGate && !(ctx.review && ctx.review.escalate)) {
            reservation = ledger.reserve({ domain, amountUsd, dailyCapUsd: entry.dailyCapUsd, dailyCapActions: entry.dailyCapActions, agentId, scope: entry.scope });
            reservation.domain = domain;
            if (!reservation.ok) {
              viaGate = true;
              gateReason = reservation.reason;
              reservation = null;
            }
          }
        }
        // The judge could not review this turn (cap reached, not wired): fall back to Draft.
        if (!viaGate && ctx.review && ctx.review.escalate) {
          viaGate = true;
          gateReason = ctx.review.reason || 'the judge could not review this action; falls back to Draft for review';
        }
        if (viaGate) {
          if (reservation) reservation.release();
          if (!submit || typeof submit.submit !== 'function') return { ok: false, code: 'GATE_UNAVAILABLE', error: `${call.name} needs a decision at the Entrance Gate and no Gate queue is available` };
          let decision;
          try {
            decision = await submit.submit({ ...base, reason: gateReason });
          } catch (err) {
            return { ok: false, code: 'GATE_FAILED', error: `Gate decision failed: ${err && err.message ? err.message : err}` };
          }
          if (decision.decision === 'approve') return runAndRecord(tool, call, ctx, domain, amountUsd);
          if (decision.decision === 'revise') return { ok: false, code: 'GATE_REVISE', error: `sent back for revision at the Entrance Gate${decision.notes ? `: ${decision.notes}` : ''}` };
          if (decision.status === 'expired') return { ok: false, code: 'GATE_EXPIRED', error: `the Entrance Gate did not decide on ${call.name} before the run ended` };
          return { ok: false, code: 'GATE_REJECT', error: `rejected at the Entrance Gate${decision.notes ? `: ${decision.notes}` : ''}` };
        }
        if (DOMAIN_LOGGED_AT_GATE(domain)) await log('allowed', `leash for ${domain} is ${LEASH_LEVEL_LABELS[entry.level]}`);
        if (reservation) return runReserved(tool, call, ctx, reservation);
        return runAndRecord(tool, call, ctx, domain, amountUsd);
      }

      if (tool.confirm) {
        if (typeof ask !== 'function') return { ok: false, error: `${call.name} needs user confirmation and no prompt channel is available` };
        let allowed = false;
        try {
          allowed = await ask({ runId: ctx.runId, callId: call.id, tool: call.name, reason: tool.description, input: call.input, leash: undefined });
        } catch (err) {
          return { ok: false, error: `confirmation failed: ${err && err.message ? err.message : err}` };
        }
        if (!allowed) return { ok: false, error: `${call.name} was denied by the user` };
      }
      return run(tool, call, ctx);
    },
  };
}

const hasCap = (entry) => typeof entry.dailyCapUsd === 'number' || typeof entry.dailyCapActions === 'number';

// A finite amount ≥ 0 the tool proves, else null (unknown). Tools without amountUsd prove
// nothing; tools outside money domains never need to.
function amountOf(tool, input, toolCtx) {
  if (typeof tool.amountUsd !== 'function') return null;
  let v;
  try {
    v = tool.amountUsd(input, toolCtx);
  } catch {
    return null;
  }
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function evidenceFor(call, ctx) {
  const out = [];
  if (ctx.turnText) out.push({ kind: 'said', text: String(ctx.turnText).slice(0, 1000) });
  if (ctx.runId) out.push({ kind: 'run', text: `run ${ctx.runId}${ctx.turn ? `, turn ${ctx.turn}` : ''}`, ref: ctx.runId });
  let input = '';
  try {
    input = JSON.stringify(call.input);
  } catch {
    input = String(call.input);
  }
  out.push({ kind: 'input', text: input.length > 2000 ? `${input.slice(0, 2000)}…` : input });
  return out;
}
