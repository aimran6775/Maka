// Connector framework (phase 2 step 14): official platform APIs behind one registry.
//
//   createConnectors({ bus, store, scheduler, gateQueue, env, keystorePath, clock, fetch,
//                      config, log })
//     .define(spec)      registers a connector kind (see SPEC below)
//     .init()            loads data, wires sync jobs for connected kinds
//     .list()            one status row per kind (no secrets)
//     .connect(kind, { apiKey })  / .connect(kind, {})   (OAuth) -> a Gate item
//     .disconnect(kind)  -> a Gate item
//     .sync(kind, reason) -> { counts, ms }
//     .data(kind)        the local store for that kind (what syncs brought in)
//     .client(kind)      an authenticated client for the tools (throws NOT_CONNECTED)
//     .tools             the generic tools (connector.status, connector.sync)
//
// SPEC = { kind, label, auth: 'api_key' | 'oauth2', keyName (keystore / ENV_VARS name),
//          zoneKind | zoneKinds (the camps whose cards show it), syncEveryMs,
//          oauth: { authorizeUrl, tokenUrl, clientIdKey, clientSecretKey?, scopes,
//          extraAuthParams? }, makeClient({ token, fetch, env, config, keys }) (may be async),
//          sync({ client, data, emit }) -> { data, counts }, tools: { name: tool } }
//
// Credentials: an environment variable (ENV_VARS) connects a kind without ceremony, as
// the keys of every provider do; a key or an OAuth sign-in given through the UI is an
// Entrance Gate item in account_settings (docs/DECISIONS.md D75) and lands in the 0600
// keystore. OAuth tokens are one JSON string under the kind's keyName. Every sync emits
// connector.sync; every failure connector.error. Nothing shown in the park comes from
// anywhere but these syncs.

import { makeEvent } from '../../shared/events.js';
import { resolveKey, setKey } from '../providers/keys.js';
import { createOAuthFlow, refreshTokens } from './oauth.js';

export const DEFAULT_SYNC_MS = 15 * 60 * 1000;
export const CONNECTOR_AUTH_KINDS = Object.freeze(['api_key', 'oauth2']);

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function parseToken(raw) {
  if (!raw) return null;
  if (raw.trim().startsWith('{')) {
    try {
      const t = JSON.parse(raw);
      return t && t.accessToken ? t : null;
    } catch {
      return null;
    }
  }
  return { accessToken: raw, refreshToken: null, expiresAt: null, scope: '', tokenType: 'Bearer', apiKey: true };
}

export function createConnectors({ bus, store, scheduler = null, gateQueue = null, env = process.env, keystorePath, clock = { now: () => Date.now() }, fetch: fetchImpl = globalThis.fetch, config = {}, log = console } = {}) {
  if (!bus) throw new TypeError('createConnectors needs bus');
  if (!store) throw new TypeError('createConnectors needs store');
  const specs = new Map(); // kind -> spec
  const runtime = new Map(); // kind -> { data, connected, auth, lastSync, lastError, flow, pendingItem, syncing, by }
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const jobId = (kind) => `connector-${kind}`;

  function rt(kind) {
    const spec = specs.get(kind);
    if (!spec) throw fail('UNKNOWN_CONNECTOR', `no connector "${kind}"`, 404);
    return { spec, r: runtime.get(kind) };
  }

  // The spec's own environment variable first (STRIPE_API_KEY, say), then the keystore.
  async function token(kind) {
    const { spec } = rt(kind);
    const fromEnv = spec.envVar && env[spec.envVar] && String(env[spec.envVar]).trim();
    if (fromEnv) return parseToken(fromEnv);
    return parseToken(await resolveKey(spec.keyName, { env, keystorePath, warn: (p) => log.warn && log.warn(p) }));
  }

  async function freshToken(kind) {
    const { spec, r } = rt(kind);
    let t = await token(kind);
    if (!t) throw fail('NOT_CONNECTED', `${spec.label} is not connected`, 409);
    if (spec.auth === 'oauth2' && t.expiresAt && t.expiresAt - 60_000 < clock.now()) {
      if (!t.refreshToken) throw fail('TOKEN_EXPIRED', `${spec.label}'s token expired and cannot be renewed; connect again`, 409);
      const clientId = await resolveKey(spec.oauth.clientIdKey, { env, keystorePath });
      const clientSecret = spec.oauth.clientSecretKey ? await resolveKey(spec.oauth.clientSecretKey, { env, keystorePath }) : null;
      t = await refreshTokens({ tokenUrl: spec.oauth.tokenUrl, clientId, clientSecret, refreshToken: t.refreshToken, fetch: fetchImpl, clock });
      await setKey(spec.keyName, JSON.stringify(t), { env, keystorePath });
      r.auth = 'oauth2';
    }
    return t;
  }

  const keys = { get: (name) => resolveKey(name, { env, keystorePath }) };
  async function clientFor(kind) {
    const { spec } = rt(kind);
    const t = await freshToken(kind);
    return spec.makeClient({ token: t, fetch: fetchImpl, env, config: config[kind] || {}, keys });
  }

  async function runSync(kind, reason) {
    const { spec, r } = rt(kind);
    if (r.syncing) return { skipped: true, why: 'already syncing' };
    r.syncing = true;
    const started = clock.now();
    emit('connector.sync', { connector: kind, status: 'started', reason });
    try {
      const client = await clientFor(kind);
      const out = await spec.sync({ client, data: r.data, emit: (type, payload) => emit(type, payload), clock, log });
      r.data = { ...out.data, syncedAt: clock.now() };
      await store.saveConnector(kind, r.data);
      r.lastSync = { at: clock.now(), ok: true, reason, counts: out.counts || {}, ms: clock.now() - started };
      r.lastError = null;
      r.connected = true;
      emit('connector.sync', { connector: kind, status: 'done', reason, counts: out.counts || {}, ms: r.lastSync.ms });
      return { counts: out.counts || {}, ms: r.lastSync.ms };
    } catch (err) {
      r.lastSync = { at: clock.now(), ok: false, reason, error: err.message, code: err.code || 'SYNC_FAILED', ms: clock.now() - started };
      r.lastError = { at: clock.now(), stage: 'sync', message: err.message, code: err.code || 'SYNC_FAILED' };
      if (err.code === 'NOT_CONNECTED') r.connected = false;
      emit('connector.sync', { connector: kind, status: 'failed', reason, message: err.message, ms: r.lastSync.ms });
      emit('connector.error', { connector: kind, stage: 'sync', message: err.message, code: err.code || 'SYNC_FAILED' });
      throw err;
    } finally {
      r.syncing = false;
    }
  }

  function wireJob(kind) {
    const { spec } = rt(kind);
    if (!scheduler) return;
    if (scheduler.state()[jobId(kind)]) return;
    scheduler.add(jobId(kind), { everyMs: spec.syncEveryMs || config.syncEveryMs || DEFAULT_SYNC_MS }, async ({ reason }) => {
      await runSync(kind, reason === 'missed' ? 'missed' : 'scheduled').catch(() => {});
    });
  }

  async function becomeConnected(kind, by, auth) {
    const { r } = rt(kind);
    r.connected = true;
    r.auth = auth;
    r.by = by;
    r.connectedAt = clock.now();
    emit('connector.status', { connector: kind, change: 'connected', connected: true, auth, by });
    wireJob(kind);
    await runSync(kind, 'connected').catch(() => {});
  }

  // Parks a credential decision at the Gate for the Superintendent; resolves with the item.
  async function gated(kind, { summary, reason, evidence, tool, onApprove }) {
    const { spec, r } = rt(kind);
    if (!gateQueue) throw fail('GATE_UNAVAILABLE', 'no Entrance Gate queue to decide connector credentials', 503);
    if (r.pendingItem) throw fail('PENDING', `${spec.label} already has a decision waiting at the Gate (${r.pendingItem.itemId})`, 409);
    const decision = gateQueue.submit({ agentId: 'superintendent', domain: 'account_settings', tool, summary, level: 'draft', evidence, reason });
    const item = gateQueue.pending().find((it) => it.tool === tool && it.summary === summary) || null;
    r.pendingItem = item;
    decision
      .then(async (d) => {
        r.pendingItem = null;
        if (d.decision !== 'approve') {
          emit('connector.error', { connector: kind, stage: 'connect', message: `${tool} ${d.decision === 'revise' ? 'sent back' : d.status === 'expired' ? 'expired' : 'rejected'} at the Gate${d.notes ? `: ${d.notes}` : ''}`, code: 'GATE_' + (d.decision || d.status || 'declined').toUpperCase() });
          return;
        }
        try {
          await onApprove(d);
        } catch (err) {
          r.lastError = { at: clock.now(), stage: 'connect', message: err.message, code: err.code || 'CONNECT_FAILED' };
          emit('connector.error', { connector: kind, stage: 'connect', message: err.message, code: err.code || 'CONNECT_FAILED' });
        }
      })
      .catch((err) => log.error && log.error(`connector ${kind} gate failed:`, err));
    return { itemId: item ? item.itemId : null, status: 'pending' };
  }

  const api = {
    define(spec) {
      if (!spec || !spec.kind || !spec.label) throw new TypeError('a connector spec needs kind and label');
      if (!CONNECTOR_AUTH_KINDS.includes(spec.auth)) throw new TypeError(`connector ${spec.kind}: auth must be ${CONNECTOR_AUTH_KINDS.join(' or ')}`);
      if (typeof spec.makeClient !== 'function' || typeof spec.sync !== 'function') throw new TypeError(`connector ${spec.kind}: makeClient and sync are required`);
      if (spec.auth === 'oauth2' && !(spec.oauth && spec.oauth.authorizeUrl && spec.oauth.tokenUrl && spec.oauth.clientIdKey)) throw new TypeError(`connector ${spec.kind}: oauth needs authorizeUrl, tokenUrl, clientIdKey`);
      const zoneKinds = spec.zoneKinds || (spec.zoneKind ? [spec.zoneKind] : []);
      specs.set(spec.kind, { keyName: spec.kind, syncEveryMs: DEFAULT_SYNC_MS, tools: {}, ...spec, zoneKinds, zoneKind: zoneKinds[0] || null });
      runtime.set(spec.kind, { data: spec.emptyData ? spec.emptyData() : {}, connected: false, auth: null, lastSync: null, lastError: null, flow: null, pendingItem: null, syncing: false, by: null, connectedAt: null });
      Object.assign(api.tools, spec.tools || {});
      return api;
    },
    // Loads each kind's store and, for the connected ones, wires the sync job and starts a
    // first sync when the store is empty (config.syncOnBoot false turns that off; tests).
    // `booted` settles when those first syncs are done.
    booted: Promise.resolve(),
    async init() {
      const firstSyncs = [];
      for (const [kind, spec] of specs) {
        const r = runtime.get(kind);
        r.data = await store.loadConnector(kind, r.data);
        const t = await token(kind);
        if (t) {
          r.connected = true;
          r.auth = t.apiKey ? (spec.auth === 'api_key' ? 'api_key' : 'oauth2') : 'oauth2';
          r.by = env[spec.envVar || ''] ? 'env' : 'keystore';
          wireJob(kind);
          if (config.syncOnBoot !== false && !r.data.syncedAt) firstSyncs.push(runSync(kind, 'boot').catch(() => {}));
        }
      }
      api.booted = Promise.allSettled(firstSyncs);
      return api;
    },
    kinds: () => [...specs.keys()],
    spec: (kind) => rt(kind).spec,
    list() {
      return [...specs.values()].map((spec) => {
        const r = runtime.get(spec.kind);
        return {
          kind: spec.kind,
          label: spec.label,
          auth: spec.auth,
          zoneKind: spec.zoneKind,
          zoneKinds: spec.zoneKinds,
          connected: r.connected,
          by: r.by,
          connectedAt: r.connectedAt,
          pendingItemId: r.pendingItem ? r.pendingItem.itemId : null,
          authorizeUrl: r.flow ? r.flow.authorizeUrl : null,
          lastSync: r.lastSync,
          lastError: r.lastError,
          syncing: r.syncing,
          syncedAt: r.data && r.data.syncedAt ? r.data.syncedAt : null,
          summary: typeof spec.summarize === 'function' ? spec.summarize(r.data) : null,
          job: scheduler ? scheduler.state()[jobId(spec.kind)] || null : null,
        };
      });
    },
    status: (kind) => api.list().find((c) => c.kind === kind) || null,
    data: (kind) => rt(kind).r.data,
    client: clientFor,
    sync: (kind, reason = 'manual') => runSync(kind, reason),
    // Credentials through the Gate. API key: { apiKey }. OAuth: {} starts the sign-in on
    // approval; `authorizeUrl` then appears in status() for the Superintendent to open.
    async connect(kind, { apiKey } = {}) {
      const { spec, r } = rt(kind);
      if (spec.auth === 'api_key') {
        if (typeof apiKey !== 'string' || !apiKey.trim()) throw fail('BAD_REQUEST', `${spec.label} needs an API key`);
        const key = apiKey.trim();
        return gated(kind, {
          tool: 'connector.connect',
          summary: `connect ${spec.label} with an API key`,
          reason: `${spec.label}'s key is stored in the keystore only with your approval`,
          evidence: [{ kind: 'input', text: `${spec.label} key ending in …${key.slice(-4)}` }],
          onApprove: async () => {
            await setKey(spec.keyName, key, { env, keystorePath });
            await becomeConnected(kind, 'keystore', 'api_key');
          },
        });
      }
      const clientId = await resolveKey(spec.oauth.clientIdKey, { env, keystorePath });
      if (!clientId) throw fail('NO_CLIENT_ID', `${spec.label} needs ${spec.oauth.clientIdKey} (the app's client id) in the environment or keystore before it can sign in`);
      if (r.flow) throw fail('PENDING', `${spec.label} has a sign-in in progress; open ${r.flow.authorizeUrl}`, 409);
      return gated(kind, {
        tool: 'connector.connect',
        summary: `connect ${spec.label} by signing in (OAuth)`,
        reason: `${spec.label}'s sign-in opens a local callback and stores the token in the keystore only with your approval`,
        evidence: [{ kind: 'input', text: `scopes: ${(spec.oauth.scopes || []).join(' ') || '(default)'}` }],
        onApprove: async () => {
          const clientSecret = spec.oauth.clientSecretKey ? await resolveKey(spec.oauth.clientSecretKey, { env, keystorePath }) : null;
          const flow = createOAuthFlow({ authorizeUrl: spec.oauth.authorizeUrl, tokenUrl: spec.oauth.tokenUrl, clientId, clientSecret, scopes: spec.oauth.scopes || [], redirectPort: config.oauthPort !== undefined ? config.oauthPort : undefined, extraAuthParams: spec.oauth.extraAuthParams || {}, fetch: fetchImpl, clock });
          const started = await flow.start();
          r.flow = { authorizeUrl: started.authorizeUrl, redirectUri: started.redirectUri, cancel: () => flow.cancel() };
          emit('connector.status', { connector: kind, change: 'authorizing', connected: false, auth: 'oauth2', by: 'superintendent', authorizeUrl: started.authorizeUrl });
          flow.finished
            .then(async (tokens) => {
              r.flow = null;
              await setKey(spec.keyName, JSON.stringify(tokens), { env, keystorePath });
              await becomeConnected(kind, 'keystore', 'oauth2');
            })
            .catch((err) => {
              r.flow = null;
              r.lastError = { at: clock.now(), stage: 'auth', message: err.message, code: err.code || 'OAUTH_FAILED' };
              emit('connector.error', { connector: kind, stage: 'auth', message: err.message, code: err.code || 'OAUTH_FAILED' });
            });
        },
      });
    },
    async disconnect(kind) {
      const { spec, r } = rt(kind);
      if (r.flow) {
        r.flow.cancel();
        r.flow = null;
      }
      if (!r.connected) throw fail('NOT_CONNECTED', `${spec.label} is not connected`, 409);
      return gated(kind, {
        tool: 'connector.disconnect',
        summary: `disconnect ${spec.label}`,
        reason: `${spec.label}'s credential is removed from the keystore only with your approval${env[spec.envVar || ''] ? `; it is also set in the environment (${spec.envVar}), which Maka cannot unset` : ''}`,
        evidence: [{ kind: 'input', text: `${spec.label}: ${r.auth || 'credential'} from ${r.by || 'the keystore'}` }],
        onApprove: async () => {
          await setKey(spec.keyName, null, { env, keystorePath });
          r.connected = Boolean(await token(kind));
          r.auth = r.connected ? r.auth : null;
          r.by = r.connected ? 'env' : null;
          if (!r.connected && scheduler) scheduler.remove(jobId(kind));
          emit('connector.status', { connector: kind, change: r.connected ? 'connected' : 'disconnected', connected: r.connected, auth: r.auth || 'none', by: r.by || 'superintendent' });
        },
      });
    },
    async close() {
      for (const r of runtime.values()) if (r.flow) r.flow.cancel();
    },
    tools: {},
  };

  // Generic tools (research): what is connected and a sync on demand. Specific
  // connectors add their own in the following steps.
  api.tools['connector.status'] = {
    name: 'connector.status',
    description: 'List the platform connectors (Stripe, Shopify, Etsy, ads…): which are connected, when they last synced, and a summary of what the local store holds.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    confirm: false,
    summarize: () => 'check the connectors',
    async run() {
      return { ok: true, output: JSON.stringify(api.list().map(({ kind, label, connected, lastSync, syncedAt, summary }) => ({ kind, label, connected, lastSync: lastSync ? { at: lastSync.at, ok: lastSync.ok, error: lastSync.error || null } : null, syncedAt, summary }))) };
    },
  };
  api.tools['connector.sync'] = {
    name: 'connector.sync',
    description: 'Sync one connector now (reads from the platform into the local store). Returns the counts.',
    inputSchema: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', minLength: 1 } } },
    confirm: false,
    summarize: (input) => `sync the ${input.kind} connector`,
    async run(input) {
      try {
        const out = await runSync(input.kind, 'ranger');
        return { ok: true, output: JSON.stringify(out) };
      } catch (err) {
        return { ok: false, code: err.code || 'SYNC_FAILED', error: err.message };
      }
    },
  };
  return api;
}
