// The first-run card (phase 3 step 3): shown over the park until the Superintendent
// finishes or skips it. Four steps, each read from the sidecar and acted on through its
// routes; nothing here is assumed: the workspace candidates say whether the LaCie is
// mounted, the key says whether the provider accepted it, the worker shows Ollama as
// found or not with the models it really has and a pull's real byte counts, and the
// mission goes to the Chief who is already standing at the Peak.
import { el, setChildren } from './windows.js';
import { workerLines } from './worker.js';

export function createFirstRun({ parent, getState, api, onRefresh }) {
  const host = el('div', { class: 'firstrun-host', hidden: true });
  parent.append(host);
  const notes = { workspace: '', judge: '', worker: '', mission: '' };
  let busy = false;
  let detail = null; // the latest /api/setup answer (candidates, memory, …)
  let lastKey = '';

  async function load() {
    const r = await api.get('/api/setup');
    if (r.ok) {
      detail = r.body;
      if (onRefresh) onRefresh();
    }
  }

  async function act(step, label, req) {
    busy = true;
    notes[step] = `${label}…`;
    render();
    try {
      const r = await req();
      notes[step] = r.ok ? `${label}: ok${r.body && r.body.note ? ` · ${r.body.note}` : ''}` : `${label}: ${r.body.code || r.status}: ${r.body.error || 'failed'}`;
      await load();
      return r;
    } finally {
      busy = false;
      render();
    }
  }

  const rootInput = el('input', { class: 'inp', placeholder: '/Volumes/LaCie/Maka/workspace' });
  const keyInput = el('input', { class: 'inp', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off' });
  const providerSel = el('select', { class: 'sel' }, el('option', { value: 'anthropic', text: 'Anthropic (Claude, the judge)' }), el('option', { value: 'openrouter', text: 'OpenRouter' }));
  const missionText = el('textarea', { class: 'prompt', rows: 3, placeholder: 'What should the crew build? One venture to start, in plain words.' });
  const budgetInput = el('input', { class: 'inp num', type: 'number', min: '0', step: '0.5', value: '3' });
  const horizonInput = el('input', { class: 'inp', value: '30 days' });

  function stepHead(n, title, done) {
    return el('div', { class: `fr-head ${done ? 'done' : ''}` }, el('span', { class: 'fr-num', text: done ? '✓' : String(n) }), el('span', { text: title }));
  }

  function workspaceStep(s, st) {
    const ws = st.workspace || {};
    const cands = ws.candidates || [];
    if (!rootInput.value && cands.length) rootInput.value = (cands.find((c) => c.default) || cands[0]).path;
    const done = Boolean(st.steps && st.steps.workspace);
    return el('div', { class: 'fr-step' },
      stepHead(1, 'Where the crew works', done),
      el('div', { class: 'muted small', text: 'Every Ranger\'s files, the mail store, browser profiles and deliverables live under this folder. The sidecar restarts when it changes; the page reconnects by itself.' }),
      ...cands.map((c) => el('div', { class: 'row' }, el('button', { class: 'btn small', text: 'use', disabled: busy || !c.mounted || !c.writable, onclick: () => { rootInput.value = c.path; render(); } }), el('span', { class: 'small', text: `${c.label}: ${c.path}` }), el('span', { class: `small ${c.mounted ? 'muted' : 'warn'}`, text: c.label === 'LaCie external drive' ? (c.mounted ? (c.writable ? '· mounted' : '· mounted, not writable') : '· not mounted') : '' }))),
      el('div', { class: 'row' }, rootInput, el('button', { class: 'btn primary', text: 'Use this folder', disabled: busy, onclick: () => act('workspace', 'Workspace', () => api.post('/api/setup/workspace', { root: rootInput.value.trim() })) })),
      el('div', { class: 'small muted', text: `current: ${ws.root || '—'}${s.workspace && !s.workspace.online ? ' (OFFLINE)' : ''}` }),
      el('div', { class: 'notice', text: notes.workspace }),
    );
  }

  function judgeStep(s, st) {
    const j = st.judge || {};
    const done = Boolean(j.anthropic || j.openrouter);
    return el('div', { class: 'fr-step' },
      stepHead(2, 'The judge: a Claude API key', done),
      el('div', { class: 'muted small', text: 'Claude reviews the Rangers\' actions before they pass the Gate, plans with the Chief and writes the reflections. Paste a key from console.anthropic.com; Maka checks it with the provider before storing it in the Keychain (the 0600 keystore file without the app). There is no sign-in: Anthropic issues keys from the console only.' }),
      el('div', { class: 'row' }, providerSel, keyInput, el('button', { class: 'btn primary', text: 'Save key', disabled: busy, onclick: async () => { const key = keyInput.value.trim(); if (!key) return (notes.judge = 'Paste a key first.', render()); lastKey = key; const r = await act('judge', 'Key', () => api.post('/api/setup/key', { provider: providerSel.value, key })); if (r.ok) { keyInput.value = ''; notes.judge = r.body.verified ? `Key: stored and verified by ${r.body.provider}` : `Key: stored, not verified (${r.body.reason})`; render(); } } })),
      el('div', { class: 'small muted', text: `anthropic: ${j.anthropic ? 'configured' : 'not wired'} · openrouter: ${j.openrouter ? 'configured' : 'not wired'}${j.verified ? ` · ${j.verified}` : ''}` }),
      el('div', { class: 'notice', text: notes.judge }),
    );
  }

  function workerStep(s, st) {
    const w = st.worker || s.ollama || null;
    const done = Boolean(w && w.reachable && w.chosen);
    return el('div', { class: 'fr-step' },
      stepHead(3, 'The worker: a local model in Ollama', done),
      el('div', { class: 'muted small', text: 'Routine turns run on a local open-weight model at no marginal cost, 24/7. The model must support tool calling; the judge catches errors, it does not make a weak worker strong.' }),
      ...workerLines({ s, w, api, act, busy }),
      el('div', { class: 'notice', text: notes.worker }),
    );
  }

  function missionStep(s, st) {
    const m = st.mission || {};
    const done = Boolean(m.briefed);
    return el('div', { class: 'fr-step' },
      stepHead(4, 'The mission', done),
      el('div', { class: 'muted small', text: m.chief ? `${m.chief.name} is already standing at the Mountain Peak. Say what the business is; the Chief plans on Claude, hires Rangers into camps and delegates the first tasks within this budget.` : 'The Chief Ranger is created at boot; the sidecar did not report one.' }),
      missionText,
      el('div', { class: 'row' }, el('label', { text: 'model-spend budget $' }), budgetInput, el('label', { text: 'horizon' }), horizonInput, el('button', { class: 'btn primary', text: 'Brief the Chief', disabled: busy || done, onclick: () => { const text = missionText.value.trim(); if (!text) return (notes.mission = 'Write the mission first.', render()); act('mission', 'Mission', () => api.post('/api/mission', { text, budgetUsd: Number(budgetInput.value) || 0, horizon: horizonInput.value.trim() || '30 days' })); } })),
      done ? el('div', { class: 'small', text: `mission ${m.status || 'briefed'}: the Chief is planning; watch the Peak.` }) : null,
      el('div', { class: 'notice', text: notes.mission }),
    );
  }

  function render() {
    const s = getState();
    const st = detail || s.setup;
    if (!s.setup || !s.setup.firstRun) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    setChildren(host, el('div', { class: 'firstrun' },
      el('div', { class: 'fr-title' }, el('span', { text: 'FIRST RUN' }), el('span', { class: 'muted small', text: ' · ten minutes to a working crew' })),
      workspaceStep(s, st || {}),
      judgeStep(s, st || {}),
      workerStep(s, st || {}),
      missionStep(s, st || {}),
      el('div', { class: 'row fr-foot' },
        el('button', { class: 'btn primary', text: 'Done', disabled: busy, onclick: () => act('mission', 'Done', () => api.post('/api/setup/complete', {})) }),
        el('button', { class: 'btn', text: 'Later (keep the park as it is)', disabled: busy, onclick: () => act('mission', 'Later', () => api.post('/api/setup/complete', { skipped: true })) }),
        el('span', { class: 'muted small', text: 'Everything here is also on the Peak card and in the status bar.' }),
      ),
    ));
  }

  let lastChanges = -1;
  return {
    render() {
      const s = getState();
      if (s.setup && s.setup.firstRun && (detail === null || s.setupChanges.length !== lastChanges)) {
        lastChanges = s.setupChanges.length;
        load();
      }
      render();
    },
    reload: load,
  };
}
