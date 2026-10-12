// Tool names on the wire (D169). Maka names its tools with dots; both provider APIs
// refuse that, so every real call carrying tools was rejected with HTTP 400 before a
// token was generated. The fakes accepted anything, which is why nothing caught it.
// These tests check the names actually put on the wire against the APIs' own patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeToolName, toolNameMap, MAX_TOOL_NAME } from '../sidecar/providers/tool-names.js';
import { toAnthropicTools } from '../sidecar/providers/anthropic.js';
import { toOpenAITools, toOpenAIMessages } from '../sidecar/providers/openai-compat.js';

// Anthropic: ^[a-zA-Z0-9_-]{1,128}$. OpenAI: the same within 64. The stricter one holds.
const WIRE_OK = /^[a-zA-Z0-9_-]{1,64}$/;

// A representative spread of the park's real tool names, dots and all.
const TOOLS = [
  { name: 'fs.read' },
  { name: 'fs.write' },
  { name: 'plan.submit' },
  { name: 'crew.spawn_junior' },
  { name: 'web.fetch' },
  { name: 'meta_ads.create_campaign' },
  { name: 'mcp.files.list_directory' },
  { name: 'delegate' },
];

test('a dotted park name becomes a name both APIs accept, and only the illegal characters change', () => {
  assert.match(safeToolName('fs.write'), WIRE_OK);
  assert.equal(safeToolName('fs.write'), 'fs_write');
  assert.equal(safeToolName('mcp.files.list_directory'), 'mcp_files_list_directory');
  assert.equal(safeToolName('delegate'), 'delegate', 'a name that is already fine is untouched');
  assert.equal(safeToolName('a b/c:d'), 'a_b_c_d');
  assert.match(safeToolName(''), WIRE_OK, 'even an empty name answers something sendable');
  assert.ok(safeToolName('x'.repeat(200)).length <= MAX_TOOL_NAME);
});

test('the map goes both ways, and two names that sanitise alike stay apart', () => {
  const names = toolNameMap(TOOLS);
  for (const t of TOOLS) {
    const wire = names.toApi(t.name);
    assert.match(wire, WIRE_OK, `${t.name} -> ${wire}`);
    assert.equal(names.fromApi(wire), t.name, 'and back again');
  }
  // `a.b` and `a_b` both want `a_b`: the second takes a suffix, and neither is lost.
  const clash = toolNameMap([{ name: 'a.b' }, { name: 'a_b' }]);
  const first = clash.toApi('a.b');
  const second = clash.toApi('a_b');
  assert.notEqual(first, second);
  assert.match(second, WIRE_OK);
  assert.equal(clash.fromApi(first), 'a.b');
  assert.equal(clash.fromApi(second), 'a_b');
  // Deterministic for the same list.
  assert.equal(toolNameMap([{ name: 'a.b' }, { name: 'a_b' }]).toApi('a_b'), second);
  // A name the model invents is not quietly turned into some other tool.
  assert.equal(clash.fromApi('not_a_tool'), 'not_a_tool');
});

test('every tool Anthropic is sent carries a name its API accepts, and the model\'s answer maps back', () => {
  const names = toolNameMap(TOOLS);
  const wire = toAnthropicTools(TOOLS, names);
  assert.equal(wire.length, TOOLS.length);
  for (const t of wire) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,128}$/, `${t.name} must match Anthropic's pattern`);
    assert.ok(t.input_schema, 'a tool keeps its schema');
  }
  assert.deepEqual(wire.map((t) => names.fromApi(t.name)), TOOLS.map((t) => t.name), 'the park gets its own names back');
});

test('every tool an OpenAI-shaped API is sent carries a legal name, including the calls replayed in the history', () => {
  const names = toolNameMap(TOOLS);
  for (const t of toOpenAITools(TOOLS, names)) assert.match(t.function.name, WIRE_OK, t.function.name);

  // A past turn where the model called fs.write is replayed on the next request: the name
  // in that history has to be the same wire name the tool list uses, or the API rejects
  // the message as referring to a tool that was never offered.
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'writing' }, { type: 'tool_use', id: 'c1', name: 'fs.write', input: { path: 'outbox/a.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'wrote it' }] },
  ];
  const out = toOpenAIMessages('be good', messages, names);
  const call = out.find((m) => m.tool_calls).tool_calls[0];
  assert.match(call.function.name, WIRE_OK);
  assert.equal(call.function.name, names.toApi('fs.write'));
  assert.equal(names.fromApi(call.function.name), 'fs.write');
});

test('without a map the raw names still go out, so the helpers stay usable on their own', () => {
  assert.equal(toAnthropicTools([{ name: 'fs.write' }])[0].name, 'fs.write');
  assert.equal(toOpenAITools([{ name: 'fs.write' }])[0].function.name, 'fs.write');
});
