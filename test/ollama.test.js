// D191: the park starts Ollama where the weights actually are, tested with a fake spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllama } from '../sidecar/ollama.js';

// D191: the park starts Ollama where the weights actually are.
//
// A 14B model is 9 GB and belongs on the external drive, not the internal disk. Ollama reads
// OLLAMA_MODELS from its own environment, so a server the park starts without it cannot see
// any of its own models — and the park would report "no model installed" standing next to
// 18 GB of them.
test('the models path is passed to the server the park starts', async () => {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, env: (opts && opts.env) || {} });
    return { unref() {} };
  };
  const unreachable = async () => { throw new Error('connection refused'); };

  // With a path configured, the binary is used and carries OLLAMA_MODELS — even on a Mac
  // that has the app, because the app reads its own preferences and cannot be told.
  const withPath = createOllama({
    env: { PATH: '/usr/bin' },
    fetch: unreachable,
    spawn,
    platform: 'darwin',
    modelsPath: '/Volumes/LaCie/Maka/ollama',
    // The binary is on the PATH; no Ollama.app, which is the shape on this Mac.
    fs: { stat: async (p) => { if (String(p).endsWith('/ollama')) return { isFile: () => true }; throw new Error('missing'); } },
    clock: { now: () => Date.now() },
    log: { error() {}, info() {} },
  });
  await withPath.start({ waitMs: 0 }).catch(() => {});
  const serve = spawned.find((s) => (s.args || []).includes('serve'));
  assert.ok(serve, 'it started the binary rather than the app');
  assert.equal(serve.env.OLLAMA_MODELS, '/Volumes/LaCie/Maka/ollama', 'and told it where the models are');

  // With no path configured nothing is forced into the environment: the default install
  // keeps working exactly as it did.
  spawned.length = 0;
  const plain = createOllama({
    env: { PATH: '/usr/bin' },
    fetch: unreachable,
    spawn,
    platform: 'linux',
    fs: { stat: async (p) => (String(p).endsWith('/ollama') ? { isFile: () => true } : (() => { throw new Error('missing'); })()) },
    clock: { now: () => Date.now() },
    log: { error() {}, info() {} },
  });
  await plain.start({ waitMs: 0 }).catch(() => {});
  const bare = spawned.find((s) => (s.args || []).includes('serve'));
  assert.ok(bare);
  assert.equal(bare.env.OLLAMA_MODELS, undefined, 'nothing invented');
});
