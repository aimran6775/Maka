// MCP client (phase 4 step 4): the Model Context Protocol with core modules only.
//
//   createStdioTransport({ command, args, env, cwd, spawn })   a spawned server, one JSON
//                                                               message per line each way
//   createHttpTransport({ url, headers, token, fetch, netGuard }) streamable HTTP: every
//                              message is a POST; the answer is JSON or an SSE stream that
//                              carries the response; Mcp-Session-Id kept after initialize
//   createMcpClient({ transport, clock, timeoutMs })
//     .initialize()            -> { protocolVersion, capabilities, serverInfo }
//     .listTools()             -> every tool (cursor paging followed), sanitised
//     .callTool(name, args)    -> { ok, text, content, isError }
//     .listResources() / .readResource(uri)
//     .ping(), .close(), .state()
//   sanitizeTool(tool, { maxDescription }) / sanitizeSchema(schema)
//
// Sanitising (the brief's prompt-injection rule): a tool's name must be a plain identifier,
// its description is clipped to MAX_DESCRIPTION characters with control characters removed,
// and its input schema is rebuilt from the keywords shared/schema.js validates (type,
// properties, required, additionalProperties, items, enum, const, bounds, anyOf, and
// clipped descriptions), so nothing the server wrote reaches the model unbounded and the
// gate can validate every call's input. The HTTP transport reaches the server through the
// outbound guard (safety H1): a server on this machine or the LAN is refused unless the
// guard was built with allowLocal (tests only). Bearer tokens travel in the header only.

import { spawn as nodeSpawn } from 'node:child_process';
import { guardedFetch, defaultNetGuard } from '../netguard.js';

export const PROTOCOL_VERSION = '2025-03-26';
export const CLIENT_INFO = Object.freeze({ name: 'maka', version: '0.1.0' });
export const MAX_DESCRIPTION = 300;
export const MAX_TOOLS = 200;
export const MAX_OUTPUT = 60_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const CALL_TIMEOUT_MS = 120_000;
export const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_STDERR = 4000;

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ---- sanitising ----

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
// Control characters and the zero-width / line-separator code points a description could hide text in.
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff].map((c) => String.fromCharCode(c)).join('');
const CONTROL_RE = new RegExp(`[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f${ZERO_WIDTH}]`, 'g');
const clean = (s, n) => {
  const t = String(s).replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function sanitizeSchema(schema, { maxDescription = MAX_DESCRIPTION, depth = 0 } = {}) {
  if (depth > 8 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return depth === 0 ? { type: 'object', additionalProperties: true } : { };
  const out = {};
  if (typeof schema.type === 'string' && SCHEMA_TYPES.has(schema.type)) out.type = schema.type;
  else if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => typeof t === 'string' && SCHEMA_TYPES.has(t));
    if (types.length) out.type = types;
  }
  if (typeof schema.description === 'string' && schema.description) out.description = clean(schema.description, maxDescription);
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.length <= 200 && schema.enum.every((v) => ['string', 'number', 'boolean'].includes(typeof v) || v === null)) out.enum = schema.enum.map((v) => (typeof v === 'string' ? v.slice(0, 200) : v));
  if (schema.const !== undefined && (['string', 'number', 'boolean'].includes(typeof schema.const) || schema.const === null)) out.const = typeof schema.const === 'string' ? schema.const.slice(0, 200) : schema.const;
  for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) if (typeof schema[k] === 'number' && Number.isFinite(schema[k])) out[k] = schema[k];
  if (typeof schema.pattern === 'string' && schema.pattern.length <= 200) {
    try {
      new RegExp(schema.pattern); // eslint-disable-line no-new
      out.pattern = schema.pattern;
    } catch {
      /* an unusable pattern is dropped */
    }
  }
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties).slice(0, 100)) if (/^[A-Za-z0-9_.$-]{1,80}$/.test(k)) out.properties[k] = sanitizeSchema(v, { maxDescription, depth: depth + 1 });
  }
  if (Array.isArray(schema.required)) out.required = schema.required.filter((k) => typeof k === 'string' && out.properties && k in out.properties).slice(0, 100);
  if (schema.additionalProperties === false) out.additionalProperties = false;
  else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.additionalProperties = sanitizeSchema(schema.additionalProperties, { maxDescription, depth: depth + 1 });
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) out.items = sanitizeSchema(schema.items, { maxDescription, depth: depth + 1 });
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (alternatives && alternatives.length && alternatives.length <= 20) out.anyOf = alternatives.map((s) => sanitizeSchema(s, { maxDescription, depth: depth + 1 }));
  if (depth === 0 && !out.type && !out.anyOf) out.type = 'object';
  if (depth === 0 && out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = true;
  return out;
}

// A tool as the model and the gate will see it, or null when its name is unusable.
export function sanitizeTool(tool, { maxDescription = MAX_DESCRIPTION } = {}) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) return null;
  const rawDescription = typeof tool.description === 'string' ? tool.description : '';
  const description = clean(rawDescription, maxDescription) || `MCP tool ${tool.name}`;
  const a = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  const annotations = {};
  for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) if (typeof a[k] === 'boolean') annotations[k] = a[k];
  if (typeof a.title === 'string' && a.title) annotations.title = clean(a.title, 80);
  return { name: tool.name, description, inputSchema: sanitizeSchema(tool.inputSchema || tool.input_schema || {}, { maxDescription }), annotations, truncated: rawDescription.length > description.length, rawDescriptionLength: rawDescription.length };
}

// ---- transports ----

// A spawned server: `env` is the whole environment the child gets (the manager builds it;
// nothing of the sidecar's own environment leaks unless named). Frames are newline-
// delimited JSON on stdin / stdout; stderr is kept (bounded) for the Peak.
export function createStdioTransport({ command, args = [], env = {}, cwd = undefined, spawn = nodeSpawn, log = console } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw fail('BAD_COMMAND', 'a stdio MCP server needs a command');
  let child = null;
  let buf = '';
  let stderr = '';
  let onMessage = () => {};
  let closed = false;
  const closers = [];
  const closedPromise = new Promise((resolve) => closers.push(resolve));
  return {
    kind: 'stdio',
    async open() {
      child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        const onErr = (err) => reject(fail('SPAWN_FAILED', `could not start ${command}: ${err.code || err.message}`));
        child.once('error', onErr);
        child.once('spawn', () => { child.off('error', onErr); resolve(); });
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > MAX_LINE) {
          buf = '';
          log.warn && log.warn(`mcp ${command}: a line over ${MAX_LINE} bytes was dropped`);
          return;
        }
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // a server's stray log line on stdout
          }
          onMessage(msg);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-MAX_STDERR); });
      child.on('exit', (code, signal) => { closed = true; for (const r of closers) r({ code, signal }); });
      child.on('error', (err) => { stderr = (stderr + `\n${err.message}`).slice(-MAX_STDERR); });
    },
    send(msg) {
      if (!child || closed) throw fail('MCP_CLOSED', `${command} is not running`);
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
    onMessage(fn) { onMessage = fn; },
    async close() {
      if (!child || closed) return;
      try { child.stdin.end(); } catch { /* gone */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      await closedPromise;
      clearTimeout(t);
    },
    closed: () => closed,
    exited: closedPromise,
    stderr: () => stderr,
    pid: () => (child ? child.pid : null),
  };
}

// Parses a text/event-stream body into the JSON-RPC messages its data lines carry.
export function parseEventStream(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* not JSON: skipped */
    }
  }
  return out;
}

// Streamable HTTP. Every request is one POST; a response of application/json carries the
// answer, text/event-stream carries it in events (the stream ends with the answer); 202 is
// a notification accepted. The session id the server hands out on initialize goes back
// on every later request. 401 is UNAUTHORIZED with the WWW-Authenticate challenge kept.
export function createHttpTransport({ url, headers = {}, token = null, fetch: fetchImpl = globalThis.fetch, netGuard = defaultNetGuard(), log = console } = {}) {
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw fail('BAD_URL', `not a valid MCP server url: ${url}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw fail('BAD_URL', `an HTTP MCP server url must be http(s), got ${target.protocol}`);
  let sessionId = null;
  let onMessage = () => {};
  let closed = false;
  let bearer = token;
  return {
    kind: 'http',
    url: target.toString(),
    async open() {
      await netGuard.assert(target.toString());
    },
    setToken(t) { bearer = t; },
    sessionId: () => sessionId,
    onMessage(fn) { onMessage = fn; },
    // Sends one message; responses (JSON or in the stream) are handed to onMessage.
    async send(msg) {
      if (closed) throw fail('MCP_CLOSED', 'transport closed');
      const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
      if (sessionId) h['mcp-session-id'] = sessionId;
      if (bearer) h.authorization = `Bearer ${bearer}`;
      let res;
      try {
        res = await guardedFetch(target.toString(), { method: 'POST', headers: h, body: JSON.stringify(msg) }, { fetch: fetchImpl, guard: netGuard });
      } catch (err) {
        if (err && err.code === 'NET_GUARD') throw fail('NET_GUARD', err.message);
        throw fail('NETWORK', `mcp server unreachable: ${err && err.code ? err.code : err && err.cause && err.cause.code ? err.cause.code : err && err.message ? err.message : 'network error'}`);
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      if (res.status === 401) throw fail('UNAUTHORIZED', 'the MCP server wants authorization', { wwwAuthenticate: res.headers.get('www-authenticate') || '' });
      if (res.status === 202 || res.status === 204) return;
      if (res.status === 404 && sessionId) {
        sessionId = null;
        throw fail('SESSION_LOST', 'the MCP server forgot the session; initialize again');
      }
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const text = await res.text();
      if (!res.ok) throw fail(`HTTP_${res.status}`, `mcp server answered ${res.status}: ${text.slice(0, 200)}`);
      if (type === 'text/event-stream') {
        for (const m of parseEventStream(text)) onMessage(m);
        return;
      }
      if (!text.trim()) return;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw fail('BAD_RESPONSE', `mcp server answered with something that is not JSON: ${text.slice(0, 120)}`);
      }
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) onMessage(m);
    },
    async close() {
      closed = true;
    },
    closed: () => closed,
  };
}

// ---- the client ----

function contentText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[image ${c.mimeType || ''} ${typeof c.data === 'string' ? `${c.data.length} base64 chars` : ''}]`);
    else if (c.type === 'audio') parts.push(`[audio ${c.mimeType || ''}]`);
    else if (c.type === 'resource' && c.resource) parts.push(typeof c.resource.text === 'string' ? c.resource.text : `[resource ${c.resource.uri || ''}]`);
    else if (c.type === 'resource_link') parts.push(`[resource ${c.uri || ''}${c.name ? ` ${c.name}` : ''}]`);
  }
  const joined = parts.join('\n');
  return joined.length > MAX_OUTPUT ? `${joined.slice(0, MAX_OUTPUT)}\n…[truncated at ${MAX_OUTPUT} characters]` : joined;
}

export function createMcpClient({ transport, clock = { now: () => Date.now() }, timeoutMs = DEFAULT_TIMEOUT_MS, callTimeoutMs = CALL_TIMEOUT_MS, maxDescription = MAX_DESCRIPTION, log = console } = {}) {
  if (!transport) throw new TypeError('createMcpClient needs a transport');
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer, method }
  let serverInfo = null;
  let capabilities = null;
  let protocolVersion = null;
  let initialized = false;
  const notifications = [];

  transport.onMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(fail('MCP_ERROR', `${p.method}: ${msg.error.message || 'error'}${msg.error.code !== undefined ? ` (code ${msg.error.code})` : ''}`, { rpcCode: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id === undefined) {
      notifications.push({ method: msg.method, params: msg.params || {}, at: clock.now() });
      if (notifications.length > 50) notifications.shift();
    }
    // Server requests (sampling, roots, elicitation) are declined: Maka's model is not the server's to drive.
    if (msg.method && msg.id !== undefined) {
      try {
        transport.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `maka does not serve ${msg.method}` } });
      } catch {
        /* closed */
      }
    }
  });

  function request(method, params = {}, { timeout = timeoutMs } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(fail('MCP_TIMEOUT', `${method} did not answer within ${timeout} ms`));
      }, timeout);
      pending.set(id, { resolve, reject, timer, method });
      Promise.resolve()
        .then(() => transport.send({ jsonrpc: '2.0', id, method, params }))
        .catch((err) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function notify(method, params = {}) {
    return Promise.resolve().then(() => transport.send({ jsonrpc: '2.0', method, params })).catch((err) => { log.warn && log.warn(`mcp notification ${method}: ${err.message}`); });
  }

  return {
    async initialize() {
      if (typeof transport.open === 'function') await transport.open();
      const result = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { ...CLIENT_INFO } });
      if (!result || typeof result !== 'object') throw fail('BAD_RESPONSE', 'initialize answered with no result');
      protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : null;
      capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
      serverInfo = result.serverInfo && typeof result.serverInfo === 'object' ? { name: String(result.serverInfo.name || '').slice(0, 80), version: String(result.serverInfo.version || '').slice(0, 40) } : { name: '', version: '' };
      initialized = true;
      await notify('notifications/initialized');
      return { protocolVersion, capabilities, serverInfo };
    },
    async listTools() {
      const tools = [];
      let cursor;
      let dropped = 0;
      for (let page = 0; page < 20; page++) {
        const r = await request('tools/list', cursor ? { cursor } : {});
        for (const t of Array.isArray(r && r.tools) ? r.tools : []) {
          const s = sanitizeTool(t, { maxDescription });
          if (!s) dropped += 1;
          else if (tools.length < MAX_TOOLS) tools.push(s);
        }
        cursor = r && typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
        if (!cursor) break;
      }
      return { tools, dropped };
    },
    async callTool(name, args = {}, { signal } = {}) {
      const r = await request('tools/call', { name, arguments: args || {} }, { timeout: callTimeoutMs });
      if (signal && signal.aborted) throw fail('ABORTED', 'the run was cancelled');
      const isError = Boolean(r && r.isError);
      const content = Array.isArray(r && r.content) ? r.content : [];
      let text = contentText(content);
      if (!text && r && r.structuredContent !== undefined) {
        try {
          text = JSON.stringify(r.structuredContent).slice(0, MAX_OUTPUT);
        } catch {
          text = '';
        }
      }
      return { ok: !isError, isError, text, content, structuredContent: r && r.structuredContent !== undefined ? r.structuredContent : undefined };
    },
    async listResources() {
      const out = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const r = await request('resources/list', cursor ? { cursor } : {});
        for (const res of Array.isArray(r && r.resources) ? r.resources : []) if (res && typeof res.uri === 'string') out.push({ uri: res.uri.slice(0, 500), name: clean(res.name || '', 120), description: clean(res.description || '', maxDescription), mimeType: typeof res.mimeType === 'string' ? res.mimeType.slice(0, 80) : '' });
        cursor = r && typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
        if (!cursor) break;
      }
      return out;
    },
    async readResource(uri) {
      const r = await request('resources/read', { uri });
      const contents = Array.isArray(r && r.contents) ? r.contents : [];
      const text = contents.map((c) => (typeof c.text === 'string' ? c.text : typeof c.blob === 'string' ? `[blob ${c.mimeType || ''} ${c.blob.length} base64 chars]` : '')).join('\n');
      return { contents, text: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text };
    },
    ping: () => request('ping', {}),
    request,
    async close() {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(fail('MCP_CLOSED', `${p.method}: the connection closed`));
        pending.delete(id);
      }
      await transport.close();
    },
    state: () => ({ initialized, protocolVersion, capabilities, serverInfo, pending: pending.size, notifications: notifications.slice(-10), transport: transport.kind, sessionId: typeof transport.sessionId === 'function' ? transport.sessionId() : null }),
  };
}
