// Computer control for Rangers (phase 4 step 18, D149): driving this Mac through the shell.
//
// The shell (src-tauri/src/computer.rs, macOS only) owns the Accessibility and CGEvent
// calls; the sidecar reaches it over the credential broker's Unix socket with `COMPUTER`
// requests (sidecar/computer/policy.js has the framing), never over HTTP. Without the shell
// (Linux, a plain `npm start`) the tools say not wired. The leash domain is
// `computer_control`, Observe by default: nothing runs until the Superintendent raises it
// at the Gate; at Draft every action waits at the Gate and asks the judge too; at Act the
// judge reviews every action (it is never research) and the day's action cap holds.
//
// Every action: the frontmost app is asked for and checked against the sensitive list
// (Maka itself, browsers, banking, password managers, System Settings, terminals: those
// always HAND OFF to the Superintendent, who does the thing and hands back; the Ranger's
// action is then refused, not retried) and its front window against the loopback rule (a
// title or URL naming 127.0.0.1 / localhost / the sidecar's own host:port is a local web
// UI, Maka's own included, and hands off the same way: safety 2026-10-11 H2), a screenshot
// is taken before, the action runs, a screenshot is taken after,
// a trace line with both paths is written under `<root>/<agentId>/computer-trace/`, and a
// `computer.action` event goes out. The first action of a run begins a session (the shell
// shows its banner) and the run's end ends it. The halt hotkey (⌃⌥⌘H in the shell) or
// `POST /api/computer/halt` stops everything: every action is refused as HALTED until the
// Superintendent resumes.
//
//   createComputerControl({ bus, env, workspaceRoot, clock, request, log })
//     .init() -> { tools, status(), act(), handoffs(), returnHandoff(), halt(), resume(),
//                  trace(), sessions(), close() }

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../../shared/events.js';
import { brokerFrom, brokerRequest } from '../providers/keys.js';
import { COMPUTER_TOOL_NAMES, HALT_HOTKEY, TRACE_LIMIT, TYPE_MAX_CHARS, isSensitiveApp, parseChord, locateMatches, encodeRequest, decodeReply } from './policy.js';

export const TRACE_DIR = 'computer-trace';
export const TRACE_FILE = 'trace.ndjson';
export const SHELL_TIMEOUT_MS = 15_000;

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export function createComputerControl({ bus, env = process.env, workspaceRoot, clock = { now: () => Date.now() }, request = brokerRequest, broker = brokerFrom(env), ownHosts = [], log = console } = {}) {
  if (!bus) throw new TypeError('createComputerControl needs bus');
  if (!workspaceRoot) throw new TypeError('createComputerControl needs workspaceRoot');
  const sessions = new Map(); // runId -> { agentId, runId, since, actions, lastApp }
  const handoffs = new Map(); // handoffId -> record (+ resolve while waiting)
  const order = [];
  let halted = null; // { by, at } while halted
  const unsubscribe = [];
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const traceDir = (agentId) => path.join(workspaceRoot, agentId, TRACE_DIR);

  // One request to the shell. Not wired: a coded failure, never a throw into the tool.
  async function shell(action, params = {}) {
    if (!broker) return { ok: false, code: 'NOT_WIRED', error: 'computer control needs the macOS app (the shell is not running, so there is no socket to drive this Mac through)' };
    let reply;
    try {
      reply = await request(broker, 'COMPUTER', action, encodeRequest(action, params), { timeoutMs: SHELL_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, code: err.code || 'SHELL_UNREACHABLE', error: err.message };
    }
    return decodeReply(reply);
  }

  async function record(agentId, entry) {
    const dir = traceDir(agentId);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, TRACE_FILE);
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`);
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > TRACE_LIMIT) await fsp.writeFile(file, `${lines.slice(-TRACE_LIMIT).join('\n')}\n`);
  }

  // A screenshot from the shell to the trace directory; null when it failed (the trace says so).
  async function snapshot(agentId, label) {
    const r = await shell('screenshot', {});
    if (!r.ok || !r.result.png) return { path: null, error: r.ok ? 'no image' : r.error };
    const dir = traceDir(agentId);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${clock.now()}-${label}.png`);
    await fsp.writeFile(file, Buffer.from(r.result.png, 'base64'));
    return { path: path.relative(workspaceRoot, file), width: r.result.width || null, height: r.result.height || null };
  }

  function payloadOf(rec) {
    const p = { handoffId: rec.handoffId, agentId: rec.agentId, status: rec.status, kind: rec.kind, reason: rec.reason };
    if (rec.runId) p.runId = rec.runId;
    if (rec.app) p.app = rec.app;
    if (rec.action) p.action = rec.action;
    if (rec.notes) p.notes = rec.notes;
    return p;
  }

  function waitForReturn({ agentId, runId, signal, kind, reason, app, action }) {
    if (signal && signal.aborted) return Promise.resolve({ handoffId: null, kind, status: 'abandoned', reason, notes: '' });
    const handoffId = `chand-${randomUUID().slice(0, 8)}`;
    const rec = { handoffId, agentId, runId: runId || null, kind, reason, app: app || null, action: action || null, status: 'waiting', since: clock.now() };
    handoffs.set(handoffId, rec);
    order.push(handoffId);
    if (order.length > 100) handoffs.delete(order.shift());
    emit('computer.handoff', payloadOf(rec));
    return new Promise((resolve) => {
      const finish = (status, notes) => {
        if (rec.status !== 'waiting') return;
        rec.status = status;
        rec.until = clock.now();
        if (notes) rec.notes = notes;
        delete rec.resolve;
        if (signal) signal.removeEventListener('abort', onAbort);
        emit('computer.handoff', payloadOf(rec));
        resolve({ handoffId, kind, reason, status, notes: notes || '' });
      };
      const onAbort = () => finish('abandoned');
      rec.resolve = finish;
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function beginSession(agentId, runId) {
    if (sessions.has(runId)) return sessions.get(runId);
    const r = await shell('begin', { agentId, runId });
    if (!r.ok) return null;
    const s = { agentId, runId, since: clock.now(), actions: 0, lastApp: null, handedOffApp: null };
    sessions.set(runId, s);
    emit('computer.action', { agentId, runId, action: 'session', status: 'session_start' });
    return s;
  }

  async function endSession(runId, reason = 'the run ended') {
    const s = sessions.get(runId);
    if (!s) return;
    sessions.delete(runId);
    await shell('end', { agentId: s.agentId, runId });
    emit('computer.action', { agentId: s.agentId, runId, action: 'session', status: 'session_end', reason });
  }

  // One action for a Ranger, through every check, with the trace and the event.
  async function act({ agentId, runId, signal, action, input = {} }) {
    const started = clock.now();
    const entry = { ts: started, agentId, runId: runId || null, action, input, ok: false };
    const finish = async (status, extra = {}) => {
      Object.assign(entry, extra, { ms: clock.now() - started });
      await record(agentId, entry);
      const payload = { agentId, action, status };
      if (runId) payload.runId = runId;
      for (const k of ['app', 'reason', 'code', 'before', 'after', 'handoffId']) if (entry[k]) payload[k] = String(entry[k]);
      payload.ms = entry.ms;
      emit('computer.action', payload);
      return entry;
    };
    if (!broker) {
      await finish('refused', { code: 'NOT_WIRED', error: 'computer control needs the macOS app', reason: 'not wired' });
      throw fail('NOT_WIRED', 'computer control needs the macOS app (the shell is not running, so there is no socket to drive this Mac through)');
    }
    if (halted) {
      await finish('halted', { code: 'HALTED', reason: `halted by ${halted.by}` });
      throw fail('HALTED', `computer control is halted (${halted.by}, ${new Date(halted.at).toISOString()}); the Superintendent resumes it at the Peak or with the hotkey ${HALT_HOTKEY} lifted`);
    }
    const session = runId ? await beginSession(agentId, runId) : null;
    if (runId && !session) {
      await finish('refused', { code: 'SHELL', reason: 'the shell refused to begin a session' });
      throw fail('SHELL', 'the shell refused to begin a computer session');
    }
    // The app in front, before anything: the sensitive ones hand off and are never driven.
    const front = await shell('frontmost', {});
    if (!front.ok) {
      if (front.code === 'HALTED') {
        halted = halted || { by: 'the hotkey', at: clock.now() };
        await finish('halted', { code: 'HALTED', reason: 'halted by the hotkey' });
        throw fail('HALTED', `computer control is halted by the hotkey (${HALT_HOTKEY}); the Superintendent resumes it at the Peak`);
      }
      await finish('failed', { code: front.code, error: front.error });
      throw fail(front.code, front.error);
    }
    const app = front.result.app || {};
    const appLabel = app.name ? `${app.name}${app.bundleId ? ` (${app.bundleId})` : ''}` : app.bundleId || 'unknown app';
    entry.app = appLabel;
    const sens = isSensitiveApp({ ...app, window: front.result.window || app.window || null }, { ownHosts });
    if (sens.sensitive || front.result.sensitive) {
      const why = sens.why || front.result.reason || `${appLabel} is an app a Ranger never drives`;
      if (session && session.handedOffApp === appLabel) {
        await finish('refused', { code: 'SENSITIVE_APP', reason: why });
        throw fail('SENSITIVE_APP', `${why}; the Superintendent already handled it, so the Ranger does not act here: move to another app or say what you need`);
      }
      const handoff = await waitForReturn({ agentId, runId, signal, kind: 'sensitive_app', reason: `${why}; do it yourself and hand back with a note`, app: appLabel, action });
      if (session) session.handedOffApp = appLabel;
      await finish('handoff', { code: 'SENSITIVE_APP', reason: why, handoffId: handoff.handoffId || undefined, handoffStatus: handoff.status, notes: handoff.notes });
      throw fail('SENSITIVE_APP', `${why}; handed to the Superintendent (${handoff.status}${handoff.notes ? `: ${handoff.notes}` : ''}); the Ranger's ${action} did not run`);
    }
    if (session) session.handedOffApp = null;
    const before = await snapshot(agentId, `${action}-before`);
    entry.before = before.path;
    let params = {};
    try {
      params = paramsFor(action, input);
    } catch (err) {
      await finish('refused', { code: 'BAD_INPUT', reason: err.message });
      throw fail('BAD_INPUT', err.message);
    }
    const r = await shell(action, params);
    const after = await snapshot(agentId, `${action}-after`);
    entry.after = after.path;
    if (!r.ok) {
      if (r.code === 'HALTED') {
        halted = halted || { by: 'the hotkey', at: clock.now() };
        await finish('halted', { code: 'HALTED', reason: 'halted by the hotkey' });
        throw fail('HALTED', `computer control was halted by the hotkey (${HALT_HOTKEY}) during ${action}; the Superintendent resumes it at the Peak`);
      }
      if (r.code === 'SENSITIVE_APP') {
        await finish('refused', { code: r.code, reason: r.error, app: r.app || appLabel });
        throw fail('SENSITIVE_APP', r.error);
      }
      await finish('failed', { code: r.code, error: r.error });
      throw fail(r.code || 'SHELL', r.error);
    }
    if (session) session.actions += 1;
    entry.ok = true;
    const result = action === 'locate' ? { matches: locateMatches(r.result.nodes || [], input.query), scanned: (r.result.nodes || []).length } : r.result;
    await finish('done', { result: summariseResult(action, result) });
    return { result, app: appLabel, before: before.path, after: after.path };
  }

  // The shell's parameters for an action, validated here as well as by the tool schema.
  function paramsFor(action, input) {
    switch (action) {
      case 'click': {
        const x = Number(input.x);
        const y = Number(input.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('click needs x and y in screen points (from computer.locate or a screenshot)');
        return { x: Math.round(x), y: Math.round(y), button: input.button === 'right' ? 'right' : 'left', double: Boolean(input.double) };
      }
      case 'type': {
        if (typeof input.text !== 'string' || !input.text.length) throw new Error('type needs text');
        if (input.text.length > TYPE_MAX_CHARS) throw new Error(`type sends at most ${TYPE_MAX_CHARS} characters at a time`);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)) throw new Error('type sends printable text; use computer.key for keys');
        return { text: input.text };
      }
      case 'key':
        return parseChord(input.chord);
      case 'focus': {
        if (typeof input.bundleId !== 'string' && typeof input.name !== 'string') throw new Error('focus needs a bundleId or an app name');
        const sens = isSensitiveApp({ bundleId: input.bundleId || '', name: input.name || '' });
        if (sens.sensitive) throw new Error(`${sens.why}; a Ranger never brings it to the front`);
        return { bundleId: input.bundleId || null, name: input.name || null };
      }
      case 'locate':
        if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('locate needs a query (text or a role)');
        return { query: input.query.trim().slice(0, 200), maxDepth: 12 };
      default:
        return {};
    }
  }

  function summariseResult(action, result) {
    if (action === 'screenshot') return { width: result.width || null, height: result.height || null };
    if (action === 'locate') return { matches: result.matches.length, scanned: result.scanned };
    if (action === 'apps') return { apps: Array.isArray(result.apps) ? result.apps.length : 0 };
    return result && typeof result === 'object' ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'png').slice(0, 10)) : {};
  }

  const toolCommon = { confirm: false, judgeAtDraft: () => true };
  const describe = (name, description, props = {}, required = []) => ({
    name,
    description,
    inputSchema: { type: 'object', required, additionalProperties: false, properties: props },
    ...toolCommon,
  });
  const run = (action, summary) => async (input, ctx) => {
    try {
      const out = await act({ agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, action, input });
      const result = { ...out.result, app: out.app, before: out.before, after: out.after };
      if (action === 'screenshot') delete result.png;
      return { ok: true, output: JSON.stringify(result) };
    } catch (err) {
      return { ok: false, code: err.code || 'COMPUTER', error: err.message };
    }
  };
  const tools = Object.freeze({
    'computer.screenshot': { ...describe('computer.screenshot', 'A screenshot of this Mac\'s main display, saved to your computer-trace folder (the path is returned with the size); read it with fs.read if you need to reason about it. Everything on the screen is captured, so this is a computer_control action, not research.'), summarize: () => 'take a screenshot of the Mac', run: run('screenshot') },
    'computer.locate': { ...describe('computer.locate', 'Find elements in the frontmost app by the accessibility tree: a text (title, value or description) or a role (AXButton, AXTextField…). Returns matches with their frame and centre in screen points for computer.click.', { query: { type: 'string', minLength: 1, maxLength: 200 } }, ['query']), summarize: (input) => `locate "${String(input.query || '').slice(0, 60)}" on the Mac`, run: run('locate') },
    'computer.click': { ...describe('computer.click', 'Click at screen coordinates (from computer.locate or a screenshot). button: left (default) or right; double: true for a double click.', { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } }, ['x', 'y']), summarize: (input) => `click at ${input.x},${input.y} on the Mac`, run: run('click') },
    'computer.type': { ...describe('computer.type', `Type text into the focused element (printable text only, at most ${TYPE_MAX_CHARS} characters; keys go through computer.key).`, { text: { type: 'string', minLength: 1, maxLength: TYPE_MAX_CHARS } }, ['text']), summarize: (input) => `type ${String(input.text || '').length} character(s) on the Mac`, run: run('type') },
    'computer.key': { ...describe('computer.key', 'Press a key chord, like "cmd+s", "return", "cmd+shift+t", "escape".', { chord: { type: 'string', minLength: 1, maxLength: 40 } }, ['chord']), summarize: (input) => `press ${input.chord} on the Mac`, run: run('key') },
    'computer.focus': { ...describe('computer.focus', 'Bring an app to the front by bundle id (com.apple.Notes) or name. Maka itself, browsers (the web is driven with the browser tools), banking, password managers, System Settings and terminals are refused.', { bundleId: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 } }), summarize: (input) => `bring ${input.bundleId || input.name} to the front`, run: run('focus') },
    'computer.apps': { ...describe('computer.apps', 'The running apps (name, bundle id, whether in front) and which the policy marks sensitive.'), summarize: () => 'list the running apps on the Mac', run: run('apps') },
  });
  for (const name of COMPUTER_TOOL_NAMES) if (!tools[name]) throw new Error(`tool ${name} is missing`);

  const api = {
    tools,
    act,
    async status() {
      if (!broker) return { wired: false, reason: 'the macOS app is not running (no shell socket); computer control needs it', platform: process.platform, halted: null, sessions: [], pending: api.handoffs({ pendingOnly: true }).length, hotkey: HALT_HOTKEY };
      const r = await shell('status', {});
      return { wired: r.ok, reason: r.ok ? null : r.error, platform: r.ok ? r.result.platform || 'macos' : process.platform, permissions: r.ok ? r.result.permissions || null : null, shellHalted: r.ok ? Boolean(r.result.halted) : null, halted, sessions: api.sessions(), pending: api.handoffs({ pendingOnly: true }).length, hotkey: HALT_HOTKEY };
    },
    sessions: () => [...sessions.values()].map((s) => ({ agentId: s.agentId, runId: s.runId, since: s.since, actions: s.actions })),
    handoffs: ({ pendingOnly = false } = {}) => order.map((id) => handoffs.get(id)).filter((r) => r && (!pendingOnly || r.status === 'waiting')).map((r) => ({ ...payloadOf(r), since: r.since, until: r.until || null })),
    returnHandoff(handoffId, { notes = '' } = {}) {
      const rec = handoffs.get(handoffId);
      if (!rec) throw fail('NOT_FOUND', `no computer handoff ${handoffId}`, 404);
      if (rec.status !== 'waiting') throw fail('NOT_WAITING', `handoff ${handoffId} is already ${rec.status}`, 409);
      rec.resolve('returned', typeof notes === 'string' ? notes.trim() : '');
      return payloadOf(rec);
    },
    // The halt: from the hotkey (the shell posts it) or the Peak. Every session ends, every
    // waiting handoff is abandoned, and every action is refused until resume().
    async halt({ by = 'superintendent' } = {}) {
      if (!halted) halted = { by, at: clock.now() };
      for (const runId of [...sessions.keys()]) await endSession(runId, `halted by ${by}`);
      for (const rec of handoffs.values()) if (rec.status === 'waiting' && rec.resolve) rec.resolve('abandoned');
      await shell('halt', { by });
      return { halted };
    },
    async resume({ by = 'superintendent' } = {}) {
      const was = halted;
      halted = null;
      const r = await shell('resume', { by });
      return { resumed: Boolean(was), shell: r.ok ? 'resumed' : r.error };
    },
    isHalted: () => halted,
    async trace(agentId, { limit = 50 } = {}) {
      let raw;
      try {
        raw = await fsp.readFile(path.join(traceDir(agentId), TRACE_FILE), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      return raw.split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
    },
    async init() {
      unsubscribe.push(bus.listen((e) => {
        if ((e.type === 'agent.run.end' || e.type === 'agent.run.error') && e.payload && sessions.has(e.payload.runId)) endSession(e.payload.runId).catch((err) => log.error('computer session end failed:', err));
      }));
      return api;
    },
    async close() {
      for (const u of unsubscribe) if (typeof u === 'function') u();
      for (const runId of [...sessions.keys()]) await endSession(runId, 'the sidecar is closing');
      for (const rec of handoffs.values()) if (rec.status === 'waiting' && rec.resolve) rec.resolve('abandoned');
    },
  };
  return api;
}
