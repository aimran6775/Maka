// HTTP + SSE server. Routes:
//   GET  /api/state            snapshot: providers (configured or not), layout, active and
//                              queued runs, spend, pending prompts, object kinds, recent runs,
//                              leash, ledger, gate, judge, agents, work items, and `token`:
//                              the per-boot token every mutating request must send in
//                              x-maka-token, with application/json and a same-origin Origin
//                              (safety M4; the Resend webhook is signed instead)
//   GET  /api/events           SSE stream of every event (replays after Last-Event-ID)
//   POST /api/run              { agentId?, prompt, provider?, model?, maxTurns?, budgetUsd? } → 202
//                              { runId, queued } (one run per agent at a time, global cap);
//                              other fields are dropped (safety M3: review / step / system /
//                              workItemId are internal to the Chief and the trails)
//   POST /api/cancel           { runId? } (no id: everything, queued included)
//   GET  /api/work             work items, newest first; /api/work/:id one item
//   POST /api/work             { toAgentId, brief, budgetUsd?, deadline?, evidence? } the
//                              Superintendent delegates → work.handoff + a queued run
//   POST /api/work/:id/cancel
//   GET  /api/layout           the layout
//   PUT  /api/layout           replace the layout (validated)
//   POST /api/layout/place     { kind, roomId, x, y, objectId? } → emits object.place
//   POST /api/layout/reclaim   { objectId } → emits object.reclaim
//   POST /api/layout/reroll    { seed? } → new park seed, emits layout.seed
//   POST /api/permission       { promptId, runId, allow } → emits permission.response
//   GET  /api/gate             { pending, recent, ledger } the Entrance Gate queue
//   POST /api/gate/:id         { decision: approve|revise|reject, notes? } → gate.item
//   GET  /api/mission          { mission, plan, chief, caps, judgeToday }
//   POST /api/mission          { text, budgetUsd, horizon? } → the Chief plans (202 { mission, runId })
//   GET  /api/reflections      reflection summaries, newest first; /api/reflections/:id the document
//   POST /api/reflect          run the reflection now (202 { started }) — the result is reflection.posted
//   GET  /api/mail/dns         keys wired?, last plan, last apply
//   POST /api/mail/dns/plan    dry-run diff of the mail domain's DNS (Resend records vs Cloudflare)
//   POST /api/mail/dns/apply   parks the write at the Entrance Gate (account_settings); 202 { itemId }
//   GET  /api/mail             mail status: keys, addresses, counts, sync
//   GET  /api/mail/addresses   routing rules; POST { local, agentId?, venture?, station } makes an alias
//   DELETE /api/mail/addresses/:address
//   GET  /api/mail/messages    ?station&venture&threadId&direction&label&agentId&limit (summaries)
//   GET  /api/mail/messages/:id   the full message
//   GET  /api/mail/threads     ?station&venture&limit
//   GET  /api/mail/search?q=
//   GET  /api/mail/suppressions
//   POST /api/mail/sync        poll Resend now → { received }
//   POST /api/mail/send        the Superintendent sends from a station address (policy: ceilings,
//                              suppression; no leash, the owner is the principal) → the stored copy
//   POST /api/mail/resend/webhook   Resend webhook (raw body, svix signature)
//   GET  /api/setup            the first-run flow's state (phase 3 step 3)
//   POST /api/setup/workspace  { root } → config.json workspaceRoot; a changed root restarts the sidecar in-process
//   POST /api/setup/key        { provider: anthropic|openrouter, key } → verified against the provider, then stored
//   POST /api/setup/complete   { skipped? } → the card closes for good
//   POST /api/setup/reset      show the card again
//   GET  /api/ollama           the local worker: reachable, version, models with sizes, install, memory, recommendation
//   POST /api/ollama/pull      { model } → 202; progress streams as ollama.pull events
//   POST /api/ollama/start     start the installed Ollama (the app or `ollama serve`)
//   DELETE /api/ollama/models/:name
//   POST /api/restart          restart the sidecar in-process (202); the page reconnects
//   GET  /api/backup           R2 backup: wired?, enabled, schedule, last snapshots (phase 3 step 5)
//   POST /api/backup/config    { enabled?, at?, bucket?, prefix? } → config.json; enabling makes the key (returned once)
//   POST /api/backup/now       one snapshot now → the entry (backup.snapshot events meanwhile)
//   GET  /api/backup/list      snapshots in the bucket under this machine's prefix, newest first
//   POST /api/backup/verify    { key? } opens a snapshot (latest by default) and lists it; writes nothing
//   POST /api/backup/restore   { key?, into? } restores into a fresh directory (workspace/_restore/<stamp>)
//   GET  /api/research         the Scout kit: search provider, trend sources, judge wired
//   GET  /api/briefs           venture briefs from every Ranger's outbox, newest first
//   GET  /api/creative         the creative kit: image model wired, judge, hosted calls today (phase 4 step 8)
//   GET  /api/voice            voice: the recogniser outside the app (Hugging Face, HF_TOKEN) wired or not, the model, the hosted calls (phase 4 step 14)
//   POST /api/voice/transcribe audio/* body (token and Origin checked, at most 10 MB) → { text, via, ms }: relayed to Hugging Face, never stored
//   POST /api/voice/heard      { via, text, accepted, use } what the Superintendent did with a transcript → voice.transcript (the length, never the words)
//   POST /api/peak/ask         { question } → the Chief answers from the recorded data (one tool-less run, judge spend) → { runId, answer, evidence }
//   GET  /api/recipes          the recipe library (latest versions, grants); /api/recipes/:id the document (phase 4 step 12)
//   POST /api/recipes          { ...recipe } saves a new recipe or the next version of one
//   POST /api/recipes/:id/plan   { ventureId, params } what a run would do: receivers, problems, notes (nothing runs)
//   POST /api/recipes/:id/run    { ventureId, params } runs it as the Superintendent (202 with the run)
//   POST /api/recipes/:id/grant  { role } or { agentId }; /revoke the same
//   GET  /api/recipe-runs      recent runs; /api/recipe-runs/:id one run
//   GET  /api/skills           the skills; POST /api/skills saves one
//   GET  /api/memory?agentId=  Ranger memory items an agent can see (all with no agentId); phase 4 step 11
//   POST /api/memory/:id/feedback  { vote: up | down } the Superintendent's 👍 / 👎 (a net −1 mutes the item)
//   DELETE /api/memory/:id     forget an item for good
//   GET  /api/scout-memory     the Scout's memory: every brief with its scored estimates and outcome, history by niche and channel (phase 4 step 10)
//   GET  /api/results          the results engine: per venture / Ranger actuals, unit economics, proposals (phase 4 step 9)
//   POST /api/results/rollup   roll today up now (200 with the computed results; results.rollup is emitted)
//   GET  /api/creatives        ad copy and images from every Ranger's outbox, newest first (?kind=copy|image)
//   GET  /api/connectors       one status row per connector (connected, last sync, summary)
//   GET  /api/connectors/:kind the row plus the local data the syncs brought in
//   POST /api/connectors/:kind/connect    { apiKey } or {} (OAuth) → a Gate item; 202
//   POST /api/connectors/:kind/disconnect → a Gate item; 202
//   POST /api/connectors/:kind/sync       sync now → { counts, ms }
//   GET  /api/channels         owner channels (phase 4 step 1): one row per adapter (status, paired
//                              chats), the current pairing code when one is valid
//   POST /api/channels/pair    a fresh single-use pairing code (ten minutes) → { code, expiresAt }
//   POST /api/channels/:name/unpair     { chatId }
//   POST /api/channels/:name/connect    { token } → a Gate item (account_settings); 202
//   POST /api/channels/:name/disconnect → a Gate item; 202
//   GET  /api/mcp              MCP servers (phase 4 step 4): one row per server with status and tools
//   POST /api/mcp/servers      { id, label, transport, command?, args?, env?, secrets?, url?, headers?, clientId?, scopes?, leash?, amounts? } → a Gate item; 202
//   POST /api/mcp/servers/:id/remove | connect | disconnect | auth   (remove and auth are Gate items; 202)
//   PUT  /api/mcp/servers/:id/leash   { tool, domain, amount? } → the per-tool leash mapping
//   GET  /api/mcp/catalog      the curated catalog (phase 4 step 5); POST /api/mcp/catalog/:id { params, secrets, id?, label? } → a Gate item; 202
//   GET  /api/browser          chromium found?, headless, open sessions, pending handoffs
//   GET  /api/browser/handoffs recent BROWSER HANDOFFs, oldest first
//   POST /api/browser/handoff/:id/return   { notes? } the Superintendent hands the page back
//   GET  /api/browser/trace/:agentId?limit   the Ranger's browser trace, newest first
//   GET  /api/away             away state (flag, since, counters, last digest)
//   POST /api/away             { away: true|false } → away.changed (+ away.digest and the digest on return)
//   GET  /api/away/log         the evidence log lines (JSON array)
//   GET  /api/agents           every agent record with zone, reports, grants, resolved leash
//   POST /api/agents           { name, role?, zoneId, parentAgentId?, venture?, specialty?, persona?, policy? }
//   GET  /api/agents/:id
//   PATCH /api/agents/:id      { name?, zoneId?, parentAgentId?, venture?, specialty?, persona?, policy?, leash? }
//   DELETE /api/agents/:id
//   POST /api/agents/:id/pause   cancels its runs, no new runs until resume
//   POST /api/agents/:id/resume
//   GET  /api/leash            the live leash policy
//   PUT  /api/leash            replace the leash policy (validated, persisted)
//   GET  /api/runs             run summaries, newest first
//   GET  /api/runs/:id         one run record (events + messages)
//   GET  /shared/*             the shared contract modules, served to the browser
//   GET  /*                    the static frontend
//
// Client-originated events (object.place, object.reclaim, permission.response) are built
// with makeEvent so they are schema-validated before anything is changed.

import http from 'node:http';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeEvent, CONTRACT_VERSION, PAYLOAD_SCHEMAS } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { LAYOUT_SCHEMA, OBJECT_KINDS, roomOf, tileInRoom, PEAK_REFUSED_KINDS, peakConnectorProblem } from '../shared/world.js';
import { validateLeash } from '../shared/leash.js';

const BODY_LIMIT = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || `HTTP_${status}`;
  }
}

// Safety M4: every mutating /api route (anything but GET / HEAD / OPTIONS) needs the
// per-boot token the page fetched from /api/state in `x-maka-token`, an `Origin` that
// matches the `Host` when a browser sends one, and `application/json`. A cross-origin
// page cannot read /api/state (no CORS headers), so it never holds the token; a
// "simple" cross-origin POST (text/plain, no preflight) is refused on its content type
// and its missing token both. The Resend webhook is the one exception: it comes from
// outside and is guarded by its svix signature.
export const TOKEN_HEADER = 'x-maka-token';
export const TOKEN_EXEMPT_PATHS = Object.freeze(['/api/mail/resend/webhook']);
// Mutating routes whose body is not JSON (phase 4 step 14: audio). The token and the Origin
// are still checked; only the content-type rule is waived for them.
export const RAW_BODY_PATHS = Object.freeze(['/api/voice/transcribe']);
const RAW_BODY_LIMIT = 10 * 1024 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function makeToken() {
  return randomBytes(24).toString('base64url');
}

function sameToken(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Throws the HttpError that refuses a mutating request without its proofs.
export function checkMutation(req, token, { raw = false } = {}) {
  const headers = req.headers || {};
  const given = headers[TOKEN_HEADER];
  if (given === undefined || given === '') throw new HttpError(403, `this request changes the park and needs the ${TOKEN_HEADER} header with the token from GET /api/state`, 'TOKEN_REQUIRED');
  if (!sameToken(Array.isArray(given) ? given[0] : given, token)) throw new HttpError(403, `the ${TOKEN_HEADER} header does not match this sidecar's token (it changes on every start; read it again from GET /api/state)`, 'TOKEN_INVALID');
  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost = null;
    try {
      originHost = new URL(String(origin)).host.toLowerCase();
    } catch {
      originHost = null;
    }
    const host = String(headers.host || '').toLowerCase();
    if (!originHost || !host || originHost !== host) throw new HttpError(403, `the request's Origin (${origin}) is not this sidecar (${host || 'unknown host'})`, 'ORIGIN_MISMATCH');
  }
  if (raw) return;
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, `mutating requests take application/json, got ${type || 'no content type'}`, 'JSON_REQUIRED');
}

// The raw bytes of a request body (audio), under a limit of its own.
function readRawBody(req, limit = RAW_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `body too large (at most ${limit} bytes)`, 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// The fields POST /api/run accepts (safety M3); everything else in the body is dropped.
export const RUN_BODY_FIELDS = Object.freeze(['agentId', 'prompt', 'provider', 'model', 'maxTurns', 'budgetUsd']);

export function pickFields(body, fields) {
  const out = {};
  for (const k of fields) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw new HttpError(400, `invalid JSON body: ${err.message}`);
  }
}

// Runs fn and turns a thrown error that carries `status` into an HttpError.
async function rethrow(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status) throw new HttpError(err.status, err.message, err.code);
    throw err;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

export function createLayoutState({ initial, store, bus, clock = { now: () => Date.now() }, objectCheck = null }) {
  let layout = initial;
  let checkObject = objectCheck; // phase 4 step 4: the MCP manager refuses an Outpost without a known server
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  return {
    get: () => layout,
    async replace(next) {
      const r = validate(LAYOUT_SCHEMA, next);
      if (!r.ok) throw new HttpError(400, `layout invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      const atPeak = peakConnectorProblem(next);
      if (atPeak) throw new HttpError(400, `layout invalid: ${OBJECT_KINDS[atPeak.kind].label} "${atPeak.id}" stands at the Mountain Peak; connector fixtures do not belong there (the Chief is unjudged, safety L5)`, 'PEAK_NO_CONNECTOR');
      layout = next;
      await store.saveLayout(layout);
      return layout;
    },
    setObjectCheck(fn) {
      checkObject = typeof fn === 'function' ? fn : null;
    },
    async place({ kind, roomId, x, y, objectId, server }) {
      if (!OBJECT_KINDS[kind]) throw new HttpError(400, `unknown object kind "${kind}"`);
      const room = roomOf(layout, roomId);
      if (!room) throw new HttpError(400, `unknown room "${roomId}"`);
      if (!Number.isInteger(x) || !Number.isInteger(y) || !tileInRoom(room, x, y)) throw new HttpError(400, 'tile is outside the room');
      // Safety L5: no connector fixture at the Peak.
      if (room.kind === 'mountain_peak' && PEAK_REFUSED_KINDS.includes(kind)) throw new HttpError(400, `a ${OBJECT_KINDS[kind].label} cannot stand at the Mountain Peak: the Chief is unjudged, so connector fixtures belong in the camps`, 'PEAK_NO_CONNECTOR');
      const occupied = layout.objects.some((o) => o.x === x && o.y === y) || layout.agents.some((a) => a.x === x && a.y === y);
      if (occupied) throw new HttpError(409, 'tile is occupied');
      const id = objectId || `obj-${randomUUID().slice(0, 8)}`;
      if (layout.objects.some((o) => o.id === id)) throw new HttpError(409, `object "${id}" already exists`);
      const obj = { id, kind, roomId, x, y };
      if (server !== undefined && server !== null) {
        if (typeof server !== 'string' || !server) throw new HttpError(400, 'server must be a non-empty string');
        obj.server = server;
      }
      if (checkObject) {
        try {
          checkObject(obj);
        } catch (err) {
          throw new HttpError(err.status || 400, err.message, err.code);
        }
      }
      // makeEvent validates the payload; a bad id or coordinate throws before any change.
      const event = makeEvent('object.place', { objectId: id, kind, roomId, x, y, ...(obj.server ? { server: obj.server } : {}) }, { ts: clock.now() });
      layout = { ...layout, objects: [...layout.objects, obj] };
      await store.saveLayout(layout);
      bus.emit(event);
      return layout.objects.at(-1);
    },
    async reroll({ seed } = {}) {
      const next = Number.isInteger(seed) && seed >= 1 ? seed : (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
      const event = makeEvent('layout.seed', { seed: next }, { ts: clock.now() });
      layout = { ...layout, seed: next };
      await store.saveLayout(layout);
      bus.emit(event);
      return { seed: next };
    },
    async reclaim({ objectId }) {
      const obj = layout.objects.find((o) => o.id === objectId);
      if (!obj) throw new HttpError(404, `no object "${objectId}"`);
      const event = makeEvent('object.reclaim', { objectId, roomId: obj.roomId }, { ts: clock.now() });
      layout = { ...layout, objects: layout.objects.filter((o) => o.id !== objectId) };
      await store.saveLayout(layout);
      bus.emit(event);
      return obj;
    },
    emit,
  };
}

export function createApp({ bus, store, runs, layoutState, leashState = null, ledger = null, gateQueue = null, agents = null, trails = null, chief = null, reflect = null, away = null, mailSetup = null, mail = null, browser = null, connectors = null, channels = null, mcp = null, research = null, creative = null, results = null, purchases = null, computer = null, importer = null, scoutMemory = null, memory = null, recipes = null, voice = null, workspace = null, setup = null, ollama = null, backup = null, restart = null, providerStatus, keystoreStatus, staticRoot, sharedRoot, home, workspaceRoot, token = makeToken() }) {
  const staticReal = path.resolve(staticRoot);
  const sharedReal = path.resolve(sharedRoot);
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('createApp needs a token of at least 32 characters');

  async function serveStatic(root, rel, res) {
    const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(404, 'not found');
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const file = stat.isDirectory() ? path.join(target, 'index.html') : target;
    let data;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-cache' });
    res.end(data);
  }

  async function mailStatus() {
    if (!mailSetup && !mail) return null;
    const setup = mailSetup ? await mailSetup.status() : {};
    const system = mail ? await mail.status() : {};
    return { ...setup, ...system, keys: { ...(setup.keys || {}), ...(system.keys || {}) } };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;
    // Safety M4: nothing under /api changes without the token, a same-origin Origin and JSON.
    if (p.startsWith('/api/') && !SAFE_METHODS.has(method) && !TOKEN_EXEMPT_PATHS.includes(p)) checkMutation(req, token, { raw: RAW_BODY_PATHS.includes(p) });

    if (p === '/api/events' && method === 'GET') {
      const last = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0) || 0;
      bus.attach(req, res, { lastEventId: last });
      return;
    }
    if (p === '/api/state' && method === 'GET') {
      const [providers, keystore, spend, recent] = await Promise.all([providerStatus(), keystoreStatus(), store.loadSpend(), store.listRuns()]);
      return sendJson(res, 200, {
        contractVersion: CONTRACT_VERSION,
        seq: bus.seq,
        token, // safety M4: sent back in x-maka-token on every mutating request
        home,
        workspaceRoot,
        workspace: workspace ? workspace.state() : { root: workspaceRoot, online: true, known: false, since: 0, reason: null },
        providers,
        keystore: { path: keystore.path, problem: keystore.problem, broker: Boolean(keystore.broker) },
        layout: layoutState.get(),
        objectKinds: OBJECT_KINDS,
        activeRun: runs.active()[0] || null,
        activeRuns: runs.active(),
        queuedRuns: runs.queued(),
        maxConcurrent: runs.maxConcurrent,
        pendingPrompts: runs.pending(),
        policy: runs.policy,
        judge: runs.judge ? runs.judge() : null,
        leash: leashState ? leashState.get() : null,
        ledger: ledger ? ledger.summary() : null,
        gate: gateQueue ? { pending: gateQueue.pending(), recent: gateQueue.recent(20) } : null,
        agents: agents ? agents.list() : null,
        work: trails ? { inTransit: trails.inTransit(), recent: trails.list().slice(0, 20) } : null,
        mission: chief ? chief.state() : null,
        reflection: reflect ? reflect.state() : null,
        away: away ? away.state() : null,
        mail: await mailStatus(),
        browser: browser ? await browser.status() : null,
        connectors: connectors ? connectors.list() : null,
        channels: channels ? { adapters: channels.list(), pairing: channels.pairing() } : null,
        mcp: mcp ? mcp.list() : null,
        research: research ? await research.status() : null,
        creative: creative ? await creative.status() : null,
        results: results ? results.summary() : null,
        purchases: purchases ? purchases.summary() : null,
        computer: computer ? await computer.status() : null,
        scoutMemory: scoutMemory ? scoutMemory.summary() : null,
        memory: memory ? memory.summary() : null,
        recipes: recipes ? recipes.summary() : null,
        voice: voice ? await voice.status() : null,
        setup: setup ? await setup.state() : null,
        ollama: ollama ? ollama.summary() : null,
        backup: backup ? await backup.status() : null,
        spend,
        runs: recent.slice(0, 20),
      });
    }
    if (p === '/api/run' && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        // Safety M3: only the documented fields reach the run manager. `review`, `step`,
        // `system` and `workItemId` are internal (the Chief's planning runs, the trails)
        // and a request could otherwise switch the judge off for any Ranger.
        const { runId, agentId, provider, model, tier, queued } = await runs.start(pickFields(body, RUN_BODY_FIELDS));
        return sendJson(res, 202, { runId, agentId, provider, model, tier, queued });
      } catch (err) {
        if (err.code === 'WORKSPACE_OFFLINE') throw new HttpError(503, err.message, err.code);
        if (['NO_KEY', 'NO_MODEL', 'OLLAMA_UNREACHABLE', 'UNKNOWN_PROVIDER', 'BAD_REQUEST', 'AGENT_PAUSED', 'HOSTED_CAP'].includes(err.code)) throw new HttpError(400, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/cancel' && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { cancelled: runs.cancel(body.runId) });
    }
    if (p === '/api/layout' && method === 'GET') return sendJson(res, 200, layoutState.get());
    if (p === '/api/layout' && method === 'PUT') return sendJson(res, 200, await layoutState.replace(await readJsonBody(req)));
    if (p === '/api/layout/place' && method === 'POST') return sendJson(res, 201, await layoutState.place(await readJsonBody(req)));
    if (p === '/api/layout/reclaim' && method === 'POST') return sendJson(res, 200, await layoutState.reclaim(await readJsonBody(req)));
    if (p === '/api/layout/reroll' && method === 'POST') return sendJson(res, 200, await layoutState.reroll(await readJsonBody(req)));
    if (p === '/api/permission' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = validate(PAYLOAD_SCHEMAS['permission.response'], body);
      if (!r.ok) throw new HttpError(400, `permission.response invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      const accepted = runs.answer(body);
      return sendJson(res, accepted ? 200 : 404, { accepted });
    }
    if (p === '/api/gate' && method === 'GET') {
      if (!gateQueue) throw new HttpError(404, 'no Gate queue');
      return sendJson(res, 200, { pending: gateQueue.pending(), recent: gateQueue.recent(Number(url.searchParams.get('limit')) || 50), ledger: ledger ? ledger.summary() : null });
    }
    if (p.startsWith('/api/gate/') && method === 'POST') {
      if (!gateQueue) throw new HttpError(404, 'no Gate queue');
      const id = decodeURIComponent(p.slice('/api/gate/'.length));
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, await gateQueue.resolve(id, body));
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/work' && method === 'GET') {
      if (!trails) throw new HttpError(404, 'no trails');
      return sendJson(res, 200, trails.list());
    }
    if (p === '/api/work' && method === 'POST') {
      if (!trails) throw new HttpError(404, 'no trails');
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 202, await trails.delegate(body, { by: 'superintendent' }));
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        if (['NO_KEY', 'NO_MODEL', 'OLLAMA_UNREACHABLE', 'UNKNOWN_PROVIDER', 'BAD_REQUEST'].includes(err.code)) throw new HttpError(400, err.message, err.code);
        if (err.code === 'WORKSPACE_OFFLINE') throw new HttpError(503, err.message, err.code);
        throw err;
      }
    }
    if (p.startsWith('/api/work/')) {
      if (!trails) throw new HttpError(404, 'no trails');
      const rest = p.slice('/api/work/'.length);
      if (method === 'POST' && rest.endsWith('/cancel')) return sendJson(res, 200, await rethrow(() => trails.cancel(decodeURIComponent(rest.slice(0, -'/cancel'.length)))));
      if (method === 'GET') {
        const item = trails.get(decodeURIComponent(rest));
        if (!item) throw new HttpError(404, 'no such work item');
        return sendJson(res, 200, item);
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (p === '/api/mission' && method === 'GET') {
      if (!chief) throw new HttpError(404, 'no Chief Ranger');
      return sendJson(res, 200, chief.state());
    }
    if (p === '/api/mission' && method === 'POST') {
      if (!chief) throw new HttpError(404, 'no Chief Ranger');
      const body = await readJsonBody(req);
      try {
        const started = await chief.mission(body);
        if (setup) await setup.noteMission();
        return sendJson(res, 202, started);
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        if (['NO_KEY', 'NO_MODEL', 'OLLAMA_UNREACHABLE', 'UNKNOWN_PROVIDER', 'BAD_REQUEST'].includes(err.code)) throw new HttpError(400, err.message, err.code);
        if (err.code === 'WORKSPACE_OFFLINE') throw new HttpError(503, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/mail/resend/webhook' && method === 'POST') {
      if (!mail) throw new HttpError(404, 'no mail system');
      const rawBody = await readBody(req);
      try {
        return sendJson(res, 200, await mail.handleWebhook({ headers: req.headers, rawBody }));
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/mail' && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      return sendJson(res, 200, await mail.status());
    }
    if (p === '/api/mail/sync' && method === 'POST') {
      if (!mail) throw new HttpError(404, 'no mail system');
      try {
        return sendJson(res, 200, await mail.poll());
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        if (['NETWORK', 'BAD_RESPONSE'].includes(err.code) || /^HTTP_/.test(err.code || '')) throw new HttpError(502, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/mail/send' && method === 'POST') {
      if (!mail) throw new HttpError(404, 'no mail system');
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 201, await mail.send(body, { by: 'superintendent' }));
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        if (['NETWORK', 'BAD_RESPONSE', 'NO_KEY'].includes(err.code) || /^HTTP_/.test(err.code || '')) throw new HttpError(err.code === 'NO_KEY' ? 400 : 502, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/mail/addresses' && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      return sendJson(res, 200, mail.addresses.list());
    }
    if (p === '/api/mail/addresses' && method === 'POST') {
      if (!mail) throw new HttpError(404, 'no mail system');
      return sendJson(res, 201, await rethrow(async () => mail.addresses.createAlias(await readJsonBody(req), { by: 'superintendent' })));
    }
    if (p.startsWith('/api/mail/addresses/') && method === 'DELETE') {
      if (!mail) throw new HttpError(404, 'no mail system');
      return sendJson(res, 200, await rethrow(() => mail.addresses.remove(decodeURIComponent(p.slice('/api/mail/addresses/'.length)), { by: 'superintendent' })));
    }
    if (p === '/api/mail/messages' && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      const q = url.searchParams;
      return sendJson(res, 200, mail.mailStore.list({ station: q.get('station') || undefined, venture: q.get('venture') || undefined, threadId: q.get('threadId') || undefined, direction: q.get('direction') || undefined, label: q.get('label') || undefined, agentId: q.get('agentId') || undefined, limit: Number(q.get('limit')) || 50 }));
    }
    if (p.startsWith('/api/mail/messages/') && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      const m = await mail.mailStore.get(decodeURIComponent(p.slice('/api/mail/messages/'.length)));
      if (!m) throw new HttpError(404, 'no such message');
      return sendJson(res, 200, m);
    }
    if (p === '/api/mail/threads' && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      const q = url.searchParams;
      if (q.get('threadId')) return sendJson(res, 200, await mail.mailStore.thread(q.get('threadId')));
      return sendJson(res, 200, mail.mailStore.threads({ station: q.get('station') || undefined, venture: q.get('venture') || undefined, limit: Number(q.get('limit')) || 50 }));
    }
    if (p === '/api/mail/search' && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      return sendJson(res, 200, mail.mailStore.search(url.searchParams.get('q') || ''));
    }
    if (p === '/api/mail/suppressions' && method === 'GET') {
      if (!mail) throw new HttpError(404, 'no mail system');
      return sendJson(res, 200, mail.mailStore.suppressions());
    }
    if (p === '/api/mail/dns' && method === 'GET') {
      if (!mailSetup) throw new HttpError(404, 'no mail setup');
      return sendJson(res, 200, await mailSetup.status());
    }
    if ((p === '/api/mail/dns/plan' || p === '/api/mail/dns/apply') && method === 'POST') {
      if (!mailSetup) throw new HttpError(404, 'no mail setup');
      try {
        if (p.endsWith('/plan')) return sendJson(res, 200, await mailSetup.plan());
        return sendJson(res, 202, await mailSetup.apply());
      } catch (err) {
        if (err.status) throw new HttpError(err.status, err.message, err.code);
        if (['NO_KEY', 'NO_ZONE', 'NETWORK', 'BAD_RESPONSE', 'CLOUDFLARE'].includes(err.code) || /^HTTP_/.test(err.code || '')) throw new HttpError(502, err.message, err.code);
        throw err;
      }
    }
    if (p === '/api/setup' && method === 'GET') {
      if (!setup) throw new HttpError(404, 'no first-run flow');
      return sendJson(res, 200, await setup.state());
    }
    if (p === '/api/setup/workspace' && method === 'POST') {
      if (!setup) throw new HttpError(404, 'no first-run flow');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => setup.setWorkspace(body.root)));
    }
    if (p === '/api/setup/key' && method === 'POST') {
      if (!setup) throw new HttpError(404, 'no first-run flow');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => setup.setKey(body.provider, body.key)));
    }
    if (p === '/api/setup/complete' && method === 'POST') {
      if (!setup) throw new HttpError(404, 'no first-run flow');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await setup.complete({ skipped: Boolean(body.skipped) }));
    }
    if (p === '/api/setup/reset' && method === 'POST') {
      if (!setup) throw new HttpError(404, 'no first-run flow');
      return sendJson(res, 200, await setup.reset());
    }
    if (p === '/api/ollama' && method === 'GET') {
      if (!ollama) throw new HttpError(404, 'no Ollama manager');
      return sendJson(res, 200, await ollama.status());
    }
    if (p === '/api/ollama/pull' && method === 'POST') {
      if (!ollama) throw new HttpError(404, 'no Ollama manager');
      const body = await readJsonBody(req);
      if (typeof body.model !== 'string' || !body.model.trim()) throw new HttpError(400, 'model is required', 'BAD_REQUEST');
      if (ollama.summary().pulling) throw new HttpError(409, `already pulling ${ollama.summary().pulling.model}`, 'PULL_ACTIVE');
      // The pull runs on; its progress and its end (success or error) are ollama.pull events.
      const running = ollama.pull(body.model.trim());
      running.catch((err) => console.error('ollama pull failed:', err.message));
      await new Promise((r) => setImmediate(r));
      return sendJson(res, 202, { model: body.model.trim(), started: true });
    }
    if (p === '/api/ollama/start' && method === 'POST') {
      if (!ollama) throw new HttpError(404, 'no Ollama manager');
      return sendJson(res, 200, await rethrow(() => ollama.start()));
    }
    if (p.startsWith('/api/ollama/models/') && method === 'DELETE') {
      if (!ollama) throw new HttpError(404, 'no Ollama manager');
      return sendJson(res, 200, await rethrow(() => ollama.remove(decodeURIComponent(p.slice('/api/ollama/models/'.length)))));
    }
    if (p === '/api/backup' && method === 'GET') {
      if (!backup) throw new HttpError(404, 'no backup module');
      return sendJson(res, 200, await backup.status());
    }
    if (p === '/api/backup/config' && method === 'POST') {
      if (!backup) throw new HttpError(404, 'no backup module');
      return sendJson(res, 200, await rethrow(async () => backup.configure(await readJsonBody(req))));
    }
    if (p === '/api/backup/now' && method === 'POST') {
      if (!backup) throw new HttpError(404, 'no backup module');
      return sendJson(res, 200, await rethrow(() => backup.snapshot({ reason: 'manual' })));
    }
    if (p === '/api/backup/list' && method === 'GET') {
      if (!backup) throw new HttpError(404, 'no backup module');
      return sendJson(res, 200, await rethrow(() => backup.list()));
    }
    if (p === '/api/backup/verify' && method === 'POST') {
      if (!backup) throw new HttpError(404, 'no backup module');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => backup.verify({ key: typeof body.key === 'string' && body.key ? body.key : null })));
    }
    if (p === '/api/backup/restore' && method === 'POST') {
      if (!backup) throw new HttpError(404, 'no backup module');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => backup.restore({ key: typeof body.key === 'string' && body.key ? body.key : null, into: typeof body.into === 'string' && body.into ? body.into : null })));
    }
    if (p === '/api/restart' && method === 'POST') {
      if (typeof restart !== 'function') throw new HttpError(404, 'this sidecar cannot restart itself (run it through sidecar/index.js)');
      restart();
      return sendJson(res, 202, { restarting: true });
    }
    if (p === '/api/research' && method === 'GET') {
      if (!research) throw new HttpError(404, 'no research kit');
      return sendJson(res, 200, await research.status());
    }
    if (p === '/api/briefs' && method === 'GET') {
      if (!research) throw new HttpError(404, 'no research kit');
      return sendJson(res, 200, await research.listBriefs({ limit: Number(url.searchParams.get('limit')) || 50 }));
    }
    if (p === '/api/voice' && method === 'GET') {
      if (!voice) throw new HttpError(404, 'no voice');
      return sendJson(res, 200, await voice.status());
    }
    if (p === '/api/voice/transcribe' && method === 'POST') {
      if (!voice) throw new HttpError(404, 'no voice');
      const bytes = await readRawBody(req);
      return sendJson(res, 200, await rethrow(() => voice.transcribe({ bytes, contentType: req.headers['content-type'] || '' })));
    }
    if (p === '/api/voice/heard' && method === 'POST') {
      if (!voice) throw new HttpError(404, 'no voice');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => voice.heard({ via: body.via, text: body.text, accepted: body.accepted, use: body.use || null })));
    }
    if (p === '/api/peak/ask' && method === 'POST') {
      if (!chief || typeof chief.ask !== 'function') throw new HttpError(404, 'no Chief');
      const body = await readJsonBody(req);
      const context = reflect && typeof reflect.gather === 'function' ? await reflect.gather() : null;
      const r = await rethrow(() => chief.ask({ question: body.question, context, by: 'superintendent' }));
      const answered = await r.answer;
      return sendJson(res, 200, { runId: r.runId, answer: answered && typeof answered === 'object' ? answered.text || answered.answer || '' : String(answered || ''), evidence: answered && typeof answered === 'object' ? answered.evidence || answered.refs || null : null });
    }
    if (p === '/api/recipes' && method === 'GET') {
      if (!recipes) throw new HttpError(404, 'no recipes');
      return sendJson(res, 200, recipes.list());
    }
    if (p === '/api/recipes' && method === 'POST') {
      if (!recipes) throw new HttpError(404, 'no recipes');
      return sendJson(res, 201, await rethrow(async () => recipes.save(await readJsonBody(req), { by: 'superintendent' })));
    }
    if (p === '/api/recipe-runs' && method === 'GET') {
      if (!recipes) throw new HttpError(404, 'no recipes');
      return sendJson(res, 200, recipes.runs({ limit: Number(url.searchParams.get('limit')) || 50 }));
    }
    if (p.startsWith('/api/recipe-runs/') && method === 'GET') {
      if (!recipes) throw new HttpError(404, 'no recipes');
      const run = recipes.getRun(decodeURIComponent(p.slice('/api/recipe-runs/'.length)));
      if (!run) throw new HttpError(404, 'no such recipe run');
      return sendJson(res, 200, run);
    }
    if (p === '/api/skills' && method === 'GET') {
      if (!recipes) throw new HttpError(404, 'no recipes');
      return sendJson(res, 200, recipes.skills());
    }
    if (p === '/api/skills' && method === 'POST') {
      if (!recipes) throw new HttpError(404, 'no recipes');
      return sendJson(res, 201, await rethrow(async () => recipes.saveSkill(await readJsonBody(req), { by: 'superintendent' })));
    }
    if (p.startsWith('/api/recipes/')) {
      if (!recipes) throw new HttpError(404, 'no recipes');
      const parts = p.slice('/api/recipes/'.length).split('/');
      const id = decodeURIComponent(parts[0]);
      const action = parts[1] || null;
      if (!action && method === 'GET') {
        const doc = recipes.get(id, Number(url.searchParams.get('version')) || null);
        if (!doc) throw new HttpError(404, 'no such recipe');
        return sendJson(res, 200, doc);
      }
      if (method === 'POST' && ['plan', 'run', 'grant', 'revoke'].includes(action)) {
        const body = await readJsonBody(req);
        if (action === 'plan') return sendJson(res, 200, await rethrow(() => recipes.plan(id, { ventureId: body.ventureId || null, params: body.params || {} })));
        if (action === 'run') return sendJson(res, 202, await rethrow(() => recipes.run({ recipeId: id, ventureId: body.ventureId || null, params: body.params || {}, by: 'superintendent' })));
        if (action === 'grant') return sendJson(res, 200, await rethrow(() => recipes.grant({ recipeId: id, role: body.role || null, agentId: body.agentId || null, by: 'superintendent' })));
        return sendJson(res, 200, await rethrow(() => recipes.revoke({ recipeId: id, role: body.role || null, agentId: body.agentId || null })));
      }
    }
    if (p === '/api/memory' && method === 'GET') {
      if (!memory) throw new HttpError(404, 'no memory');
      return sendJson(res, 200, memory.list({ agentId: url.searchParams.get('agentId') || null }));
    }
    if (/^\/api\/memory\/[^/]+\/feedback$/.test(p) && method === 'POST') {
      if (!memory) throw new HttpError(404, 'no memory');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => memory.feedback(decodeURIComponent(p.split('/')[3]), { vote: body.vote, by: 'superintendent' })));
    }
    if (/^\/api\/memory\/[^/]+$/.test(p) && method === 'DELETE') {
      if (!memory) throw new HttpError(404, 'no memory');
      return sendJson(res, 200, await rethrow(() => memory.forget(decodeURIComponent(p.split('/')[3]), { by: 'superintendent' })));
    }
    if (p === '/api/scout-memory' && method === 'GET') {
      if (!scoutMemory) throw new HttpError(404, 'no scout memory');
      const niche = url.searchParams.get('niche') || null;
      const channel = url.searchParams.get('channel') || null;
      return sendJson(res, 200, { ...scoutMemory.history({ niche, channel }), promptLines: scoutMemory.promptLines({ niche, channel }) });
    }
    if (p === '/api/results' && method === 'GET') {
      if (!results) throw new HttpError(404, 'no results engine');
      return sendJson(res, 200, results.summary());
    }
    // Phase 4 step 17: supplier purchases. The Superintendent's own request needs no Gate (it
    // is the approval) but holds the amount like any other; cancel releases the hold.
    if (p === '/api/purchases' && method === 'GET') {
      if (!purchases) throw new HttpError(404, 'no purchases');
      return sendJson(res, 200, { ...purchases.summary(), purchases: purchases.list() });
    }
    if (p === '/api/purchases' && method === 'POST') {
      if (!purchases) throw new HttpError(404, 'no purchases');
      const body = await readJsonBody(req);
      return sendJson(res, 202, await rethrow(() => purchases.request(body, { by: 'superintendent' })));
    }
    if (p === '/api/purchases/reconcile' && method === 'POST') {
      if (!purchases) throw new HttpError(404, 'no purchases');
      await readJsonBody(req);
      return sendJson(res, 200, await purchases.reconcile());
    }
    if (p.startsWith('/api/purchases/') && p.endsWith('/cancel') && method === 'POST') {
      if (!purchases) throw new HttpError(404, 'no purchases');
      const body = await readJsonBody(req);
      const id = decodeURIComponent(p.slice('/api/purchases/'.length, -'/cancel'.length));
      return sendJson(res, 200, await rethrow(() => purchases.cancel(id, { by: 'superintendent', reason: body && body.reason ? String(body.reason).slice(0, 200) : undefined })));
    }
    if (p === '/api/results/rollup' && method === 'POST') {
      if (!results) throw new HttpError(404, 'no results engine');
      await readJsonBody(req);
      await results.rollup({ reason: 'manual' });
      return sendJson(res, 200, results.summary());
    }
    if (p === '/api/creative' && method === 'GET') {
      if (!creative) throw new HttpError(404, 'no creative kit');
      return sendJson(res, 200, await creative.status());
    }
    if (p === '/api/creatives' && method === 'GET') {
      if (!creative) throw new HttpError(404, 'no creative kit');
      return sendJson(res, 200, await creative.list({ limit: Number(url.searchParams.get('limit')) || 50, kind: url.searchParams.get('kind') || null }));
    }
    if (p === '/api/connectors' && method === 'GET') {
      if (!connectors) throw new HttpError(404, 'no connectors');
      return sendJson(res, 200, connectors.list());
    }
    if (p.startsWith('/api/connectors/')) {
      if (!connectors) throw new HttpError(404, 'no connectors');
      const [kind, action] = p.slice('/api/connectors/'.length).split('/').map(decodeURIComponent);
      if (!action && method === 'GET') {
        const status = connectors.status(kind);
        if (!status) throw new HttpError(404, `no connector "${kind}"`);
        return sendJson(res, 200, { ...status, data: connectors.data(kind) });
      }
      if (method === 'POST' && ['connect', 'disconnect', 'sync'].includes(action)) {
        const body = await readJsonBody(req);
        try {
          if (action === 'connect') return sendJson(res, 202, await connectors.connect(kind, body));
          if (action === 'disconnect') return sendJson(res, 202, await connectors.disconnect(kind));
          return sendJson(res, 200, await connectors.sync(kind, 'manual'));
        } catch (err) {
          if (err.status) throw new HttpError(err.status, err.message, err.code);
          if (['NETWORK', 'BAD_RESPONSE'].includes(err.code) || /^HTTP_/.test(err.code || '')) throw new HttpError(502, err.message, err.code);
          throw err;
        }
      }
    }
    if (p === '/api/mcp' && method === 'GET') {
      if (!mcp) throw new HttpError(404, 'no MCP manager');
      return sendJson(res, 200, mcp.list());
    }
    if (p === '/api/mcp/catalog' && method === 'GET') {
      if (!mcp) throw new HttpError(404, 'no MCP manager');
      return sendJson(res, 200, mcp.catalog());
    }
    if (p.startsWith('/api/mcp/catalog/') && method === 'POST') {
      if (!mcp) throw new HttpError(404, 'no MCP manager');
      const entryId = decodeURIComponent(p.slice('/api/mcp/catalog/'.length));
      return sendJson(res, 202, await rethrow(async () => mcp.addFromCatalog(entryId, await readJsonBody(req))));
    }
    if (p === '/api/mcp/servers' && method === 'POST') {
      if (!mcp) throw new HttpError(404, 'no MCP manager');
      return sendJson(res, 202, await rethrow(async () => mcp.add(await readJsonBody(req))));
    }
    if (p.startsWith('/api/mcp/servers/')) {
      if (!mcp) throw new HttpError(404, 'no MCP manager');
      const [id, action] = p.slice('/api/mcp/servers/'.length).split('/').map(decodeURIComponent);
      if (method === 'GET' && !action) {
        const row = mcp.status(id);
        if (!row) throw new HttpError(404, `no MCP server "${id}"`);
        return sendJson(res, 200, row);
      }
      if (method === 'PUT' && action === 'leash') return sendJson(res, 200, await rethrow(async () => mcp.setLeash(id, await readJsonBody(req))));
      if (method === 'POST' && ['remove', 'connect', 'disconnect', 'auth'].includes(action)) {
        await readJsonBody(req);
        try {
          if (action === 'remove') return sendJson(res, 202, await mcp.remove(id));
          if (action === 'auth') return sendJson(res, 202, await mcp.auth(id));
          if (action === 'connect') return sendJson(res, 200, (await mcp.connect(id), mcp.status(id)));
          return sendJson(res, 200, (await mcp.disconnect(id), mcp.status(id)));
        } catch (err) {
          if (err.status) throw new HttpError(err.status, err.message, err.code);
          throw err;
        }
      }
      throw new HttpError(404, 'no such route');
    }
    if (p === '/api/channels' && method === 'GET') {
      if (!channels) throw new HttpError(404, 'no channels');
      return sendJson(res, 200, { adapters: channels.list(), pairing: channels.pairing() });
    }
    if (p === '/api/channels/pair' && method === 'POST') {
      if (!channels) throw new HttpError(404, 'no channels');
      return sendJson(res, 201, await channels.newPairingCode());
    }
    if (p.startsWith('/api/channels/') && method === 'POST') {
      if (!channels) throw new HttpError(404, 'no channels');
      const [name, action] = p.slice('/api/channels/'.length).split('/').map(decodeURIComponent);
      const body = await readJsonBody(req);
      if (action === 'unpair') return sendJson(res, 200, await rethrow(() => channels.unpair(name, typeof body.chatId === 'string' || typeof body.chatId === 'number' ? String(body.chatId) : '')));
      if (action === 'connect') return sendJson(res, 202, await rethrow(() => channels.connect(name, body)));
      if (action === 'disconnect') return sendJson(res, 202, await rethrow(() => channels.disconnect(name)));
      throw new HttpError(404, 'no such route');
    }
    // Phase 4 step 18: computer control. Status, the handoffs a sensitive app raised, the
    // Superintendent's hand-back, the halt (the hotkey posts it too) and the resume.
    // Phase 4 step 19: import a Ranger from an OpenClaw or Hermes home (keys never move).
    if (p === '/api/import/candidates' && method === 'GET') {
      if (!importer) throw new HttpError(404, 'no importer');
      return sendJson(res, 200, await importer.candidates());
    }
    if (p === '/api/import/preview' && method === 'POST') {
      if (!importer) throw new HttpError(404, 'no importer');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => importer.preview(body)));
    }
    if (p === '/api/import' && method === 'POST') {
      if (!importer) throw new HttpError(404, 'no importer');
      const body = await readJsonBody(req);
      return sendJson(res, 201, await rethrow(() => importer.run(body)));
    }
    if (p === '/api/computer' && method === 'GET') {
      if (!computer) throw new HttpError(404, 'no computer control');
      return sendJson(res, 200, { ...(await computer.status()), handoffs: computer.handoffs({ pendingOnly: true }) });
    }
    if (p === '/api/computer/handoffs' && method === 'GET') {
      if (!computer) throw new HttpError(404, 'no computer control');
      return sendJson(res, 200, computer.handoffs());
    }
    if (p.startsWith('/api/computer/handoff/') && p.endsWith('/return') && method === 'POST') {
      if (!computer) throw new HttpError(404, 'no computer control');
      const body = await readJsonBody(req);
      const id = decodeURIComponent(p.slice('/api/computer/handoff/'.length, -'/return'.length));
      return sendJson(res, 200, await rethrow(() => computer.returnHandoff(id, { notes: typeof body.notes === 'string' ? body.notes : '' })));
    }
    if (p === '/api/computer/halt' && method === 'POST') {
      if (!computer) throw new HttpError(404, 'no computer control');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await computer.halt({ by: body.by === 'hotkey' ? 'the hotkey' : 'superintendent' }));
    }
    if (p === '/api/computer/resume' && method === 'POST') {
      if (!computer) throw new HttpError(404, 'no computer control');
      await readJsonBody(req);
      return sendJson(res, 200, await computer.resume({ by: 'superintendent' }));
    }
    if (p.startsWith('/api/computer/trace/') && method === 'GET') {
      if (!computer) throw new HttpError(404, 'no computer control');
      return sendJson(res, 200, await computer.trace(decodeURIComponent(p.slice('/api/computer/trace/'.length)), { limit: Number(url.searchParams.get('limit')) || 50 }));
    }
    if (p === '/api/browser' && method === 'GET') {
      if (!browser) throw new HttpError(404, 'no browser control');
      return sendJson(res, 200, await browser.status());
    }
    if (p === '/api/browser/handoffs' && method === 'GET') {
      if (!browser) throw new HttpError(404, 'no browser control');
      return sendJson(res, 200, browser.handoffs());
    }
    if (p.startsWith('/api/browser/handoff/') && p.endsWith('/return') && method === 'POST') {
      if (!browser) throw new HttpError(404, 'no browser control');
      const id = decodeURIComponent(p.slice('/api/browser/handoff/'.length, -'/return'.length));
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, browser.returnHandoff(id, { notes: typeof body.notes === 'string' ? body.notes.trim() : '' }));
      } catch (err) {
        if (err.code === 'NOT_FOUND') throw new HttpError(404, err.message, err.code);
        if (err.code === 'NOT_WAITING') throw new HttpError(409, err.message, err.code);
        if (err.code === 'NOTES_REQUIRED') throw new HttpError(400, err.message, err.code);
        throw err;
      }
    }
    if (p.startsWith('/api/browser/trace/') && method === 'GET') {
      if (!browser) throw new HttpError(404, 'no browser control');
      const agentId = decodeURIComponent(p.slice('/api/browser/trace/'.length));
      return sendJson(res, 200, await browser.trace(agentId, { limit: Number(url.searchParams.get('limit')) || 50 }));
    }
    if (p === '/api/away' && method === 'GET') {
      if (!away) throw new HttpError(404, 'no away mode');
      return sendJson(res, 200, away.state());
    }
    if (p === '/api/away' && method === 'POST') {
      if (!away) throw new HttpError(404, 'no away mode');
      const body = await readJsonBody(req);
      return sendJson(res, 200, await rethrow(() => away.set(body.away)));
    }
    if (p === '/api/away/log' && method === 'GET') {
      if (!away) throw new HttpError(404, 'no away mode');
      return sendJson(res, 200, await away.readLog());
    }
    if (p === '/api/reflections' && method === 'GET') {
      if (!reflect) throw new HttpError(404, 'no reflection cycle');
      return sendJson(res, 200, await reflect.list());
    }
    if (p.startsWith('/api/reflections/') && method === 'GET') {
      if (!reflect) throw new HttpError(404, 'no reflection cycle');
      const doc = await reflect.get(decodeURIComponent(p.slice('/api/reflections/'.length)));
      if (!doc) throw new HttpError(404, 'no such reflection');
      return sendJson(res, 200, doc);
    }
    if (p === '/api/reflect' && method === 'POST') {
      if (!reflect) throw new HttpError(404, 'no reflection cycle');
      const body = await readJsonBody(req);
      const running = reflect.reflect({ reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'manual' });
      running.catch((err) => console.error('reflection failed:', err));
      return sendJson(res, 202, { started: true });
    }
    if (p === '/api/agents' && method === 'GET') {
      if (!agents) throw new HttpError(404, 'no agents registry');
      return sendJson(res, 200, agents.list());
    }
    if (p === '/api/agents' && method === 'POST') {
      if (!agents) throw new HttpError(404, 'no agents registry');
      return sendJson(res, 201, await rethrow(async () => agents.create(await readJsonBody(req), { by: 'superintendent' })));
    }
    if (p.startsWith('/api/agents/')) {
      if (!agents) throw new HttpError(404, 'no agents registry');
      const id = decodeURIComponent(p.slice('/api/agents/'.length));
      if (method === 'GET') {
        const a = agents.get(id);
        if (!a) throw new HttpError(404, `no agent "${id}"`);
        return sendJson(res, 200, a);
      }
      if (method === 'POST' && (id.endsWith('/pause') || id.endsWith('/resume'))) {
        const paused = id.endsWith('/pause');
        const agentId = id.slice(0, -(paused ? '/pause' : '/resume').length);
        const updated = await rethrow(() => agents.setPaused(agentId, paused, { by: 'superintendent' }));
        const cancelled = paused ? runs.cancelFor(agentId) : 0;
        return sendJson(res, 200, { ...updated, cancelledRuns: cancelled });
      }
      if (method === 'PATCH') return sendJson(res, 200, await rethrow(async () => agents.update(id, await readJsonBody(req), { by: 'superintendent' })));
      if (method === 'DELETE') return sendJson(res, 200, await rethrow(() => agents.remove(id, { by: 'superintendent' })));
      throw new HttpError(405, 'method not allowed');
    }
    if (p === '/api/leash' && method === 'GET') return sendJson(res, 200, leashState ? leashState.get() : null);
    if (p === '/api/leash' && method === 'PUT') {
      if (!leashState || typeof leashState.set !== 'function') throw new HttpError(404, 'leash is read-only here');
      const body = await readJsonBody(req);
      const r = validateLeash(body);
      if (!r.ok) throw new HttpError(400, `leash invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, 'LEASH_INVALID');
      return sendJson(res, 200, await leashState.set(body));
    }
    if (p === '/api/runs' && method === 'GET') return sendJson(res, 200, await store.listRuns());
    if (p.startsWith('/api/runs/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/runs/'.length));
      let rec = null;
      try {
        rec = await store.loadRun(id);
      } catch {
        rec = null;
      }
      if (!rec) throw new HttpError(404, 'no such run');
      return sendJson(res, 200, rec);
    }
    if (p.startsWith('/api/')) throw new HttpError(404, 'no such route');
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (p.startsWith('/shared/')) return serveStatic(sharedReal, p.slice('/shared/'.length), res);
    return serveStatic(staticReal, p === '/' ? 'index.html' : p.slice(1), res);
  }

  const handler = async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('request failed:', err);
      if (!res.headersSent) sendJson(res, status, { error: err.message, code: err.code || `HTTP_${status}` });
      else res.end();
    }
  };
  handler.token = token;
  return handler;
}

export function createHttpServer(app) {
  return http.createServer(app);
}
