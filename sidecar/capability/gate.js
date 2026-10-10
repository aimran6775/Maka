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
//   act_capped  runs while the ledger says the domain's daily caps hold, else a Gate item
//   act_free    runs; logged in the ledger (and at the Gate for non-research domains)
//
// A tool's domain is `tool.domain` when the tool declares one, else shared/leash.js
// TOOL_DOMAINS. Tools with no domain (fs.write) keep the phase 1 per-call confirmation
// through ask() when they are marked `confirm: true`. A tool may declare
// `amountUsd(input)` (money the action moves) and `summarize(input)` (one line for the
// Gate card).
//
// ask({ runId, callId, tool, reason, input }) -> Promise<boolean>   (permission.prompt)
// submit(item) -> Promise<{ decision, notes, status }>              (gate.item, see
//   sidecar/gate-queue.js). When no submit is provided, draft actions are refused.
// ledger: sidecar/leash-ledger.js. Without one, act_capped cannot prove its cap and is
//   treated as draft.
// grants(): optional override of the fixture-derived grant list (roles and connectors in
//   later steps grant tools without a fixture).

import { grantsFor, agentOf } from '../../shared/world.js';
import { domainOfTool, resolveLeash, defaultLeash, LEASH_LEVEL_LABELS } from '../../shared/leash.js';
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
  const domainOf = (tool) => (tool.domain !== undefined ? tool.domain : domainOfTool(tool.name));
  const leashFor = (toolName) => {
    const tool = registry[toolName];
    if (!tool) return null;
    const domain = domainOf(tool);
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

  async function runAndRecord(tool, call, ctx, domain, amountUsd) {
    const result = await run(tool, call, ctx);
    if (result && result.ok && ledger) {
      try {
        await ledger.recordAction({ domain, amountUsd });
      } catch (err) {
        console.error('leash ledger record failed:', err);
      }
    }
    return result;
  }

  return {
    granted,
    leashFor,
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

      const domain = domainOf(tool);
      if (domain) {
        const entry = leashFor(call.name);
        const amountUsd = typeof tool.amountUsd === 'function' ? Number(tool.amountUsd(call.input)) || 0 : 0;
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
          amountUsd,
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
        if (entry.level === 'act_capped') {
          if (!ledger) {
            viaGate = true;
            gateReason = `leash for ${domain} is ${LEASH_LEVEL_LABELS.act_capped} but no ledger can prove the cap`;
          } else {
            const cap = ledger.checkCap({ domain, amountUsd, dailyCapUsd: entry.dailyCapUsd, dailyCapActions: entry.dailyCapActions });
            if (!cap.ok) {
              viaGate = true;
              gateReason = cap.reason;
            }
          }
        }
        // The judge could not review this turn (cap reached, not wired): fall back to Draft.
        if (!viaGate && ctx.review && ctx.review.escalate) {
          viaGate = true;
          gateReason = ctx.review.reason || 'the judge could not review this action; falls back to Draft for review';
        }
        if (viaGate) {
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
