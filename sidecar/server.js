// HTTP + SSE server. Routes:
//   GET  /api/state            snapshot: providers (configured or not), layout, active run,
//                              spend, pending prompts, object kinds, recent runs
//   GET  /api/events           SSE stream of every event (replays after Last-Event-ID)
//   POST /api/run              { agentId?, prompt, provider?, model?, maxTurns?, budgetUsd? }
//   POST /api/cancel           { runId? }
//   GET  /api/layout           the layout
//   PUT  /api/layout           replace the layout (validated)
//   POST /api/layout/place     { kind, roomId, x, y, objectId? } → emits object.place
//   POST /api/layout/reclaim   { objectId } → emits object.reclaim
//   POST /api/permission       { promptId, runId, allow } → emits permission.response
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

export function createApp({ bus, store, runs, layoutState, leashState = null, providerStatus, keystoreStatus, staticRoot, sharedRoot, home, workspaceRoot }) {
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
        providers,
        keystore: { path: keystore.path, problem: keystore.problem },
        layout: layoutState.get(),
        objectKinds: OBJECT_KINDS,
        activeRun: runs.active(),
        pendingPrompts: runs.pending(),
        policy: runs.policy,
        leash: leashState ? leashState.get() : null,
        spend,
        runs: recent.slice(0, 20),
      });
    }
    if (p === '/api/run' && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const { runId, agentId, provider, model, tier } = await runs.start(body);
        return sendJson(res, 202, { runId, agentId, provider, model, tier });
      } catch (err) {
        if (err.code === 'RUN_ACTIVE') throw new HttpError(409, err.message, err.code);
        if (['NO_KEY', 'NO_MODEL', 'OLLAMA_UNREACHABLE', 'UNKNOWN_PROVIDER', 'BAD_REQUEST'].includes(err.code)) throw new HttpError(400, err.message, err.code);
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
    if (p === '/api/permission' && method === 'POST') {
      const body = await readJsonBody(req);
      const r = validate(PAYLOAD_SCHEMAS['permission.response'], body);
      if (!r.ok) throw new HttpError(400, `permission.response invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      const accepted = runs.answer(body);
      return sendJson(res, accepted ? 200 : 404, { accepted });
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
