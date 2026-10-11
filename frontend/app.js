// Frontend entry: load the snapshot, subscribe to events, render the 3D park and the DOM
// panels. The park renderer is imported dynamically so a missing vendor build shows a plain
// "renderer not vendored" state instead of a broken page.
import { initialState, applySnapshot, applyEvent } from './state.js';
import { connectEvents } from './events.js';
import { createComms } from './ui/comms.js';
import { createSpend } from './ui/spend.js';
import { createBuild } from './ui/build.js';
import { createPermission } from './ui/permission.js';
import { createInspect } from './ui/inspect.js';
import { createFirstRun } from './ui/firstrun.js';
import { el, setChildren } from './ui/windows.js';
import { tileToWorld, TILE_WORLD } from './park/placement.js';

let state = initialState();
const getState = () => state;

// The per-boot token (safety M4): read once from /api/state, sent in x-maka-token on
// every mutating request. A 403 TOKEN_INVALID means the sidecar restarted; the token is
// read again once and the request retried.
let apiToken = null;
async function loadToken() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`cannot read /api/state (${res.status})`);
  const snap = await res.json();
  apiToken = snap.token || null;
  return snap;
}

const api = {
  async get(path) {
    const res = await fetch(path);
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  },
  async post(path, body, { retried = false } = {}) {
    if (!apiToken) await loadToken();
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maka-token': apiToken || '' }, body: JSON.stringify(body) });
    let parsed = {};
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    if (res.status === 403 && parsed && (parsed.code === 'TOKEN_INVALID' || parsed.code === 'TOKEN_REQUIRED') && !retried) {
      apiToken = null;
      return api.post(path, body, { retried: true });
    }
    return { ok: res.ok, status: res.status, body: parsed };
  },
};

const parkEl = document.getElementById('park');
const status = document.getElementById('status');
const ui = document.getElementById('ui');

let park = null; // the renderer handle, once loaded
let parkStatus = { renderer: 'not loaded', assets: '—', ranger: '—', fps: 0, problems: [] };
let parkError = null;

// Build mode: placing at a clicked point inside a zone clearing → nearest free tile.
function tileFromPoint(room, point) {
  let best = null;
  for (let ty = room.y; ty < room.y + room.h; ty++) {
    for (let tx = room.x; tx < room.x + room.w; tx++) {
      const w = tileToWorld(tx, ty);
      const d = Math.hypot(w.x - point.x, w.z - point.z);
      if (d < TILE_WORLD * 0.75 && (!best || d < best.d)) best = { tx, ty, d };
    }
  }
  return best;
}

async function onPick(info) {
  if (info && build.activeKind() && (info.type === 'zone' || info.type === 'ground') && info.point) {
    const room = info.room || null;
    if (!room) return flash('Place fixtures inside a zone clearing.', 'warn');
    const tile = tileFromPoint(room, info.point);
    if (!tile) return flash('No tile under that point. Click closer to the clearing centre.', 'warn');
    const r = await api.post('/api/layout/place', { kind: build.activeKind(), roomId: room.id, x: tile.tx, y: tile.ty, ...(build.activeKind() === 'outpost' && build.activeServer() ? { server: build.activeServer() } : {}) });
    return showError(r);
  }
  if (info && info.type === 'object' && build.activeKind()) {
    return showError(await api.post('/api/layout/reclaim', { objectId: info.object.id }));
  }
  if (info && info.type === 'ground') return inspect.select(null);
  inspect.select(info);
  if (info && info.type === 'agent' && park) park.follow(info.agent.id);
}

const comms = createComms({ parent: ui, getState, api, x: 16, y: 16, w: 440 });
const spend = createSpend({ parent: ui, getState, x: window.innerWidth - 300, y: 16, w: 270 });
const build = createBuild({ parent: ui, getState, world: { setBuild() { render(); } }, x: window.innerWidth - 300, y: 190, w: 270 });
const permission = createPermission({ parent: ui, getState, api });
const inspect = createInspect({ parent: ui, getState, api, x: window.innerWidth - 300, y: 420, w: 270 });
const firstRun = createFirstRun({ parent: ui, getState, api, onRefresh: () => render() });

// Camera and park controls (a small bar under the status line).
const cameraBar = el('div', { class: 'camera-bar' });
ui.append(cameraBar);
function renderCameraBar() {
  const mode = park ? park.cameraMode : null;
  setChildren(cameraBar,
    ...['orbit', 'fly', 'follow'].map((m) => el('button', { class: `btn ${mode === m ? 'active' : ''}`, text: m, disabled: !park, onclick: () => { park.setCameraMode(m); render(); } })),
    el('button', { class: 'btn', text: 're-roll park', title: 'New terrain seed (persisted by the sidecar)', onclick: async () => showError(await api.post('/api/layout/reroll', {})) }),
  );
}

function showError(res) {
  if (res && !res.ok) flash(`${res.body.code || res.status}: ${res.body.error || 'failed'}`, 'error');
}

let flashTimer = null;
function flash(text, kind = '') {
  const node = el('div', { class: `flash ${kind}`, text });
  document.getElementById('flash').replaceChildren(node);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => node.remove(), 4000);
}

function renderStatus() {
  const wired = Object.entries(state.providers).filter(([, p]) => p.configured).map(([n]) => n);
  const parkText = parkError
    ? `park: ${parkError}`
    : `park: ${parkStatus.renderer} · assets ${parkStatus.assets} · ranger ${parkStatus.ranger} · ${parkStatus.fps} fps · seed ${state.layout.seed || '?'}`;
  setChildren(status,
    el('span', { class: `dot ${state.connected ? 'on' : 'off'}` }),
    el('span', { text: state.connected ? 'events: connected' : 'events: reconnecting' }),
    el('span', { class: 'sep' }),
    el('span', { text: `seq ${state.lastSeq}` }),
    el('span', { class: 'sep' }),
    el('span', { text: wired.length ? `providers: ${wired.join(', ')}` : 'no provider wired (start Ollama, or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY, then restart)' }),
    el('span', { class: 'sep' }),
    el('span', { class: state.workspace && !state.workspace.online ? 'warn' : '', text: state.workspace ? (state.workspace.online ? 'workspace: online' : `workspace: OFFLINE (${state.workspace.reason || 'unreachable'}) · runs paused`) : 'workspace: unknown' }),
    el('span', { class: 'sep' }),
    el('span', { class: parkError || parkStatus.problems.length ? 'warn' : '', text: parkText, title: parkStatus.problems.join('\n') }),
    el('span', { class: 'sep' }),
    el('span', { text: state.keystore.broker ? 'secrets: Keychain (via the app)' : 'secrets: keystore file (dev)' }),
    state.keystore.problem ? el('span', { class: 'warn', text: ` · keystore: ${state.keystore.problem}` }) : null,
    state.invalidEvents ? el('span', { class: 'warn', text: ` · ${state.invalidEvents} invalid event(s) rejected` }) : null,
  );
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStatus();
    renderCameraBar();
    comms.render();
    spend.render();
    build.render();
    permission.render();
    inspect.render();
    firstRun.render();
  });
}

function setState(next) {
  state = next;
  render();
}

async function loadPark() {
  try {
    const { createPark } = await import('./park/render.js');
    park = await createPark({
      container: parkEl,
      getState,
      onPick,
      onStatus: (s) => {
        parkStatus = s;
        render();
      },
    });
  } catch (err) {
    parkError = /vendor\/three|Failed to fetch dynamically|resolve module specifier|three\.module/.test(String(err && (err.message || err)))
      ? 'renderer not vendored: run `npm run assets` and reload'
      : `renderer failed: ${err && err.message ? err.message : err}`;
    setChildren(parkEl, el('div', { class: 'park-missing', text: parkError }));
    console.error(err);
  }
  render();
}

async function main() {
  const snap = await loadToken();
  setState(applySnapshot(state, snap));
  connectEvents({
    since: snap.seq || 0,
    onEvent: (event) => setState(applyEvent(state, event)),
    onStatus: async (connected) => {
      setState({ ...state, connected });
      if (connected) {
        try {
          setState(applySnapshot(state, await loadToken())); // a restarted sidecar has a new token
        } catch {
          /* the next reconnect tries again */
        }
      }
    },
  });
  await loadPark();
}

main().catch((err) => {
  status.textContent = `failed to load: ${err.message}`;
});

// Diagnostics hook for scripts/park-check.mjs (read-only: state and the park handle), and
// `refresh(snapshot)` for panels that want the sidecar's snapshot applied after an action.
window.maka = { getState, park: () => park, refresh: async (snap) => setState(applySnapshot(state, snap)) };
