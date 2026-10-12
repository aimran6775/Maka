// Tool names on the wire (D169). Maka names its tools with dots; both provider APIs
// refuse that, so every real call carrying tools was rejected with HTTP 400 before a
// token was generated. The fakes accepted anything, which is why nothing caught it.
// These tests check the names actually put on the wire against the APIs' own patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeToolName, toolNameMap, MAX_TOOL_NAME } from '../sidecar/providers/tool-names.js';
import { toAnthropicTools, toAnthropicMessages } from '../sidecar/providers/anthropic.js';
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

// D175: an empty turn on the wire. A worker that answers with nothing usable leaves an
// assistant message holding no content blocks. The OpenAI shape then sent
// `content: null` with no tool_calls and Ollama refused the whole request with
// `HTTP 400: invalid message content type: <nil>`, so every retry after a judge asked for
// a revision died — which is what stalled the first venture's market research. Anthropic
// refuses the same turn for its own reason: content may not be empty.
// Taken from run-2026-10-12T01-04-14-739Z-9391ba08: [user brief, assistant(no blocks),
// user judge-feedback].
const EMPTY_TURN = [
  { role: 'user', content: [{ type: 'text', text: 'Work item work-466d75e4 from chief-ranger.' }] },
  { role: 'assistant', content: [] },
  { role: 'user', content: [{ type: 'text', text: '[Judge review: your answer was sent back for revision]' }] },
];

test('an assistant turn that produced nothing never goes out as a null content', () => {
  const msgs = toOpenAIMessages('be good', EMPTY_TURN);
  for (const m of msgs) {
    if (m.role === 'assistant' && !m.tool_calls) {
      assert.equal(typeof m.content, 'string', 'an assistant turn without tool calls must carry a string');
    }
    assert.ok(m.content !== null || Array.isArray(m.tool_calls), `${m.role} may only be null alongside tool_calls`);
    assert.ok(m.content !== undefined, `${m.role} must carry content`);
  }
  // A real tool call still gets to use null, which is the one shape that allows it.
  const withCall = toOpenAIMessages(null, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fs.read', input: {} }] },
  ]);
  assert.equal(withCall[0].content, null);
  assert.equal(withCall[0].tool_calls.length, 1);
});

test('Anthropic is never sent an empty turn, and the turns around it stay in order', () => {
  const msgs = toAnthropicMessages(EMPTY_TURN);
  for (const m of msgs) {
    assert.ok(m.content.length > 0, 'the API refuses a turn with empty content');
    for (const b of m.content) {
      if (b.type === 'text') assert.ok(String(b.text).trim(), 'and refuses an empty text block');
    }
  }
  // The two user turns sat either side of the dropped one: they have to arrive as one
  // message, not as two in a row, and neither may lose its words.
  assert.deepEqual(msgs.map((m) => m.role), ['user']);
  const said = msgs[0].content.map((b) => b.text).join('\n');
  assert.match(said, /work-466d75e4/);
  assert.match(said, /Judge review/);

  // Whitespace-only text is the same case and must not survive on its own.
  const blank = toAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: '  \n ' }] },
  ]);
  assert.deepEqual(blank.map((m) => m.role), ['user']);

  // A tool_use turn carries no text and must still be sent: it is not an empty turn.
  const call = toAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fs.read', input: { path: 'a' } }] },
  ]);
  assert.equal(call.length, 1);
  assert.equal(call[0].content[0].type, 'tool_use');
});
