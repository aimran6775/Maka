// Browser control for Rangers (phase 2 step 13): one Chromium profile per Ranger under
// `<root>/<agentId>/browser-profile/`, a step-by-step trace with screenshots under
// `<root>/<agentId>/browser-trace/`, and the BROWSER HANDOFF: when a page asks for a
// login, a one-time code, a captcha or card details, the action parks, a browser.handoff
// event goes out, the window comes to the front, and the Ranger waits until the
// Superintendent hands the page back (POST /api/browser/handoff/:id/return) or the run
// ends. The check runs before an action as well as after it (safety L1), and a payment
// page is handed back only with notes.
//
//   createBrowserControl({ workspaceRoot, bus, env, config, clock, driver, netGuard, log })
//     .init() -> { tools, forAgent, act, returnHandoff, handoffs, trace, status,
//                  closeAgent, close }
//
// `driver` = { find, launch, connect, openPage } defaults to sidecar/browser/cdp.js; tests
// inject a fake page. The Chromium for a Ranger closes when its run ends (the profile on
// disk keeps cookies, so a login survives); docs/DECISIONS.md D73.
// `netGuard` (sidecar/netguard.js, safety H1): after every action the page the browser is
// on is checked; a page on loopback, the LAN or this machine (Maka's own UI included) is
// left for about:blank and the action fails with NET_GUARD.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../../shared/events.js';
import { findChromium, launchChromium, connectCdp, openPage } from './cdp.js';
import { detectHandoff } from './detect.js';
import { BROWSER_TOOLS } from './tools.js';
import { defaultNetGuard } from '../netguard.js';

export const PROFILE_DIR = 'browser-profile';
export const TRACE_DIR = 'browser-trace';
export const TRACE_FILE = 'trace.ndjson';
export const TRACE_LIMIT = 200;

const defaultDriver = { find: findChromium, launch: launchChromium, connect: connectCdp, openPage };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const hasNotes = (rec) => Boolean(rec && typeof rec.notes === 'string' && rec.notes.trim());

export function createBrowserControl({
  workspaceRoot,
  bus,
  env = process.env,
  config = {},
  clock = { now: () => Date.now() },
  driver = defaultDriver,
  netGuard = defaultNetGuard(),
  log = console,
} = {}) {
  if (!workspaceRoot) throw new TypeError('createBrowserControl needs workspaceRoot');
  if (!bus) throw new TypeError('createBrowserControl needs bus');
  const headless = config.headless !== undefined ? Boolean(config.headless) : env.MAKA_BROWSER_HEADLESS === '1';
  const sessions = new Map(); // agentId -> { agentId, page, client, proc, since, lastHandoff, closing }
  const handoffs = new Map(); // handoffId -> record (+ resolve while waiting)
  const order = [];
  let chromium = null;
  let chromiumLooked = false;

  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  async function chromiumPath() {
    if (!chromiumLooked) {
      chromiumLooked = true;
      try {
        chromium = await driver.find({ env, configured: config.chromiumPath || null });
      } catch {
        chromium = null;
      }
    }
    return chromium;
  }

  const traceDir = (agentId) => path.join(workspaceRoot, agentId, TRACE_DIR);

  async function record(agentId, entry) {
    const dir = traceDir(agentId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, TRACE_FILE), JSON.stringify(entry) + '\n');
  }

  async function snapshot(session, label) {
    try {
      const png = await session.page.screenshot();
      const dir = traceDir(session.agentId);
      await fsp.mkdir(dir, { recursive: true });
      const name = `${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^\w-]+/g, '_')}.png`;
      await fsp.writeFile(path.join(dir, name), png);
      return path.join(dir, name);
    } catch (err) {
      log.error && log.error(`screenshot failed for ${session.agentId}: ${err.message}`);
      return null;
    }
  }

  // Launches (once) the Ranger's browser and opens its tab.
  async function forAgent(agentId) {
    const existing = sessions.get(agentId);
    if (existing && !existing.closing) return existing;
    const bin = await chromiumPath();
    if (!bin && driver === defaultDriver) throw fail('NO_CHROMIUM', 'no Chromium found: set browser.chromiumPath in config.json or CHROMIUM in the environment');
    const profileDir = path.join(workspaceRoot, agentId, PROFILE_DIR);
    await fsp.mkdir(profileDir, { recursive: true });
    const proc = await driver.launch({ bin, profileDir, headless });
    let client;
    let page;
    try {
      client = await driver.connect(proc.wsUrl);
      page = await driver.openPage(client);
    } catch (err) {
      proc.kill();
      throw err;
    }
    const session = { agentId, page, client, proc, since: clock.now(), lastHandoff: null, closing: false };
    sessions.set(agentId, session);
    if (client.closed) client.closed.then(() => { if (sessions.get(agentId) === session) sessions.delete(agentId); });
    return session;
  }

  // Runs one browser action for a Ranger: the handoff check on the page it is about to act
  // on (safety L1: a payment or login page reached without a check, through a read or a
  // page's own script, parks the action before it happens), the action itself, a trace
  // line with a screenshot, then the handoff check on the page it landed on.
  // `checkHandoff`: true (both), false (neither) or { before, after }.
  async function act({ agentId, runId, signal, action, input, run, checkHandoff = true }) {
    const session = await forAgent(agentId);
    if (runId) session.lastRunId = runId;
    const checks = typeof checkHandoff === 'object' && checkHandoff ? { before: Boolean(checkHandoff.before), after: Boolean(checkHandoff.after) } : { before: Boolean(checkHandoff), after: Boolean(checkHandoff) };
    let handoff = null;
    if (checks.before) {
      handoff = await maybeHandoff(session, { runId, signal });
      if (handoff && handoff.status === 'abandoned') return { result: null, url: session.page.url(), title: '', screenshot: null, handoff };
    }
    const started = clock.now();
    const entry = { ts: started, agentId, runId: runId || null, action, input, ok: false };
    let result;
    try {
      result = await run(session.page, session);
      entry.ok = true;
    } catch (err) {
      entry.error = err.message;
      entry.code = err.code || null;
    }
    try {
      const s = await session.page.summary();
      entry.url = s.url;
      entry.title = s.title;
    } catch {
      /* page gone */
    }
    // Safety H1: wherever the action led, the page must be on the public internet.
    if (!entry.error && entry.url && /^https?:/i.test(entry.url)) {
      const verdict = await netGuard.check(entry.url);
      if (!verdict.ok) {
        entry.ok = false;
        entry.error = `the page landed on ${entry.url}: ${verdict.reason}; the browser left it`;
        entry.code = 'NET_GUARD';
        try {
          await session.page.navigate('about:blank');
        } catch {
          /* the trace says where it was */
        }
      }
    }
    entry.screenshot = await snapshot(session, action);
    entry.ms = clock.now() - started;
    await record(agentId, entry);
    if (entry.error) throw Object.assign(new Error(entry.error), { code: entry.code || 'BROWSER' });
    if (checks.after) {
      const after = await maybeHandoff(session, { runId, signal });
      if (after) handoff = after;
    }
    return { result, url: entry.url, title: entry.title, screenshot: entry.screenshot, handoff };
  }

  async function maybeHandoff(session, { runId, signal }) {
    let facts;
    try {
      facts = await session.page.facts();
    } catch {
      return null;
    }
    const hit = detectHandoff(facts);
    if (!hit) return null;
    const last = session.lastHandoff;
    // After a hand-back, the same page is not re-raised: the Superintendent chose to return
    // it as it is, and the Ranger must decide what to do with that. A payment page is the
    // exception (safety L1): it continues only on a hand-back that carried notes, so the
    // Ranger acts on what the Superintendent said and not on a bare "returned".
    if (last && last.kind === hit.kind && last.url === facts.url && last.status === 'returned' && (hit.kind !== 'payment' || hasNotes(last))) return { ...last, repeated: true };
    const reason = hit.kind === 'payment' ? `${hit.reason}; say in the notes what was done and whether the Ranger may continue, or it stays parked` : hit.reason;
    return waitForReturn(session, { runId, signal, kind: hit.kind, reason, url: facts.url, title: facts.title });
  }

  function waitForReturn(session, { runId, signal, kind, reason, url, title }) {
    if (signal && signal.aborted) return Promise.resolve({ handoffId: null, kind, status: 'abandoned', reason });
    const handoffId = `hand-${randomUUID().slice(0, 8)}`;
    const rec = { handoffId, agentId: session.agentId, runId: runId || null, url, title, kind, reason, status: 'waiting', since: clock.now(), headless };
    handoffs.set(handoffId, rec);
    order.push(handoffId);
    if (order.length > 100) handoffs.delete(order.shift());
    session.lastHandoff = rec;
    emit('browser.handoff', payloadOf(rec));
    session.page.bringToFront();
    return new Promise((resolve) => {
      const finish = (status, notes) => {
        if (rec.status !== 'waiting') return;
        rec.status = status;
        rec.until = clock.now();
        if (notes) rec.notes = notes;
        delete rec.resolve;
        if (signal) signal.removeEventListener('abort', onAbort);
        emit('browser.handoff', payloadOf(rec));
        record(session.agentId, { ts: rec.until, agentId: session.agentId, runId: rec.runId, action: 'handoff', input: { kind, url }, ok: status === 'returned', status, notes: notes || '' }).catch(() => {});
        resolve({ handoffId, kind, reason, status, notes: notes || '' });
      };
      const onAbort = () => finish('abandoned');
      rec.resolve = finish;
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function payloadOf(rec) {
    const p = { handoffId: rec.handoffId, agentId: rec.agentId, status: rec.status, kind: rec.kind, reason: rec.reason, url: rec.url, title: rec.title || '', headless: rec.headless };
    if (rec.runId) p.runId = rec.runId;
    if (rec.notes) p.notes = rec.notes;
    return p;
  }

  async function closeAgent(agentId) {
    const s = sessions.get(agentId);
    if (!s) return false;
    s.closing = true;
    sessions.delete(agentId);
    for (const rec of handoffs.values()) if (rec.agentId === agentId && rec.status === 'waiting' && rec.resolve) rec.resolve('abandoned');
    try {
      await s.page.close();
    } catch {
      /* ignore */
    }
    try {
      s.client.close();
    } catch {
      /* ignore */
    }
    s.proc.kill();
    // Wait for the process to go so the profile directory is quiet (bounded).
    if (s.proc.exited) await Promise.race([s.proc.exited, new Promise((r) => setTimeout(r, 3000))]);
    return true;
  }

  const api = {
    tools: BROWSER_TOOLS,
    headless,
    forAgent,
    act,
    closeAgent,
    async close() {
      for (const id of [...sessions.keys()]) await closeAgent(id);
    },
    // The Superintendent finished the step in the window and hands the page back.
    returnHandoff(handoffId, { notes = '' } = {}) {
      const rec = handoffs.get(handoffId);
      if (!rec) throw fail('NOT_FOUND', `no browser handoff ${handoffId}`);
      if (rec.status !== 'waiting') throw fail('NOT_WAITING', `handoff ${handoffId} is already ${rec.status}`);
      // Safety L1: a payment page comes back with explicit notes or not at all.
      if (rec.kind === 'payment' && !(typeof notes === 'string' && notes.trim())) throw fail('NOTES_REQUIRED', `handoff ${handoffId} is a payment page: say in the notes what was done and whether the Ranger may continue`);
      rec.resolve('returned', typeof notes === 'string' ? notes.trim() : '');
      return payloadOf(rec);
    },
    handoffs: ({ pendingOnly = false } = {}) => order.map((id) => handoffs.get(id)).filter((r) => r && (!pendingOnly || r.status === 'waiting')).map((r) => ({ ...payloadOf(r), since: r.since, until: r.until || null })),
    async trace(agentId, { limit = 50 } = {}) {
      let raw;
      try {
        raw = await fsp.readFile(path.join(traceDir(agentId), TRACE_FILE), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
    },
    async status() {
      const bin = await chromiumPath();
      return {
        chromium: bin,
        wired: Boolean(bin),
        headless,
        sessions: [...sessions.values()].filter((s) => !s.closing).map((s) => ({ agentId: s.agentId, url: s.page.url(), since: s.since })),
        pending: api.handoffs({ pendingOnly: true }),
      };
    },
    async init() {
      bus.listen((ev) => {
        if (ev.type !== 'agent.run.end' && ev.type !== 'agent.run.error') return;
        for (const s of [...sessions.values()]) {
          if (s.lastRunId === ev.payload.runId) closeAgent(s.agentId).catch((err) => log.error && log.error(`browser close failed: ${err.message}`));
        }
      });
      return api;
    },
  };
  return api;
}
