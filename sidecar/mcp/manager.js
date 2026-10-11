// MCP manager (phase 4 step 4): servers configured at the Peak, their tools granted
// through Outpost fixtures, every tool under a leash domain.
//
//   createMcpManager({ bus, store, gateQueue, env, keystorePath, netGuard, registry,
//                      getLayout, clock, spawn, fetch, oauthPort, log })
//     .init()                   loads mcp-servers.json and connects the configured servers
//     .list()                   one row per server (no secrets): transport, status, tools
//                               with their domain and description, the last error
//     .add(spec)                a Gate item (account_settings); approve stores the config
//                               (secret env values into the keystore), connects, lists tools
//     .remove(id)               a Gate item; approve disconnects and forgets config + tokens
//     .connect(id) / .disconnect(id)   (re)start or stop an approved server
//     .setLeash(id, { tool, domain, amount })   the per-tool leash mapping (owner edit)
//     .auth(id)                 a Gate item; approve runs OAuth 2.1 + PKCE for an HTTP server
//     .grantsFor(layout, agentId)  the MCP tool names the Outposts in the agent's zone grant
//     .checkPlacement(object)   refuses an Outpost without a known server
//     .tools(id), .close()
//
// Leash mapping (the brief): a tool annotated read-only (and not destructive: safety
// 2026-10-11 M1) is `research`, every other tool is `outbound_messages`, both overridable
// per tool at the Peak; mapping a tool to money_out
// or money_in needs an explicit amount reading ({ field, unit }) or the mapping is refused,
// and a money_out call whose amount cannot be read from its input is unknown-amount, so
// the Gate decides it at every level (safety H2, as the gate already enforces). Tools are
// registered in the run manager's registry as `mcp.<server>.<tool>` and granted only
// through an Outpost placed in the agent's zone; an Outpost at the Mountain Peak grants
// nothing (safety L5: the Chief is unjudged). HTTP servers are reached through the outbound
// guard; stdio servers get only the environment variables the config names (plain values
// in the config, secret values from the keystore), never the sidecar's own.

// Accepted tools (safety 2026-10-11 M1): the server's annotations are the server's word,
// so the Superintendent accepts a snapshot of the sanitised tool list (name, annotations,
// description and schema fingerprints) when the server is added, and every later connect
// is compared with it. A tool that is new or changed since then is registered under
// `outbound_messages` and holds itself at the Gate at every leash level (`holdAtGate`)
// until a `mcp.accept_tools` Gate item is approved (`mcp.server { status: 'tools_changed' }`
// names it); a rejected one is unregistered and stays so until it changes again. So a
// server update that ships `send_money` annotated read-only never runs free.

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeEvent } from '../../shared/events.js';
import { validate } from '../../shared/schema.js';
import { DOMAINS, MONEY_DOMAINS } from '../../shared/leash.js';
import { resolveKey, setKey } from '../providers/keys.js';
import { createOAuthFlow, refreshTokens, DEFAULT_OAUTH_PORT, CALLBACK_PATH } from '../connectors/oauth.js';
import { guardedFetch, defaultNetGuard } from '../netguard.js';
import { createStdioTransport, createHttpTransport, createMcpClient } from './client.js';

export const SERVER_ID_RE = '^[a-z0-9][a-z0-9-]{0,30}$';
export const ENV_NAME_RE = '^[A-Z_][A-Z0-9_]{0,63}$';
export const TOOL_PREFIX = 'mcp';
export const DEFAULT_DOMAIN = 'outbound_messages';
export const READ_ONLY_DOMAIN = 'research';
export const AMOUNT_UNITS = Object.freeze(['usd', 'cents']);
export const SECRET_ARG_PREFIX = '$SECRET:';
export const CATALOG_PATH = fileURLToPath(new URL('./catalog.json', import.meta.url));

// The curated catalog (phase 4 step 5): read once, validated, never carrying a value.
export function loadCatalog(path = CATALOG_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) throw new Error('catalog.json must be { version: 1, entries: [] }');
  for (const e of data.entries) validateCatalogEntry(e);
  return data;
}

export function validateCatalogEntry(e) {
  const problem = (m) => { throw new Error(`catalog entry ${e && e.id ? e.id : '?'}: ${m}`); };
  if (!e || typeof e !== 'object') problem('not an object');
  if (!new RegExp(SERVER_ID_RE).test(e.id || '')) problem('bad id');
  if (typeof e.label !== 'string' || !e.label) problem('needs a label');
  if (typeof e.description !== 'string' || !e.description) problem('needs a description');
  if (typeof e.source !== 'string' || !/^https:\/\//.test(e.source)) problem('needs an https source');
  if (!['stdio', 'http'].includes(e.transport)) problem('transport must be stdio or http');
  if (e.transport === 'stdio' && (typeof e.package !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(e.package))) problem('a stdio entry needs an npm package name');
  if (e.transport === 'http' && (typeof e.url !== 'string' || !/^https:\/\//.test(e.url))) problem('an http entry needs an https url');
  if (!Array.isArray(e.params) || !Array.isArray(e.secrets) || !Array.isArray(e.args || [])) problem('params, secrets and args are arrays');
  for (const p of e.params) if (!p || !/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(p.name || '') || typeof p.label !== 'string') problem(`bad param ${p && p.name}`);
  for (const p of e.params) if (p.env !== undefined && !new RegExp(ENV_NAME_RE).test(p.env)) problem(`param ${p.name} names a bad env variable`);
  for (const s of e.secrets) {
    if (!s || !new RegExp(ENV_NAME_RE).test(s.name || '') || typeof s.label !== 'string') problem(`bad secret ${s && s.name}`);
    for (const k of Object.keys(s)) if (!['name', 'label', 'hint'].includes(k)) problem(`secret ${s.name} carries a field other than name / label / hint (${k})`);
  }
  const secretNames = new Set(e.secrets.map((s) => s.name));
  for (const a of e.args || []) {
    if (typeof a !== 'string') problem('args are strings');
    if (a.startsWith(SECRET_ARG_PREFIX) && !secretNames.has(a.slice(SECRET_ARG_PREFIX.length))) problem(`arg ${a} names an undeclared secret`);
    const m = /^\{([a-zA-Z0-9]+)\}$/.exec(a);
    if (m && !e.params.some((p) => p.name === m[1])) problem(`arg ${a} names an unknown param`);
  }
  for (const [tool, domain] of Object.entries(e.leash || {})) {
    if (!DOMAINS.includes(domain)) problem(`${tool} → unknown domain ${domain}`);
    if (MONEY_DOMAINS.includes(domain)) problem(`${tool} → ${domain}: the catalog proposes no money mapping; the owner sets those with an amount reading`);
  }
  for (const v of Object.values(e.env || {})) if (typeof v !== 'string') problem('env values are strings');
  return e;
}

// Builds a server spec from a catalog entry and the owner's params / secrets (values of
// the secrets are returned apart, for the keystore).
export function specFromCatalog(entry, { params = {}, secrets = {}, id = null, label = null } = {}) {
  const fill = (s) => s.replace(/\{([a-zA-Z0-9]+)\}/g, (_, k) => String(params[k] !== undefined ? params[k] : ''));
  for (const p of entry.params) {
    const v = params[p.name] !== undefined && params[p.name] !== '' ? params[p.name] : p.default;
    if (p.required && (v === undefined || v === '')) throw fail('BAD_REQUEST', `${entry.label} needs ${p.label} (${p.name})`);
    if (v !== undefined && typeof v !== 'string') throw fail('BAD_REQUEST', `${p.name} must be a string`);
    if (v !== undefined) params = { ...params, [p.name]: v };
  }
  for (const s of entry.secrets) if (typeof secrets[s.name] !== 'string' || !secrets[s.name]) throw fail('BAD_REQUEST', `${entry.label} needs ${s.label} (${s.name})`);
  for (const k of Object.keys(secrets)) if (!entry.secrets.some((s) => s.name === k)) throw fail('BAD_REQUEST', `${entry.label} takes no secret named ${k}`);
  const env = { ...(entry.env || {}) };
  for (const p of entry.params) if (p.env && params[p.name] !== undefined) env[p.env] = params[p.name];
  const spec = { id: id || entry.id, label: label || entry.label, transport: entry.transport, leash: { ...(entry.leash || {}) }, source: `catalog:${entry.id}` };
  if (entry.transport === 'stdio') {
    spec.command = 'npx';
    spec.args = ['-y', `${entry.package}@${params.version || 'latest'}`, ...(entry.args || []).map((a) => (a.startsWith(SECRET_ARG_PREFIX) ? a : fill(a)))];
    spec.env = env;
    spec.secretEnv = entry.secrets.map((s) => s.name);
  } else {
    spec.url = entry.url;
  }
  return { spec, secrets };
}

const envName = { type: 'string', pattern: ENV_NAME_RE };
export const SERVER_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'label', 'transport'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: SERVER_ID_RE },
    label: { type: 'string', minLength: 1, maxLength: 80 },
    transport: { type: 'string', enum: ['stdio', 'http'] },
    command: { type: 'string', minLength: 1, maxLength: 400 },
    args: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 400 } },
    env: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
    secretEnv: { type: 'array', maxItems: 20, items: envName },
    url: { type: 'string', minLength: 1, maxLength: 2000 },
    headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 2000 } },
    clientId: { type: 'string', maxLength: 200 },
    scopes: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 } },
    leash: { type: 'object', additionalProperties: { type: 'string', enum: DOMAINS } },
    amounts: { type: 'object', additionalProperties: { type: 'object', required: ['field'], additionalProperties: false, properties: { field: { type: 'string', minLength: 1, maxLength: 80 }, unit: { type: 'string', enum: AMOUNT_UNITS } } } },
    source: { type: 'string', maxLength: 80 },
    addedAt: { type: 'integer', minimum: 0 },
    accepted: { type: 'object', additionalProperties: { type: 'string', maxLength: 64 } },
    refused: { type: 'object', additionalProperties: { type: 'string', maxLength: 64 } },
    acceptFirstList: { type: 'boolean' }, // set when the add was approved; the first successful tools/list becomes `accepted`
  },
});

// What the Superintendent accepted about a tool: its name, annotations, description and
// schema, as sanitised. A change in any of them is a different tool.
export function toolFingerprint(tool) {
  const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : Array.isArray(v) ? v.map(sorted) : v);
  return createHash('sha256').update(JSON.stringify({ name: tool.name, description: tool.description || '', annotations: sorted(tool.annotations || {}), inputSchema: sorted(tool.inputSchema || {}) })).digest('hex').slice(0, 24);
}

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

// Validates a server spec and its transport-specific fields; returns the clean record.
export function validateServerSpec(spec) {
  const r = validate(SERVER_SCHEMA, spec);
  if (!r.ok) throw fail('BAD_REQUEST', `MCP server invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  for (const k of Object.keys(spec.env || {})) if (!new RegExp(ENV_NAME_RE).test(k)) throw fail('BAD_REQUEST', `MCP server invalid: env name "${k}" is not an environment variable name`);
  for (const [k, v] of Object.entries(spec.headers || {})) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(k) || /^(authorization|cookie)$/i.test(k)) throw fail('BAD_REQUEST', `MCP server invalid: header "${k}" is not allowed (tokens go through the sign-in)`);
    // Safety 2026-10-11 L2: a header value is a secret by default (an API key most of the
    // time), so it is never stored in the config: it names a keystore secret (`$SECRET:NAME`,
    // declared in secretEnv) and is filled in when the server connects (D134).
    if (typeof v !== 'string' || !v.startsWith(SECRET_ARG_PREFIX)) throw fail('BAD_REQUEST', `MCP server invalid: header "${k}" must name a secret as ${SECRET_ARG_PREFIX}NAME (its value goes to the keystore, never to the config file)`);
    if (!(spec.secretEnv || []).includes(v.slice(SECRET_ARG_PREFIX.length))) throw fail('BAD_REQUEST', `MCP server invalid: header ${k} names a secret (${v.slice(SECRET_ARG_PREFIX.length)}) that is not declared in secretEnv`);
  }
  if (spec.transport === 'stdio' && !spec.command) throw fail('BAD_REQUEST', 'a stdio MCP server needs a command');
  for (const a of spec.args || []) if (a.startsWith(SECRET_ARG_PREFIX) && !(spec.secretEnv || []).includes(a.slice(SECRET_ARG_PREFIX.length))) throw fail('BAD_REQUEST', `MCP server invalid: arg ${a} names a secret that is not declared in secretEnv`);
  if (spec.transport === 'http') {
    if (!spec.url) throw fail('BAD_REQUEST', 'an HTTP MCP server needs a url');
    let u;
    try {
      u = new URL(spec.url);
    } catch {
      throw fail('BAD_REQUEST', `MCP server url is not a URL: ${spec.url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('BAD_REQUEST', 'an HTTP MCP server url must be http(s)');
  }
  for (const [tool, domain] of Object.entries(spec.leash || {})) {
    if (MONEY_DOMAINS.includes(domain) && !(spec.amounts && spec.amounts[tool])) throw fail('AMOUNT_REQUIRED', `${tool} cannot be mapped to ${domain} without an amount reading ({ field, unit })`);
  }
  return { ...spec, args: spec.args || [], env: spec.env || {}, secretEnv: spec.secretEnv || [], headers: spec.headers || {}, leash: spec.leash || {}, amounts: spec.amounts || {}, scopes: spec.scopes || [] };
}

export const toolName = (serverId, name) => `${TOOL_PREFIX}.${serverId}.${name}`;
const keyName = (serverId, suffix) => `mcp.${serverId}${suffix ? `.${suffix}` : ''}`;

// The leash domain of one tool under a server's config. Read-only counts only when the
// tool does not also call itself destructive (M1); a pending (unaccepted) tool is never
// research whatever it says or the owner once mapped.
export function domainFor(server, tool, { pending = false } = {}) {
  if (pending) return DEFAULT_DOMAIN;
  if (server.leash && server.leash[tool.name]) return server.leash[tool.name];
  const a = tool.annotations || {};
  return a.readOnlyHint === true && a.destructiveHint !== true ? READ_ONLY_DOMAIN : DEFAULT_DOMAIN;
}

// Which of a connect's tools the Superintendent has not accepted (new or changed), and
// which were refused as they are now (not registered at all).
export function classifyTools(server, tools) {
  const accepted = server.accepted || {};
  const refused = server.refused || {};
  const pending = [];
  const refusedNow = [];
  for (const t of tools) {
    const fp = toolFingerprint(t);
    if (accepted[t.name] === fp) continue;
    if (refused[t.name] === fp) refusedNow.push(t.name);
    else pending.push(t.name);
  }
  return { pending, refused: refusedNow };
}

// The amount a money tool's input moves, read as configured; null when it cannot be read.
export function amountFor(server, tool, input) {
  const cfg = server.amounts && server.amounts[tool.name];
  if (!cfg) return null;
  const raw = input && typeof input === 'object' ? input[cfg.field] : undefined;
  const n = typeof raw === 'string' ? Number(raw.replace(/[$,\s]/g, '')) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return cfg.unit === 'cents' ? n / 100 : n;
}

export function createMcpManager({ bus, store, gateQueue = null, env = process.env, keystorePath, netGuard = defaultNetGuard(), registry = {}, getLayout = () => null, clock = { now: () => Date.now() }, spawn = undefined, fetch: fetchImpl = globalThis.fetch, oauthPort = DEFAULT_OAUTH_PORT, catalog = null, log = console } = {}) {
  if (!bus || !store) throw new TypeError('createMcpManager needs bus and store');
  const catalogData = catalog || loadCatalog();
  let servers = {}; // id -> record (SERVER_SCHEMA shape, no secret values)
  const runtime = new Map(); // id -> { client, transport, status, tools, lastError, pendingItem, flow, authorizeUrl, serverInfo, connectedAt, dropped }
  let saving = Promise.resolve();
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const save = () => {
    saving = saving.then(() => store.saveMcpServers({ version: 1, servers })).catch((err) => log.error('mcp servers save failed:', err));
    return saving;
  };
  const rt = (id) => {
    if (!servers[id]) throw fail('UNKNOWN_SERVER', `no MCP server "${id}"`, 404);
    if (!runtime.has(id)) runtime.set(id, { client: null, transport: null, status: 'down', tools: [], pending: [], refused: [], lastError: null, pendingItem: null, flow: null, authorizeUrl: null, serverInfo: null, connectedAt: null, dropped: 0 });
    return runtime.get(id);
  };

  function emitStatus(id, status, extra = {}) {
    const r = rt(id);
    r.status = status;
    const payload = { server: id, status, transport: servers[id].transport };
    if (status === 'connected') payload.tools = r.tools.length;
    if (extra.message) payload.message = String(extra.message).slice(0, 500);
    if (extra.authorizeUrl) payload.authorizeUrl = extra.authorizeUrl;
    emit('mcp.server', payload);
  }

  async function childEnv(server) {
    const out = {};
    for (const [k, v] of Object.entries(server.env || {})) out[k] = v;
    for (const k of server.secretEnv || []) {
      const v = await resolveKey(keyName(server.id, k), { env: {}, keystorePath, warn: (p) => log.warn && log.warn(p) });
      if (v) out[k] = v;
    }
    // A child needs PATH to find its runtime and nothing else of the sidecar's environment.
    if (!out.PATH && env.PATH) out.PATH = env.PATH;
    if (!out.HOME && env.HOME) out.HOME = env.HOME;
    return out;
  }

  // `$SECRET:NAME` in an arg is filled from the keystore when the child starts (a connection
  // URL with a password, say), so the config file never holds the value.
  async function childArgs(server) {
    const out = [];
    for (const a of server.args || []) {
      if (typeof a === 'string' && a.startsWith(SECRET_ARG_PREFIX)) {
        const name = a.slice(SECRET_ARG_PREFIX.length);
        const v = await resolveKey(keyName(server.id, name), { env: {}, keystorePath, warn: (p) => log.warn && log.warn(p) });
        if (!v) throw fail('SECRET_MISSING', `${server.label} needs the secret ${name} in the keystore`);
        out.push(v);
      } else out.push(a);
    }
    return out;
  }

  // Header values come from the keystore at connect time (L2); a missing one is a plain
  // failure, never an empty header sent along.
  async function childHeaders(server) {
    const out = {};
    for (const [k, v] of Object.entries(server.headers || {})) {
      const name = String(v).slice(SECRET_ARG_PREFIX.length);
      const value = await resolveKey(keyName(server.id, name), { env: {}, keystorePath, warn: (p) => log.warn && log.warn(p) });
      if (!value) throw fail('SECRET_MISSING', `${server.label} needs the secret ${name} (header ${k}) in the keystore`);
      out[k] = value;
    }
    return out;
  }

  async function tokenFor(server) {
    const raw = await resolveKey(keyName(server.id), { env: {}, keystorePath, warn: (p) => log.warn && log.warn(p) });
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      if (!t || !t.accessToken) return null;
      if (t.expiresAt && t.expiresAt - 60_000 < clock.now() && t.refreshToken && t.tokenUrl) {
        const fresh = await refreshTokens({ tokenUrl: t.tokenUrl, clientId: t.clientId, refreshToken: t.refreshToken, fetch: (u, i) => guardedFetch(u, i, { fetch: fetchImpl, guard: netGuard }), clock });
        const merged = { ...t, ...fresh };
        await setKey(keyName(server.id), JSON.stringify(merged), { env: {}, keystorePath });
        return merged;
      }
      return t;
    } catch {
      return null;
    }
  }

  function unregister(id) {
    for (const k of Object.keys(registry)) if (k.startsWith(`${TOOL_PREFIX}.${id}.`)) delete registry[k];
  }

  function register(id) {
    const server = servers[id];
    const r = rt(id);
    unregister(id);
    const { pending, refused } = classifyTools(server, r.tools);
    r.pending = pending;
    r.refused = refused;
    for (const tool of r.tools) {
      if (refused.includes(tool.name)) continue; // refused as it is now: not a tool of this park
      const name = toolName(id, tool.name);
      const isPending = () => (rt(id).pending || []).includes(tool.name);
      registry[name] = {
        name,
        description: `[${server.label} via MCP] ${tool.description}`,
        inputSchema: tool.inputSchema,
        confirm: false,
        mcp: { server: id, tool: tool.name, readOnly: tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true },
        domain: () => domainFor(servers[id] || server, tool, { pending: isPending() }),
        amountUsd: (input) => amountFor(servers[id] || server, tool, input),
        // Safety 2026-10-11 M1: a tool the Superintendent has not accepted waits at the Gate
        // whatever the leash says, until the mcp.accept_tools item is approved.
        holdAtGate: () => (isPending() ? `${server.label}'s tool ${tool.name} is new or changed since you accepted this server's tools; it waits at the Entrance Gate at every leash level until you accept it (the mcp.accept_tools item at the Peak)` : null),
        summarize: (input) => {
          let text = '';
          try {
            text = JSON.stringify(input);
          } catch {
            text = String(input);
          }
          return `${server.label}: ${tool.name} ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`;
        },
        async run(input, ctx) {
          const live = rt(id);
          if (!live.client || live.status !== 'connected') return { ok: false, code: 'MCP_DOWN', error: `${server.label} is ${live.status}; connect it at the Peak` };
          try {
            const out = await live.client.callTool(tool.name, input, { signal: ctx && ctx.signal });
            return out.ok ? { ok: true, output: out.text || '(no content)' } : { ok: false, code: 'MCP_TOOL_ERROR', error: out.text || `${tool.name} reported an error` };
          } catch (err) {
            if (err.code === 'SESSION_LOST' || err.code === 'MCP_CLOSED') {
              live.lastError = { at: clock.now(), stage: 'call', message: err.message, code: err.code };
              emitStatus(id, 'error', { message: err.message });
            }
            return { ok: false, code: err.code || 'MCP_CALL_FAILED', error: err.message };
          }
        },
      };
    }
  }

  // The Gate item that accepts new or changed tools; approve records their fingerprints,
  // reject records them as refused (unregistered until they change again).
  async function askAcceptance(id) {
    const server = servers[id];
    const r = rt(id);
    const pendingTools = r.tools.filter((t) => r.pending.includes(t.name));
    if (!pendingTools.length) return null;
    const accepted = server.accepted || {};
    const label = (t) => `${accepted[t.name] ? 'changed' : 'new'}: ${t.name}${Object.keys(t.annotations || {}).length ? ` [${Object.entries(t.annotations).map(([k, v]) => `${k}=${v}`).join(', ')}]` : ''} — ${t.description || '(no description)'}`;
    const names = pendingTools.map((t) => t.name);
    emit('mcp.server', { server: id, status: 'tools_changed', transport: server.transport, tools: pendingTools.length, message: `waiting for your acceptance at the Gate: ${names.join(', ')}`.slice(0, 500) });
    try {
      return await gated(id, {
        tool: 'mcp.accept_tools',
        summary: `accept ${pendingTools.length} new or changed tool(s) of MCP server ${server.label} (${id})`,
        reason: 'the server listed tools that are new or changed since you accepted its tools; until you accept them each waits at the Gate at every leash level under outbound_messages, and a rejected one is not granted at all until it changes again',
        evidence: [...pendingTools.slice(0, 12).map((t) => ({ kind: 'input', text: label(t).slice(0, 400) })), ...(pendingTools.length > 12 ? [{ kind: 'input', text: `(+${pendingTools.length - 12} more; see the Peak)` }] : [])],
        onApprove: async () => {
          const live = servers[id];
          if (!live) return;
          const next = { ...live, accepted: { ...(live.accepted || {}) }, refused: { ...(live.refused || {}) } };
          for (const t of rt(id).tools) if (names.includes(t.name)) {
            next.accepted[t.name] = toolFingerprint(t);
            delete next.refused[t.name];
          }
          servers = { ...servers, [id]: next };
          await save();
          if (rt(id).status === 'connected') register(id);
          emit('mcp.server', { server: id, status: 'tools_accepted', transport: next.transport, tools: names.length, message: names.join(', ').slice(0, 500) });
        },
        onRefuse: async () => {
          const live = servers[id];
          if (!live) return;
          const next = { ...live, refused: { ...(live.refused || {}) } };
          for (const t of rt(id).tools) if (names.includes(t.name)) next.refused[t.name] = toolFingerprint(t);
          servers = { ...servers, [id]: next };
          await save();
          if (rt(id).status === 'connected') register(id);
        },
      });
    } catch (err) {
      if (err.code === 'PENDING') {
        log.warn && log.warn(`mcp ${id}: tools changed while ${r.pendingItem ? r.pendingItem.tool : 'a decision'} waits at the Gate; the unaccepted tools stay at the Gate and are asked about on the next connect`);
        return null;
      }
      throw err;
    }
  }

  async function connect(id) {
    const server = servers[id];
    const r = rt(id);
    if (r.client) await disconnect(id, { quiet: true });
    try {
      let transport;
      if (server.transport === 'stdio') transport = createStdioTransport({ command: server.command, args: await childArgs(server), env: await childEnv(server), spawn, log });
      else {
        const token = await tokenFor(server);
        transport = createHttpTransport({ url: server.url, headers: await childHeaders(server), token: token ? token.accessToken : null, fetch: fetchImpl, netGuard, log });
      }
      const client = createMcpClient({ transport, clock, log });
      r.transport = transport;
      r.client = client;
      const info = await client.initialize();
      const { tools, dropped } = await client.listTools();
      r.tools = tools;
      r.dropped = dropped;
      r.serverInfo = info.serverInfo;
      r.lastError = null;
      r.connectedAt = clock.now();
      r.authorizeUrl = null;
      if (servers[id].acceptFirstList) {
        // The first successful list after the Superintendent approved the server (a sign-in
        // may come between): this list is what was approved, and later connects are
        // compared with it (M1). A record from before the snapshot existed has no flag, so
        // its tools are pending until accepted once.
        const { acceptFirstList, ...rest } = servers[id];
        servers = { ...servers, [id]: { ...rest, accepted: Object.fromEntries(tools.map((t) => [t.name, toolFingerprint(t)])), refused: {} } };
        await save();
      }
      register(id);
      emitStatus(id, 'connected');
      if (r.pending.length) askAcceptance(id).catch((err) => log.error && log.error(`mcp ${id} acceptance failed:`, err));
      if (transport.kind === 'stdio') transport.exited.then(({ code, signal }) => {
        if (r.transport !== transport) return;
        r.client = null;
        r.transport = null;
        unregister(id);
        if (r.status === 'connected') {
          r.lastError = { at: clock.now(), stage: 'run', message: `the server exited (${signal || `code ${code}`})${transport.stderr() ? `: ${transport.stderr().slice(-300)}` : ''}`, code: 'EXITED' };
          emitStatus(id, 'error', { message: r.lastError.message });
        }
      });
      return r;
    } catch (err) {
      if (r.transport) await r.transport.close().catch(() => {});
      r.client = null;
      r.transport = null;
      unregister(id);
      r.tools = [];
      if (err.code === 'UNAUTHORIZED') {
        r.lastError = { at: clock.now(), stage: 'auth', message: err.message, code: err.code, wwwAuthenticate: err.wwwAuthenticate || '' };
        emitStatus(id, 'needs_auth', { message: 'the server wants a sign-in: authorize it at the Peak' });
      } else {
        r.lastError = { at: clock.now(), stage: 'connect', message: err.message, code: err.code || 'CONNECT_FAILED' };
        emitStatus(id, 'error', { message: err.message });
      }
      return r;
    }
  }

  async function disconnect(id, { quiet = false, by = 'superintendent' } = {}) {
    const r = rt(id);
    unregister(id);
    const client = r.client;
    r.client = null;
    r.transport = null;
    r.tools = [];
    r.pending = [];
    r.refused = [];
    if (client) await client.close().catch(() => {});
    if (!quiet) emitStatus(id, 'disconnected', { message: `stopped by ${by}` });
    else r.status = 'down';
    return r;
  }

  async function gated(id, { tool, summary, reason, evidence, onApprove, onRefuse = null }) {
    if (!gateQueue) throw fail('GATE_UNAVAILABLE', 'no Entrance Gate queue to decide MCP servers', 503);
    const r = runtime.get(id);
    if (r && r.pendingItem) throw fail('PENDING', `${id} already has a decision waiting at the Gate (${r.pendingItem.itemId})`, 409);
    const decision = gateQueue.submit({ agentId: 'superintendent', domain: 'account_settings', tool, summary, level: 'draft', evidence, reason });
    const item = gateQueue.pending().find((it) => it.tool === tool && it.summary === summary) || null;
    if (r) r.pendingItem = item;
    else runtime.set(id, { client: null, transport: null, status: 'down', tools: [], pending: [], refused: [], lastError: null, pendingItem: item, flow: null, authorizeUrl: null, serverInfo: null, connectedAt: null, dropped: 0 });
    decision
      .then(async (d) => {
        const live = runtime.get(id);
        if (live) live.pendingItem = null;
        if (d.decision !== 'approve') {
          emit('mcp.server', { server: id, status: 'refused', message: `${tool} ${d.decision === 'revise' ? 'sent back' : d.status === 'expired' ? 'expired' : 'rejected'} at the Gate${d.notes ? `: ${d.notes}` : ''}` });
          if (!servers[id]) runtime.delete(id);
          else if (onRefuse && d.decision === 'reject') {
            try {
              await onRefuse(d);
            } catch (err) {
              log.error && log.error(`mcp ${id} refuse hook failed:`, err);
            }
          }
          return;
        }
        try {
          await onApprove(d);
        } catch (err) {
          if (runtime.has(id)) runtime.get(id).lastError = { at: clock.now(), stage: 'connect', message: err.message, code: err.code || 'FAILED' };
          emit('mcp.server', { server: id, status: 'error', message: err.message });
        }
      })
      .catch((err) => log.error && log.error(`mcp ${id} gate failed:`, err));
    return { itemId: item ? item.itemId : null, status: 'pending' };
  }

  // OAuth 2.1 for an HTTP server: metadata discovery at the server's origin, dynamic
  // client registration when no client id is configured, PKCE, the token into the keystore.
  async function discover(server) {
    const origin = new URL(server.url).origin;
    const gfetch = (u, i) => guardedFetch(u, i, { fetch: fetchImpl, guard: netGuard });
    let res;
    try {
      res = await gfetch(`${origin}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
    } catch (err) {
      throw fail('OAUTH_DISCOVERY', `could not read ${origin}/.well-known/oauth-authorization-server: ${err.message}`);
    }
    if (!res.ok) throw fail('OAUTH_DISCOVERY', `${origin} publishes no authorization server metadata (${res.status})`);
    const meta = await res.json().catch(() => null);
    if (!meta || typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') throw fail('OAUTH_DISCOVERY', 'authorization server metadata lacks the endpoints');
    for (const u of [meta.authorization_endpoint, meta.token_endpoint, meta.registration_endpoint].filter(Boolean)) await netGuard.assert(u);
    return meta;
  }

  async function registerClient(meta, redirectUri) {
    if (!meta.registration_endpoint) throw fail('NO_CLIENT_ID', 'the server has no dynamic client registration; set clientId on the server');
    const res = await guardedFetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: 'Maka', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }, { fetch: fetchImpl, guard: netGuard });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.client_id !== 'string') throw fail('REGISTRATION_FAILED', `client registration answered ${res.status}: ${body && (body.error_description || body.error) ? body.error_description || body.error : 'no client_id'}`);
    return body.client_id;
  }

  const api = {
    async init() {
      const loaded = await store.loadMcpServers(null);
      if (loaded && loaded.version === 1 && loaded.servers && typeof loaded.servers === 'object') servers = loaded.servers;
      for (const id of Object.keys(servers)) rt(id);
      await Promise.all(Object.keys(servers).map((id) => connect(id).catch((err) => log.error(`mcp ${id} connect failed:`, err))));
      return api;
    },
    list() {
      return Object.values(servers).map((s) => {
        const r = rt(s.id);
        return {
          id: s.id,
          label: s.label,
          transport: s.transport,
          command: s.command || null,
          args: s.args || [],
          env: Object.keys(s.env || {}),
          secretEnv: s.secretEnv || [],
          url: s.url || null,
          headers: Object.keys(s.headers || {}),
          source: s.source || null,
          addedAt: s.addedAt || null,
          status: r.status,
          connectedAt: r.connectedAt,
          serverInfo: r.serverInfo,
          lastError: r.lastError ? { at: r.lastError.at, stage: r.lastError.stage, message: r.lastError.message, code: r.lastError.code } : null,
          pendingItemId: r.pendingItem ? r.pendingItem.itemId : null,
          authorizeUrl: r.authorizeUrl,
          dropped: r.dropped,
          pendingTools: (r.pending || []).length,
          tools: r.tools.map((t) => {
            const pending = (r.pending || []).includes(t.name);
            const refused = (r.refused || []).includes(t.name);
            return { name: t.name, toolName: toolName(s.id, t.name), description: t.description, truncated: t.truncated, readOnly: t.annotations.readOnlyHint === true, destructive: t.annotations.destructiveHint === true, domain: refused ? null : domainFor(s, t, { pending }), amount: s.amounts[t.name] || null, override: Boolean(s.leash[t.name]), accepted: !pending && !refused, pending, refused };
          }),
        };
      });
    },
    status: (id) => api.list().find((s) => s.id === id) || null,
    tools: (id) => rt(id).tools.slice(),
    grantsFor(layout, agentId) {
      if (!layout) return [];
      const agent = (layout.agents || []).find((a) => a.id === agentId);
      if (!agent) return [];
      const room = (layout.rooms || []).find((r) => r.id === agent.roomId);
      if (!room || room.kind === 'mountain_peak') return []; // safety L5: nothing an Outpost brings is the Chief's
      const out = new Set();
      for (const o of layout.objects || []) {
        if (o.roomId !== agent.roomId || o.kind !== 'outpost' || !o.server || !servers[o.server]) continue;
        const r = rt(o.server);
        if (r.status !== 'connected') continue;
        for (const t of r.tools) if (!(r.refused || []).includes(t.name)) out.add(toolName(o.server, t.name));
      }
      return [...out].sort();
    },
    checkPlacement(object) {
      if (!object || object.kind !== 'outpost') return null;
      if (typeof object.server !== 'string' || !servers[object.server]) throw fail('UNKNOWN_SERVER', `an Outpost needs a configured MCP server (server: "${object.server || ''}" is not one); add it at the Peak first`);
      return null;
    },
    // Adds a server through the Gate. `secretEnv` values are taken from spec.secrets
    // ({ VAR: value }) and go to the keystore on approval; the config keeps the names.
    async add(input = {}) {
      const { secrets = {}, ...rest } = input || {};
      const spec = validateServerSpec({ ...rest, secretEnv: [...new Set([...(rest.secretEnv || []), ...Object.keys(secrets)])], addedAt: clock.now() });
      if (servers[spec.id]) throw fail('EXISTS', `MCP server "${spec.id}" already exists`, 409);
      for (const k of Object.keys(secrets)) if (!new RegExp(ENV_NAME_RE).test(k) || typeof secrets[k] !== 'string' || !secrets[k]) throw fail('BAD_REQUEST', `secret "${k}" needs an environment variable name and a value`);
      if (spec.transport === 'http') await netGuard.assert(spec.url);
      const evidence = [
        { kind: 'input', text: spec.transport === 'stdio' ? `stdio: ${spec.command} ${spec.args.join(' ')}`.trim() : `http: ${spec.url}${Object.keys(spec.headers).length ? `; headers ${Object.entries(spec.headers).map(([k, v]) => `${k}: ${v}`).join(', ')} (values from the keystore)` : ''}` },
        { kind: 'input', text: `env: ${Object.keys(spec.env).join(', ') || 'none'}; secrets: ${spec.secretEnv.join(', ') || 'none'}${spec.source ? `; ${spec.source.startsWith('catalog:') ? `from the catalog (${spec.source.slice(8)})` : spec.source}` : ''}` },
        { kind: 'input', text: `leash: read-only tools → ${READ_ONLY_DOMAIN}, others → ${DEFAULT_DOMAIN}${Object.keys(spec.leash).length ? `; overrides ${Object.entries(spec.leash).map(([t, d]) => `${t}=${d}`).join(', ')}` : ''}` },
        { kind: 'input', text: 'the tools it lists on this first connect become the accepted set (shown at the Peak); a tool that is new or changed on a later connect waits at the Gate until you accept it' },
      ];
      return gated(spec.id, {
        tool: 'mcp.add',
        summary: `add MCP server ${spec.label} (${spec.id}, ${spec.transport})`,
        reason: `an MCP server is a new tool source: it ${spec.transport === 'stdio' ? 'runs a process on this machine' : 'is reached over the network'} and its tools are granted to Rangers through Outposts you place; nothing starts without your approval`,
        evidence,
        onApprove: async () => {
          for (const [k, v] of Object.entries(secrets)) await setKey(keyName(spec.id, k), v, { env: {}, keystorePath });
          servers = { ...servers, [spec.id]: { ...spec, acceptFirstList: true } };
          await save();
          emit('mcp.server', { server: spec.id, status: 'configured', transport: spec.transport });
          await connect(spec.id);
        },
      });
    },
    // The curated catalog: entries with what each needs; `addFromCatalog` builds the spec
    // (secret values go to the keystore on approval) and parks it at the Gate like add().
    catalog: () => catalogData.entries.map((e) => ({ id: e.id, label: e.label, description: e.description, source: e.source, license: e.license || null, transport: e.transport, package: e.package || null, url: e.url || null, params: e.params, secrets: e.secrets.map((s) => ({ name: s.name, label: s.label, hint: s.hint || '' })), leash: e.leash || {}, notes: e.notes || '', installed: Object.values(servers).some((s) => s.source === `catalog:${e.id}`) })),
    async addFromCatalog(entryId, { params = {}, secrets = {}, id = null, label = null } = {}) {
      const entry = catalogData.entries.find((e) => e.id === entryId);
      if (!entry) throw fail('UNKNOWN_ENTRY', `no catalog entry "${entryId}"`, 404);
      const built = specFromCatalog(entry, { params, secrets, id, label });
      return api.add({ ...built.spec, secrets: built.secrets });
    },
    async remove(id) {
      const server = servers[id];
      if (!server) throw fail('UNKNOWN_SERVER', `no MCP server "${id}"`, 404);
      const r = rt(id);
      return gated(id, {
        tool: 'mcp.remove',
        summary: `remove MCP server ${server.label} (${id})`,
        reason: 'the server is stopped, its config and tokens are forgotten, and Outposts for it grant nothing',
        evidence: [{ kind: 'input', text: `${r.tools.length} tool(s) granted today; ${(getLayout() ? getLayout().objects : []).filter((o) => o.kind === 'outpost' && o.server === id).length} Outpost(s) placed` }],
        onApprove: async () => {
          await disconnect(id, { quiet: true });
          if (r.flow) {
            r.flow.cancel();
            r.flow = null;
          }
          for (const k of server.secretEnv || []) await setKey(keyName(id, k), null, { env: {}, keystorePath }).catch(() => {});
          await setKey(keyName(id), null, { env: {}, keystorePath }).catch(() => {});
          const next = { ...servers };
          delete next[id];
          servers = next;
          runtime.delete(id);
          await save();
          emit('mcp.server', { server: id, status: 'removed', transport: server.transport });
        },
      });
    },
    connect: (id) => connect((rt(id), id)),
    disconnect: (id) => disconnect((rt(id), id)),
    // The per-tool leash mapping; a money domain needs an amount reading (refused otherwise).
    async setLeash(id, { tool, domain, amount } = {}) {
      const server = servers[id];
      if (!server) throw fail('UNKNOWN_SERVER', `no MCP server "${id}"`, 404);
      if (typeof tool !== 'string' || !tool) throw fail('BAD_REQUEST', 'tool is required');
      if (domain !== null && domain !== undefined && !DOMAINS.includes(domain)) throw fail('BAD_REQUEST', `domain must be one of ${DOMAINS.join(', ')} (or null to clear the override)`);
      const next = { ...server, leash: { ...server.leash }, amounts: { ...server.amounts } };
      if (amount === null) delete next.amounts[tool];
      else if (amount !== undefined) {
        const r = validate(SERVER_SCHEMA.properties.amounts.additionalProperties, amount);
        if (!r.ok) throw fail('BAD_REQUEST', `amount invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
        next.amounts[tool] = { field: amount.field, unit: amount.unit || 'usd' };
      }
      if (domain === null || domain === undefined) delete next.leash[tool];
      else next.leash[tool] = domain;
      const effective = next.leash[tool];
      if (effective && MONEY_DOMAINS.includes(effective) && !next.amounts[tool]) throw fail('AMOUNT_REQUIRED', `${tool} cannot be mapped to ${effective} without an amount reading ({ field, unit }); without one the tool stays at ${domainFor(server, { name: tool, annotations: {} })} and a money call would be unknown-amount`);
      servers = { ...servers, [id]: next };
      await save();
      emit('mcp.server', { server: id, status: 'configured', transport: next.transport, message: `${tool} → ${effective || 'default'}` });
      return api.status(id);
    },
    // The sign-in for an HTTP server that answered 401.
    async auth(id) {
      const server = servers[id];
      if (!server) throw fail('UNKNOWN_SERVER', `no MCP server "${id}"`, 404);
      if (server.transport !== 'http') throw fail('BAD_REQUEST', 'only an HTTP MCP server signs in');
      const r = rt(id);
      if (r.flow) throw fail('PENDING', `${server.label} has a sign-in in progress; open ${r.authorizeUrl}`, 409);
      return gated(id, {
        tool: 'mcp.auth',
        summary: `sign in to MCP server ${server.label} (OAuth)`,
        reason: 'the sign-in opens a local callback and stores the token in the keystore only with your approval',
        evidence: [{ kind: 'input', text: `${server.url}${server.scopes.length ? `; scopes ${server.scopes.join(' ')}` : ''}` }],
        onApprove: async () => {
          const meta = await discover(server);
          const redirectUri = `http://127.0.0.1:${oauthPort}${CALLBACK_PATH}`;
          const clientId = server.clientId || (await registerClient(meta, redirectUri));
          const flow = createOAuthFlow({ authorizeUrl: meta.authorization_endpoint, tokenUrl: meta.token_endpoint, clientId, scopes: server.scopes, redirectPort: oauthPort, extraAuthParams: { resource: server.url }, fetch: (u, i) => guardedFetch(u, i, { fetch: fetchImpl, guard: netGuard }), clock });
          const started = await flow.start();
          r.flow = flow;
          r.authorizeUrl = started.authorizeUrl;
          emitStatus(id, 'authorizing', { authorizeUrl: started.authorizeUrl });
          flow.finished
            .then(async (tokens) => {
              r.flow = null;
              r.authorizeUrl = null;
              await setKey(keyName(id), JSON.stringify({ ...tokens, tokenUrl: meta.token_endpoint, clientId }), { env: {}, keystorePath });
              await connect(id);
            })
            .catch((err) => {
              r.flow = null;
              r.authorizeUrl = null;
              r.lastError = { at: clock.now(), stage: 'auth', message: err.message, code: err.code || 'OAUTH_FAILED' };
              emitStatus(id, 'error', { message: err.message });
            });
        },
      });
    },
    async close() {
      for (const id of Object.keys(servers)) {
        const r = runtime.get(id);
        if (r && r.flow) r.flow.cancel();
        await disconnect(id, { quiet: true }).catch(() => {});
      }
    },
    flushed: () => saving,
    servers: () => ({ ...servers }),
    toolName,
    newId: (label) => `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'mcp'}-${randomUUID().slice(0, 4)}`,
  };
  return api;
}
