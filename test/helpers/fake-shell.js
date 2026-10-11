// A fake macOS shell for computer control (phase 4 step 18): the credential broker's
// socket protocol (src-tauri/src/broker.rs) with the `COMPUTER` op the real shell answers
// from src-tauri/src/computer.rs, over a scripted desktop: a frontmost app, running apps, an
// accessibility tree, a tiny PNG for screenshots. Records every action; `halt()` is the
// hotkey. The credential ops work too, so keys.js is happy on the same socket. Test-only.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

// A 1×1 PNG (valid file, nothing to see): what a screenshot looks like on the wire.
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function startFakeShell({ token = 'shell-token', sensitiveIds = ['com.apple.systempreferences', 'com.apple.Terminal'] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-shell-'));
  const socket = path.join(dir, 'credentials.sock');
  const store = new Map();
  const state = {
    requests: [],
    actions: [],
    frontmost: { bundleId: 'com.apple.Notes', name: 'Notes', pid: 100 },
    window: null, // { title, url } of the front window when a test sets it (safety 2026-10-11 H2)
    apps: [{ bundleId: 'com.apple.Notes', name: 'Notes', pid: 100 }, { bundleId: 'com.apple.finder', name: 'Finder', pid: 90 }, { bundleId: 'com.apple.Terminal', name: 'Terminal', pid: 120 }, { bundleId: 'com.makapark.maka', name: 'Maka', pid: 50 }, { bundleId: 'com.apple.Safari', name: 'Safari', pid: 60 }],
    tree: [{ id: 'n1', role: 'AXButton', title: 'Save', x: 100, y: 200, w: 80, h: 30 }, { id: 'n2', role: 'AXTextField', title: 'Search', value: 'lanterns', x: 300, y: 40, w: 200, h: 24 }],
    permissions: { accessibility: true, screenRecording: true },
    halted: false,
    banner: false,
    sessions: [],
    fail: null, // an action name -> every such request answers ERR
    screenshots: 0,
  };
  const api = { socket, token, state, store, env: { MAKA_CREDENTIALS_SOCKET: socket, MAKA_CREDENTIALS_TOKEN: token }, halt() { state.halted = true; }, resume() { state.halted = false; } };
  const refuse = (code, error, extra = {}) => `OK ${Buffer.from(JSON.stringify({ ok: false, code, error, ...extra }), 'utf8').toString('base64')}`;
  const ok = (value) => `OK ${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}`;
  function computer(action, request) {
    const { action: _a, ...params } = request;
    state.actions.push({ action, params });
    if (state.fail === action) return `ERR ${action} failed in the shell`;
    if (action === 'status') return ok({ platform: 'macos', permissions: state.permissions, halted: state.halted, driving: state.banner });
    if (action === 'halt') { state.halted = true; state.banner = false; return ok({ halted: true }); }
    if (action === 'resume') { state.halted = false; return ok({ halted: false }); }
    if (state.halted) return refuse('HALTED', 'halted by the hotkey');
    if (action === 'begin') { state.banner = true; state.sessions.push({ ...params, status: 'begun' }); return ok({ banner: true }); }
    if (action === 'end') { state.banner = false; state.sessions.push({ ...params, status: 'ended' }); return ok({ banner: false }); }
    if (action === 'frontmost') return ok({ app: state.frontmost, window: state.window, sensitive: sensitiveIds.includes(state.frontmost.bundleId) });
    if (action === 'apps') return ok({ apps: state.apps.map((a) => ({ ...a, front: a.bundleId === state.frontmost.bundleId, sensitive: sensitiveIds.includes(a.bundleId) })) });
    if (action === 'focus') {
      const app = state.apps.find((a) => a.bundleId === params.bundleId || (params.name && a.name.toLowerCase() === String(params.name).toLowerCase()));
      if (!app) return refuse('NO_APP', `no running app ${params.bundleId || params.name}`);
      if (sensitiveIds.includes(app.bundleId)) return refuse('SENSITIVE_APP', `${app.name} is an app a Ranger never drives`, { app: app.name });
      state.frontmost = app;
      return ok({ app });
    }
    if (sensitiveIds.includes(state.frontmost.bundleId)) return refuse('SENSITIVE_APP', `${state.frontmost.name} is an app a Ranger never drives`, { app: state.frontmost.name });
    if (action === 'screenshot') { state.screenshots += 1; return ok({ png: TINY_PNG.toString('base64'), width: 1, height: 1 }); }
    if (action === 'locate') return ok({ nodes: state.tree });
    if (action === 'click') return ok({ clicked: { x: params.x, y: params.y, button: params.button, double: params.double } });
    if (action === 'type') return ok({ typed: params.text.length });
    if (action === 'key') return ok({ pressed: `${params.modifiers.join('+')}${params.modifiers.length ? '+' : ''}${params.key}` });
    return `ERR unknown computer action ${action}`;
  }
  function answer(line) {
    const [given, op, name, b64] = line.split(' ');
    if (given !== token) return 'ERR bad token';
    if (op === 'LIST') return `OK ${[...store.keys()].sort().join(',')}`;
    if (op === 'COMPUTER') {
      let params = {};
      try {
        params = JSON.parse(Buffer.from(b64 || '', 'base64').toString('utf8'));
      } catch {
        return 'ERR COMPUTER value is not JSON';
      }
      if (params.action !== name) return 'ERR COMPUTER action mismatch';
      return computer(name, params);
    }
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return 'ERR invalid credential name';
    if (op === 'GET') return store.has(name) ? `OK ${Buffer.from(store.get(name), 'utf8').toString('base64')}` : 'NONE';
    if (op === 'SET') { store.set(name, Buffer.from(b64, 'base64').toString('utf8')); return 'OK'; }
    if (op === 'DEL') { store.delete(name); return 'OK'; }
    return `ERR unknown op ${op}`;
  }
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      state.requests.push(line.split(' ').slice(1, 3).join(' '));
      conn.end(`${answer(line)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  api.close = async () => {
    for (const c of conns) c.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
  };
  return api;
}
