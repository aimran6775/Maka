// Frontend entry: load the snapshot, subscribe to events, render world + windows.
import { initialState, applySnapshot, applyEvent } from './state.js';
import { connectEvents } from './events.js';
import { createWorld } from './world.js';
import { theme } from './theme/park.js';
import { createComms } from './ui/comms.js';
import { createSpend } from './ui/spend.js';
import { createBuild } from './ui/build.js';
import { createPermission } from './ui/permission.js';
import { el, setChildren } from './ui/windows.js';

let state = initialState();
const getState = () => state;

const api = {
  async post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let parsed = {};
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  },
};

const canvas = document.getElementById('world');
const status = document.getElementById('status');
const ui = document.getElementById('ui');

const world = createWorld({
  canvas,
  theme,
  getState,
  // Keep the park clear of the windows that sit on the left and right edges.
  insets: () => ({ left: window.innerWidth > 900 ? 470 : 0, right: window.innerWidth > 900 ? 300 : 0, top: 0, bottom: 0 }),
  onPlace: (roomId, x, y) => build.activeKind() && api.post('/api/layout/place', { kind: build.activeKind(), roomId, x, y }).then(showError),
  onReclaim: (objectId) => api.post('/api/layout/reclaim', { objectId }).then(showError),
  onPick: (info) => {
    if (!info) return;
    if (info.type === 'object') {
      const def = state.objectKinds[info.object.kind];
      flash(`${def ? def.label : info.object.kind}: grants ${def ? def.grants.join(', ') : '?'} to Rangers in this zone`);
    } else if (info.type === 'agent') {
      flash(`${info.agent.name}: ${describeState(state.agentStates[info.agent.id] || 'idle')}`);
    }
  },
});

const comms = createComms({ parent: ui, getState, api, x: 16, y: 16, w: 440 });
const spend = createSpend({ parent: ui, getState, x: window.innerWidth - 300, y: 16, w: 270 });
const build = createBuild({ parent: ui, getState, world, x: window.innerWidth - 300, y: 190, w: 270 });
const permission = createPermission({ parent: ui, getState, api });

function describeState(st) {
  return { idle: 'idle', thinking: 'thinking (model turn in progress)', 'tool-running': 'running a tool', waiting: 'waiting on you at the Entrance Gate', done: 'done', error: 'stopped on an error' }[st] || st;
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
  setChildren(status,
    el('span', { class: `dot ${state.connected ? 'on' : 'off'}` }),
    el('span', { text: state.connected ? 'events: connected' : 'events: reconnecting' }),
    el('span', { class: 'sep' }),
    el('span', { text: `seq ${state.lastSeq}` }),
    el('span', { class: 'sep' }),
    el('span', { text: wired.length ? `providers: ${wired.join(', ')}` : 'no provider wired (start Ollama, or set ANTHROPIC_API_KEY / OPENROUTER_API_KEY, then restart)' }),
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
    comms.render();
    spend.render();
    build.render();
    permission.render();
    world.render();
  });
}

function setState(next) {
  state = next;
  render();
}

async function main() {
  const res = await fetch('/api/state');
  const snap = await res.json();
  setState(applySnapshot(state, snap));
  connectEvents({
    since: snap.seq || 0,
    onEvent: (event) => setState(applyEvent(state, event)),
    onStatus: async (connected) => {
      setState({ ...state, connected });
      if (connected) {
        // Resync the snapshot after a reconnect: the layout or spend may have moved on.
        const r = await fetch('/api/state');
        if (r.ok) setState(applySnapshot(state, await r.json()));
      }
    },
  });
}

main().catch((err) => {
  status.textContent = `failed to load: ${err.message}`;
});
