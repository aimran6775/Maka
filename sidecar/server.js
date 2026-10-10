// HTTP + SSE server. Routes:
//   GET  /api/state            snapshot: providers (configured or not), layout, active and
//                              queued runs, spend, pending prompts, object kinds, recent runs,
//                              leash, ledger, gate, judge, agents, work items
//   GET  /api/events           SSE stream of every event (replays after Last-Event-ID)
//   POST /api/run              { agentId?, prompt, provider?, model?, maxTurns?, budgetUsd? } → 202
//                              { runId, queued } (one run per agent at a time, global cap)
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
//   GET  /api/connectors       one status row per connector (connected, last sync, summary)
//   GET  /api/connectors/:kind the row plus the local data the syncs brought in
//   POST /api/connectors/:kind/connect    { apiKey } or {} (OAuth) → a Gate item; 202
//   POST /api/connectors/:kind/disconnect → a Gate item; 202
//   POST /api/connectors/:kind/sync       sync now → { counts, ms }
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
import { randomUUID } from 'node:crypto';
import { makeEvent, CONTRACT_VERSION, PAYLOAD_SCHEMAS } from '../shared/events.js';
import { validate } from '../shared/schema.js';
import { LAYOUT_SCHEMA, OBJECT_KINDS, roomOf, tileInRoom } from '../shared/world.js';
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

export function createLayoutState({ initial, store, bus, clock = { now: () => Date.now() } }) {
  let layout = initial;
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  return {
    get: () => layout,
    async replace(next) {
      const r = validate(LAYOUT_SCHEMA, next);
      if (!r.ok) throw new HttpError(400, `layout invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      layout = next;
      await store.saveLayout(layout);
      return layout;
    },
    async place({ kind, roomId, x, y, objectId }) {
      if (!OBJECT_KINDS[kind]) throw new HttpError(400, `unknown object kind "${kind}"`);
      const room = roomOf(layout, roomId);
      if (!room) throw new HttpError(400, `unknown room "${roomId}"`);
      if (!Number.isInteger(x) || !Number.isInteger(y) || !tileInRoom(room, x, y)) throw new HttpError(400, 'tile is outside the room');
      const occupied = layout.objects.some((o) => o.x === x && o.y === y) || layout.agents.some((a) => a.x === x && a.y === y);
      if (occupied) throw new HttpError(409, 'tile is occupied');
      const id = objectId || `obj-${randomUUID().slice(0, 8)}`;
      if (layout.objects.some((o) => o.id === id)) throw new HttpError(409, `object "${id}" already exists`);
      // makeEvent validates the payload; a bad id or coordinate throws before any change.
      const event = makeEvent('object.place', { objectId: id, kind, roomId, x, y }, { ts: clock.now() });
      layout = { ...layout, objects: [...layout.objects, { id, kind, roomId, x, y }] };
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

export function createApp({ bus, store, runs, layoutState, leashState = null, ledger = null, gateQueue = null, agents = null, trails = null, chief = null, reflect = null, away = null, mailSetup = null, mail = null, browser = null, connectors = null, workspace = null, providerStatus, keystoreStatus, staticRoot, sharedRoot, home, workspaceRoot }) {
  const staticReal = path.resolve(staticRoot);
  const sharedReal = path.resolve(sharedRoot);

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
        home,
        workspaceRoot,
        workspace: workspace ? workspace.state() : { root: workspaceRoot, online: true, known: false, since: 0, reason: null },
        providers,
        keystore: { path: keystore.path, problem: keystore.problem },
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
        spend,
        runs: recent.slice(0, 20),
      });
    }
    if (p === '/api/run' && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const { runId, agentId, provider, model, tier, queued } = await runs.start(body);
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
        return sendJson(res, 202, await chief.mission(body));
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

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('request failed:', err);
      if (!res.headersSent) sendJson(res, status, { error: err.message, code: err.code || `HTTP_${status}` });
      else res.end();
    }
  };
}

export function createHttpServer(app) {
  return http.createServer(app);
}
