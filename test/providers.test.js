import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parseSSE } from '../sidecar/providers/sse.js';
import { createAnthropicProvider, toAnthropicMessages, toAnthropicTools } from '../sidecar/providers/anthropic.js';
import { createOpenRouterProvider, toOpenAIMessages, toOpenAITools } from '../sidecar/providers/openrouter.js';
import { resolveKey, setKey, keystoreStatus } from '../sidecar/providers/keys.js';
import { priceFor, PRICES } from '../sidecar/providers/pricing.js';
import { createProvider, providerStatus, assertProvider, PROVIDER_NAMES } from '../sidecar/providers/provider.js';
import { runLoop } from '../sidecar/loop.js';
import { fakeFetch, sseResponse, sse } from './helpers/fake-fetch.js';
import { recorder, fakeClock, fakeTools } from './helpers/fake-provider.js';

async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}

test('parseSSE handles chunk boundaries, comments, CRLF, multi-line data and no trailing newline', async () => {
  const text = ': keep-alive\r\nevent: a\r\ndata: {"x":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: tail';
  const records = await collect(parseSSE(sseResponse(text, { chunkSize: 3 }).body));
  assert.deepEqual(records, [
    { event: 'a', data: '{"x":1}' },
    { event: null, data: 'line1\nline2' },
    { event: null, data: 'tail' },
  ]);
  assert.deepEqual(await collect(parseSSE('data: x\n\n')), [{ event: null, data: 'x' }]);
});

const ANTHROPIC_TOOL_STREAM = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 5 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'fs.read', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  ['ping', { type: 'ping' }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }],
  ['message_stop', { type: 'message_stop' }],
]);

test('anthropic adapter: request shape, headers, normalized chunks, usage incl. cache tokens', async () => {
  const fetch = fakeFetch(() => sseResponse(ANTHROPIC_TOOL_STREAM));
  const provider = createAnthropicProvider({ apiKey: 'sk-test', fetch, baseUrl: 'https://example.test' });
  const chunks = await collect(provider.stream({
    model: 'claude-opus-5-5',
    system: 'be terse',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'fs.read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
  }));

  const call = fetch.calls[0];
  assert.equal(call.url, 'https://example.test/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'sk-test');
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.stream, true);
  assert.equal(call.body.system, 'be terse');
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.max_tokens, 16000);
  assert.equal('thinking' in call.body, false, 'thinking is left to the model default');
  assert.deepEqual(call.body.tools[0], { name: 'fs.read', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } });

  assert.deepEqual(chunks, [
    { type: 'opaque_block', index: 0, block: { type: 'thinking', thinking: '', signature: 'sig123' } },
    { type: 'text_delta', index: 1, text: 'Reading ' },
    { type: 'text_delta', index: 1, text: 'now.' },
    { type: 'tool_use_start', index: 2, id: 'toolu_1', name: 'fs.read' },
    { type: 'tool_input_delta', index: 2, partialJson: '{"path":' },
    { type: 'tool_input_delta', index: 2, partialJson: '"a.txt"}' },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 30, outputTokens: 40 } },
  ]);
});

test('anthropic adapter: HTTP errors carry status code; stream error events throw; abort propagates', async () => {
  const fetch = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
  const provider = createAnthropicProvider({ apiKey: 'bad', fetch });
  await assert.rejects(collect(provider.stream({ model: 'm', messages: [] })), (err) => {
    assert.equal(err.code, 'HTTP_401');
    assert.match(err.message, /invalid x-api-key/);
    return true;
  });

  const fetch2 = fakeFetch(() => sseResponse(sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]])));
  const p2 = createAnthropicProvider({ apiKey: 'k', fetch: fetch2 });
  await assert.rejects(collect(p2.stream({ model: 'm', messages: [] })), (err) => err.code === 'STREAM_ERROR' && /Overloaded/.test(err.message));

  const ac = new AbortController();
  ac.abort();
  const fetch3 = fakeFetch(() => sseResponse(''));
  const p3 = createAnthropicProvider({ apiKey: 'k', fetch: fetch3 });
  await assert.rejects(collect(p3.stream({ model: 'm', messages: [] }, { signal: ac.signal })), (err) => err.name === 'AbortError');

  const fetch4 = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
  const p4 = createAnthropicProvider({ apiKey: 'k', fetch: fetch4 });
  await assert.rejects(collect(p4.stream({ model: 'm', messages: [] })), (err) => err.code === 'NETWORK');
});

test('anthropic adapter drives the real loop: thinking block is replayed, tool result is sent back', async () => {
  const fetch = fakeFetch((n) => sseResponse(n === 0 ? ANTHROPIC_TOOL_STREAM : sse([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 60, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It says hi.' } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }],
  ])));
  const provider = createAnthropicProvider({ apiKey: 'k', fetch });
  const rec = recorder();
  const out = await runLoop({
    runId: 'r', agentId: 'a', provider, model: 'claude-opus-5-5', prompt: 'read a.txt',
    tools: fakeTools({ 'fs.read': async () => ({ ok: true, output: 'hi' }) }),
    emit: rec.emit, clock: fakeClock(), price: priceFor('anthropic', 'claude-opus-5-5'),
  });
  assert.equal(out.reason, 'completed');
  assert.equal(out.finalText, 'It says hi.');
  const second = fetch.calls[1].body.messages;
  assert.equal(second[1].role, 'assistant');
  assert.deepEqual(second[1].content[0], { type: 'thinking', thinking: '', signature: 'sig123' });
  assert.deepEqual(second[1].content[2], { type: 'tool_use', id: 'toolu_1', name: 'fs.read', input: { path: 'a.txt' } });
  assert.deepEqual(second[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }] });
  const costs = rec.ofType('cost.estimate').map((e) => e.payload);
  assert.equal(costs[0].reconciled, true);
  assert.equal(costs[0].inputTokens, 30);
  assert.ok(Math.abs(costs[0].usd - (30 * 4 + 40 * 20) / 1e6) < 1e-12);
  assert.equal(costs[1].usd, (60 * 4 + 6 * 20) / 1e6);
});

test('anthropic message translation marks tool errors', () => {
  const out = toAnthropicMessages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] }]);
  assert.deepEqual(out[0].content[0], { type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true });
  assert.deepEqual(toAnthropicTools([{ name: 'n' }]), [{ name: 'n', description: '', input_schema: { type: 'object', properties: {} } }]);
});

const OPENROUTER_TOOL_STREAM = [
  ': OPENROUTER PROCESSING\n\n',
  sse([
    [null, { id: 'gen-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' }, finish_reason: null }] }],
    [null, { id: 'gen-1', choices: [{ index: 0, delta: { content: 'look.' }, finish_reason: null }] }],
    [null, { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'web.fetch', arguments: '' } }] }, finish_reason: null }] }],
    [null, { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"url":"https://e' } }] }, finish_reason: null }] }],
    [null, { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_def', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a"}' } }] }, finish_reason: null }] }],
    [null, { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'xample.com"}' } }] }, finish_reason: null }] }],
    [null, { id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
    [null, { id: 'gen-1', choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.00123 } }],
    [null, '[DONE]'],
  ]),
].join('');

test('openrouter adapter: request shape, interleaved tool calls by index, provider-reported cost', async () => {
  const fetch = fakeFetch(() => sseResponse(OPENROUTER_TOOL_STREAM, { chunkSize: 11 }));
  const provider = createOpenRouterProvider({ apiKey: 'or-test', fetch });
  const chunks = await collect(provider.stream({
    model: 'anthropic/claude-sonnet-4.5',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [{ name: 'web.fetch', description: 'fetch', inputSchema: { type: 'object' } }],
  }));
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.init.headers.authorization, 'Bearer or-test');
  assert.deepEqual(call.body.usage, { include: true });
  assert.deepEqual(call.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]);
  assert.deepEqual(call.body.tools[0], { type: 'function', function: { name: 'web.fetch', description: 'fetch', parameters: { type: 'object' } } });

  assert.deepEqual(chunks, [
    { type: 'text_delta', index: 0, text: 'Let me ' },
    { type: 'text_delta', index: 0, text: 'look.' },
    { type: 'tool_use_start', index: 1, id: 'call_abc', name: 'web.fetch' },
    { type: 'tool_input_delta', index: 1, partialJson: '{"url":"https://e' },
    { type: 'tool_use_start', index: 2, id: 'call_def', name: 'fs.read' },
    { type: 'tool_input_delta', index: 2, partialJson: '{"path":"a"}' },
    { type: 'tool_input_delta', index: 1, partialJson: 'xample.com"}' },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.00123 } },
  ]);
});

test('openrouter adapter through the loop: provider cost is reconciled; tool results become tool messages', async () => {
  const fetch = fakeFetch((n) => sseResponse(n === 0 ? OPENROUTER_TOOL_STREAM : sse([
    [null, { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }],
    [null, { choices: [], usage: { prompt_tokens: 80, completion_tokens: 2, cost: 0.0005 } }],
    [null, '[DONE]'],
  ])));
  const provider = createOpenRouterProvider({ apiKey: 'k', fetch });
  const rec = recorder();
  const out = await runLoop({
    runId: 'r', agentId: 'a', provider, model: 'x/y', prompt: 'go',
    tools: fakeTools({ 'web.fetch': async () => ({ ok: true, output: 'page' }), 'fs.read': async () => ({ ok: false, error: 'nope' }) }),
    emit: rec.emit, clock: fakeClock(), price: null,
  });
  assert.equal(out.reason, 'completed');
  assert.equal(out.finalText, 'done');
  const costs = rec.ofType('cost.estimate').map((e) => e.payload);
  assert.deepEqual(costs.map((c) => [c.usd, c.reconciled]), [[0.00123, true], [0.0005, true]]);
  assert.equal(out.spentUsd, 0.00123 + 0.0005);
  const msgs = fetch.calls[1].body.messages;
  assert.deepEqual(msgs[1], {
    role: 'assistant',
    content: 'Let me look.',
    tool_calls: [
      { id: 'call_abc', type: 'function', function: { name: 'web.fetch', arguments: '{"url":"https://example.com"}' } },
      { id: 'call_def', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a"}' } },
    ],
  });
  assert.deepEqual(msgs[2], { role: 'tool', tool_call_id: 'call_abc', content: 'page' });
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'call_def', content: 'nope' });
  assert.equal(msgs.length, 4);
});

test('openrouter adapter: errors and message translation edge cases', async () => {
  const fetch = fakeFetch(() => new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 }));
  const provider = createOpenRouterProvider({ apiKey: 'k', fetch });
  await assert.rejects(collect(provider.stream({ model: 'm', messages: [] })), (e) => e.code === 'HTTP_401');
  const fetch2 = fakeFetch(() => sseResponse(sse([[null, { error: { message: 'rate limited' } }]])));
  const p2 = createOpenRouterProvider({ apiKey: 'k', fetch: fetch2 });
  await assert.rejects(collect(p2.stream({ model: 'm', messages: [] })), (e) => e.code === 'STREAM_ERROR');
  assert.deepEqual(toOpenAIMessages('', [{ role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }]), [{ role: 'assistant', content: null }]);
  assert.deepEqual(toOpenAITools([]), []);
});

test('keys: env wins, keystore requires 0600, setKey creates 0600 file, status never leaks keys', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-keys-'));
  const keystorePath = path.join(dir, 'keystore.json');
  assert.equal(await resolveKey('anthropic', { env: { ANTHROPIC_API_KEY: ' sk-env ' }, keystorePath }), 'sk-env');
  assert.equal(await resolveKey('anthropic', { env: {}, keystorePath }), null);

  await setKey('openrouter', 'or-1', { env: {}, keystorePath });
  const mode = (await fsp.stat(keystorePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(await resolveKey('openrouter', { env: {}, keystorePath }), 'or-1');
  assert.equal(await resolveKey('anthropic', { env: {}, keystorePath }), null);

  await setKey('anthropic', 'sk-2', { env: {}, keystorePath });
  assert.deepEqual(JSON.parse(await fsp.readFile(keystorePath, 'utf8')), { openrouter: 'or-1', anthropic: 'sk-2' });
  const status = await keystoreStatus({ env: {}, keystorePath });
  assert.deepEqual(status.providers.sort(), ['anthropic', 'openrouter']);
  assert.equal(JSON.stringify(status).includes('sk-2'), false);

  if (process.platform !== 'win32') {
    await fsp.chmod(keystorePath, 0o644);
    const warnings = [];
    assert.equal(await resolveKey('anthropic', { env: {}, keystorePath, warn: (m) => warnings.push(m) }), null);
    assert.match(warnings[0], /expected 600/);
    await assert.rejects(setKey('anthropic', 'x', { env: {}, keystorePath }), /expected 600/);
  }

  await setKey('anthropic', '', { env: {}, keystorePath: path.join(dir, 'other.json') });
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'other.json'), 'utf8')), {});
  await fsp.rm(dir, { recursive: true, force: true });
});

test('pricing: known models priced, unknown null, table frozen', () => {
  assert.deepEqual(priceFor('anthropic', 'claude-opus-5-5'), { inputPerMTok: 4, outputPerMTok: 20 });
  assert.equal(priceFor('anthropic', 'claude-made-up'), null);
  assert.equal(priceFor('openrouter', 'anything'), null);
  assert.equal(priceFor('nope', 'x'), null);
  assert.equal(Object.isFrozen(PRICES.anthropic), true);
});

test('registry: createProvider resolves keys and prices; NO_KEY and UNKNOWN_PROVIDER; status hides keys', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-reg-'));
  const keystorePath = path.join(dir, 'keystore.json');
  assert.deepEqual(PROVIDER_NAMES, ['anthropic', 'openrouter', 'ollama']);
  await assert.rejects(createProvider('anthropic', { env: {}, keystorePath }), (e) => e.code === 'NO_KEY');
  await assert.rejects(createProvider('bogus', { env: {}, keystorePath }), (e) => e.code === 'UNKNOWN_PROVIDER');
  const { provider, model, price } = await createProvider('anthropic', { env: { ANTHROPIC_API_KEY: 'k' }, keystorePath, fetch: async () => {} });
  assertProvider(provider);
  assert.equal(provider.name, 'anthropic');
  assert.equal(model, 'claude-opus-5-5');
  assert.deepEqual(price, { inputPerMTok: 4, outputPerMTok: 20 });
  const or = await createProvider('openrouter', { model: 'x/y', env: { OPENROUTER_API_KEY: 'k' }, keystorePath, fetch: async () => {} });
  assert.equal(or.price, null);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const status = await providerStatus({ env: { OPENROUTER_API_KEY: 'secret' }, keystorePath, fetch: down });
  assert.equal(status.anthropic.configured, false);
  assert.equal(status.openrouter.configured, true);
  assert.equal(status.ollama.reachable, false);
  assert.equal(status.ollama.configured, false);
  assert.match(status.ollama.problem, /not reachable/);
  assert.equal(status.ollama.host, 'http://127.0.0.1:11434');
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.throws(() => assertProvider({}), TypeError);
  await fsp.rm(dir, { recursive: true, force: true });
});

const OLLAMA_STREAM = sse([
  [null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Sure' }, finish_reason: null }] }],
  [null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a.txt"}' } }] }, finish_reason: null }] }],
  [null, { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
  [null, { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }],
  [null, '[DONE]'],
]);

test('ollama adapter: no key, local base URL, stream_options usage, zero-cost reconciled usage', async () => {
  const { createOllamaProvider, listModels, probe, ollamaHost } = await import('../sidecar/providers/ollama.js');
  const fetch = fakeFetch(() => sseResponse(OLLAMA_STREAM));
  const provider = createOllamaProvider({ fetch });
  const chunks = await collect(provider.stream({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [{ name: 'fs.read' }] }));
  const call = fetch.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal('authorization' in call.init.headers, false);
  assert.deepEqual(call.body.stream_options, { include_usage: true });
  assert.equal(call.body.model, 'qwen2.5:7b');
  assert.deepEqual(chunks.at(-1), { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 30, costUsd: 0 } });
  assert.deepEqual(chunks[1], { type: 'tool_use_start', index: 1, id: 'call_x', name: 'fs.read' });

  const tags = fakeFetch(() => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] })));
  assert.deepEqual(await listModels({ fetch: tags }), ['qwen2.5:7b', 'llama3.1:8b']);
  assert.deepEqual(await probe({ fetch: tags }), { reachable: true, models: ['qwen2.5:7b', 'llama3.1:8b'] });
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(listModels({ fetch: down }), (e) => e.code === 'OLLAMA_UNREACHABLE');
  const p = await probe({ fetch: down });
  assert.equal(p.reachable, false);
  assert.match(p.problem, /not reachable at http:\/\/127.0.0.1:11434/);
  assert.equal(ollamaHost({}), 'http://127.0.0.1:11434');
  assert.equal(ollamaHost({ OLLAMA_HOST: '0.0.0.0:11434' }), 'http://0.0.0.0:11434');
  assert.equal(ollamaHost({ OLLAMA_HOST: 'https://gpu.local/' }), 'https://gpu.local');
});

test('ollama through the loop: every turn is a reconciled $0 and the transcript still pairs tool results', async () => {
  const { createOllamaProvider } = await import('../sidecar/providers/ollama.js');
  const fetch = fakeFetch((n) => sseResponse(n === 0 ? OLLAMA_STREAM : sse([
    [null, { choices: [{ index: 0, delta: { content: 'It says hi' }, finish_reason: 'stop' }] }],
    [null, { choices: [], usage: { prompt_tokens: 200, completion_tokens: 5 } }],
    [null, '[DONE]'],
  ])));
  const provider = createOllamaProvider({ fetch });
  const rec = recorder();
  const out = await runLoop({
    runId: 'r', agentId: 'a', provider, model: 'qwen2.5:7b', tier: 'worker', prompt: 'read a.txt',
    tools: fakeTools({ 'fs.read': async () => ({ ok: true, output: 'hi' }) }), emit: rec.emit, clock: fakeClock(), price: null,
  });
  assert.equal(out.reason, 'completed');
  assert.equal(out.finalText, 'It says hi');
  const costs = rec.ofType('cost.estimate').map((e) => e.payload);
  assert.deepEqual(costs.map((c) => [c.usd, c.reconciled, c.tier, c.provider]), [[0, true, 'worker', 'ollama'], [0, true, 'worker', 'ollama']]);
  assert.equal(out.spentUsd, 0);
  assert.deepEqual(fetch.calls[1].body.messages[2], { role: 'tool', tool_call_id: 'call_x', content: 'hi' });
});

test('registry: ollama needs no key; model from arg, OLLAMA_MODEL, or the first installed; NO_MODEL and OLLAMA_UNREACHABLE', async () => {
  const tags = fakeFetch(() => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] })));
  const a = await createProvider('ollama', { env: {}, fetch: tags });
  assert.equal(a.provider.name, 'ollama');
  assert.equal(a.model, 'qwen2.5:7b');
  assert.equal(a.price, null);
  const b = await createProvider('ollama', { model: 'llama3.1:8b', env: {}, fetch: async () => { throw new Error('never called'); } });
  assert.equal(b.model, 'llama3.1:8b');
  const c = await createProvider('ollama', { env: { OLLAMA_MODEL: 'phi4' }, fetch: async () => { throw new Error('never called'); } });
  assert.equal(c.model, 'phi4');
  const empty = fakeFetch(() => new Response(JSON.stringify({ models: [] })));
  await assert.rejects(createProvider('ollama', { env: {}, fetch: empty }), (e) => e.code === 'NO_MODEL');
  await assert.rejects(createProvider('ollama', { env: {}, fetch: async () => { throw new Error('ECONNREFUSED'); } }), (e) => e.code === 'OLLAMA_UNREACHABLE');
  const status = await providerStatus({ env: { OLLAMA_MODEL: 'phi4' }, keystorePath: '/nonexistent/keystore.json', fetch: tags });
  assert.deepEqual(status.ollama.models, ['qwen2.5:7b']);
  assert.equal(status.ollama.reachable, true);
  assert.equal(status.ollama.configured, true);
  assert.equal(status.ollama.defaultModel, 'phi4');
  assert.equal(status.ollama.tierHint, 'worker');
  assert.equal(status.anthropic.tierHint, 'judge');
});
