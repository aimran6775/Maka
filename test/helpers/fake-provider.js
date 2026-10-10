// A scripted provider for tests. Each turn is a list of chunks (see sidecar/loop.js for the
// chunk shapes) or a function (request, ctx) => chunks | Promise<chunks> | throws.
//
//   const provider = fakeProvider([
//     [text('Hello'), end()],
//   ]);
//
// Helpers build chunks; `usage` defaults to small numbers so cost events are reconciled
// when a price is supplied.

export function text(t, index = 0) {
  return { type: 'text_delta', index, text: t };
}
export function toolStart(id, name, index = 1) {
  return { type: 'tool_use_start', index, id, name };
}
export function toolJson(partialJson, index = 1) {
  return { type: 'tool_input_delta', index, partialJson };
}
export function end(stopReason = 'end_turn', usage = { inputTokens: 10, outputTokens: 5 }) {
  return { type: 'message_end', stopReason, usage };
}
export function toolCall(id, name, input, index = 1) {
  return [toolStart(id, name, index), toolJson(JSON.stringify(input), index)];
}

export function fakeProvider(turns, { name = 'fake' } = {}) {
  const requests = [];
  let i = 0;
  return {
    name,
    requests,
    async *stream(request, ctx = {}) {
      requests.push({ ...request, messages: JSON.parse(JSON.stringify(request.messages)) });
      const script = turns[i++];
      if (script === undefined) throw new Error(`fake provider has no script for turn ${i}`);
      const chunks = typeof script === 'function' ? await script(request, ctx) : script;
      const abortErr = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return err;
      };
      for (const chunk of chunks) {
        if (ctx.signal && ctx.signal.aborted) throw abortErr();
        if (typeof chunk === 'function') {
          // A function chunk may wait; like a real socket it must give up on abort.
          await new Promise((resolve, reject) => {
            const onAbort = () => reject(abortErr());
            if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(chunk(ctx)).then(resolve, reject).finally(() => {
              if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
            });
          });
        } else {
          yield chunk;
        }
      }
    },
  };
}

// Deterministic clock for event timestamps.
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => (t += 1) };
}

// Records emitted events and asserts each one is well-formed via the contract.
export function recorder() {
  const events = [];
  return {
    events,
    emit: (ev) => events.push(ev),
    ofType: (type) => events.filter((e) => e.type === type),
    types: () => events.map((e) => e.type),
  };
}

// Minimal tool set: definitions + execute over a map of name -> async fn(input, ctx).
export function fakeTools(impls = {}) {
  return {
    calls: [],
    definitions() {
      return Object.keys(impls).map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: 'object' } }));
    },
    async execute(call, ctx) {
      this.calls.push(call);
      const fn = impls[call.name];
      if (!fn) return { ok: false, error: `unknown tool ${call.name}` };
      return fn(call.input, ctx);
    },
  };
}

// Polls `pred` until it returns a truthy value (returned) or the timeout passes (throws).
// For tests that wait on background runs: a fixed sleep flakes when suites run in parallel.
export async function waitUntil(pred, { timeoutMs = 5000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (true) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
