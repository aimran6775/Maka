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
import { createVoice } from './ui/voice.js';
import { createNav } from './ui/nav.js';
import { el, setChildren } from './ui/windows.js';
import { tileToWorld, TILE_WORLD } from './park/placement.js';
import { parkOptions } from './park/gpu.js';
import { isTyping } from './park/controls.js';

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
  // A non-JSON body (phase 4 step 14: audio for the recogniser) with the same token.
  async raw(path, body, contentType) {
    if (!apiToken) await loadToken();
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': contentType, 'x-maka-token': apiToken || '' }, body });
    let parsed = {};
    try {
      parsed = await res.json();
    } catch {
      /* no body */
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
  if (info && info.type === 'ground') {
    nav.setWhere('the park');
    return inspect.select(null);
  }
  inspect.select(info);
  // The bar says where you are looking, so a click is not the only record of it.
  const named =
    info && info.type === 'agent' ? (info.agent && info.agent.name) || 'a Ranger'
    : info && info.type === 'zone' ? (info.room && info.room.name) || 'a zone'
    : info && info.type === 'gate' ? 'Entrance Gate'
    : info && info.type === 'peak' ? 'Mountain Peak'
    : info && info.type === 'trail' ? 'a trail'
    : info && info.type === 'object' ? 'a fixture'
    : null;
  if (named) nav.setWhere(named);
  if (info && info.type === 'agent' && park) park.follow(info.agent.id);
}

// The panels dock into two rails (D167) instead of floating at fixed pixel positions,
// where they overlapped each other and covered the park. Left is the work you are doing,
// right is what the park is telling you.
const railLeft = el('div', { class: 'rail left' });
const railRight = el('div', { class: 'rail right' });
ui.append(railLeft, railRight);

const comms = createComms({ parent: railLeft, getState, api, x: 0, y: 0, w: 348 });
const spend = createSpend({ parent: railRight, getState, x: 0, y: 0, w: 278 });
const build = createBuild({ parent: railRight, getState, world: { setBuild() { render(); } }, x: 0, y: 0, w: 278 });
const permission = createPermission({ parent: ui, getState, api });
const inspect = createInspect({ parent: railRight, getState, api, x: 0, y: 0, w: 278 });
const firstRun = createFirstRun({ parent: ui, getState, api, onRefresh: () => render() });
// Voice (phase 4 step 14): hold to talk, the transcript shown before anything acts on it,
// the station voice for Gate items and the Peak's answers when switched on.
const voice = createVoice({ parent: ui, getState, api, onMission: (text) => { inspect.setMissionDraft(text); } });

// The navigation bar: where you are, the Jump to menu, the camera modes and the keys.
const nav = createNav({ parent: ui, getState, getPark: () => park, api, onFlash: (x, kind) => (typeof x === 'string' ? flash(x, kind) : showError(x)) });

// The park's own keys live in render.js (it needs them every frame); these are the ones
// that drive the page: jumping, the landmarks, the modes and the legend. The table a
// person reads is park/controls.js KEY_MAP, which render.js listens to.
window.addEventListener('keydown', (e) => {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === '?' || (k === '/' && e.shiftKey)) return nav.toggleKeys();
  if (k === 'escape') {
    nav.toggleKeys(false);
    inspect.select(null);
    return;
  }
  if (!park) return;
  if (k === 'j') { e.preventDefault(); return nav.openJump(); }
  if (k === 'p') return nav.goToKind('peak');
  if (k === 'g') return nav.goToKind('gate');
  if (k === 'h') return nav.goToKind('home');
  if (k === 'f') { park.setCameraMode('follow'); return render(); }
  if (k === '1' || k === '2' || k === '3') {
    park.setCameraMode({ 1: 'orbit', 2: 'fly', 3: 'follow' }[k]);
    render();
  }
});

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
    nav.render();
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

async function loadPark(overrides = {}) {
  try {
    const { createPark } = await import('./park/render.js');
    // Phase 4 step 15: `?renderer=webgl2|webgpu`, `?lod=off`, `?density=N`, `?dev=1` (the
    // frame-time overlay) come from the page's query; a normal page carries none. A lost
    // WebGPU device restarts the park on WebGL2 with the reason in the status line.
    park = await createPark({
      container: parkEl,
      getState,
      onPick,
      options: { ...parkOptions(Object.fromEntries(new URL(window.location.href).searchParams)), ...overrides },
      onDeviceLost: ({ reason, message }) => {
        if (park) park.destroy();
        park = null;
        flash(`${reason} (${message}); the park restarts on WebGL2`, 'warn');
        loadPark({ renderer: 'webgl2', fellBack: reason });
      },
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
    onEvent: (event) => {
      setState(applyEvent(state, event));
      voice.onEvent(event);
    },
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
