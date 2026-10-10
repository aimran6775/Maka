// Layout → tool allowlist → the `tools` object the loop consumes.
//
//   createToolGate({ getLayout, agentId, registry, workspaceDir, fetch, ask })
//     -> { definitions(), execute(call, ctx), granted() }
//
// definitions() lists only the tools the agent's room currently grants, so the model never
// sees a tool it cannot use. execute() re-checks the grant at call time (the user may
// reclaim an object mid-run), validates the input against the tool's schema, asks the user
// for confirmation when the tool requires it, then runs it. Every path returns a result;
// the loop turns it into exactly one agent.tool_result.
//
// ask({ runId, callId, tool, reason, input }) -> Promise<boolean>. The server implements it
// by emitting permission.prompt and waiting for permission.response (see sidecar/runs.js).
// When no `ask` is provided, tools that need confirmation are denied.

import { grantsFor } from '../../shared/world.js';
import { TOOLS, inputProblem } from './tools.js';

export function createToolGate({ getLayout, agentId, registry = TOOLS, workspaceDir, fetch: fetchImpl, ask, fetchTimeoutMs } = {}) {
  if (typeof getLayout !== 'function') throw new TypeError('createToolGate needs getLayout()');
  if (!agentId) throw new TypeError('createToolGate needs agentId');
  if (!workspaceDir) throw new TypeError('createToolGate needs workspaceDir');

  const granted = () => grantsFor(getLayout(), agentId).filter((name) => registry[name]);

  return {
    granted,
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
      if (tool.confirm) {
        if (typeof ask !== 'function') return { ok: false, error: `${call.name} needs user confirmation and no prompt channel is available` };
        let allowed = false;
        try {
          allowed = await ask({ runId: ctx.runId, callId: call.id, tool: call.name, reason: tool.description, input: call.input });
        } catch (err) {
          return { ok: false, error: `confirmation failed: ${err && err.message ? err.message : err}` };
        }
        if (!allowed) return { ok: false, error: `${call.name} was denied by the user` };
      }
      try {
        return await tool.run(call.input, { workspaceDir, fetch: fetchImpl, signal: ctx.signal, runId: ctx.runId, agentId, fetchTimeoutMs });
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    },
  };
}
