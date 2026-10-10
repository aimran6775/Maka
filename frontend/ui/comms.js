// COMMS window: start/cancel runs, pick provider and model, watch the streaming transcript.
// Everything shown here comes from events or the /api/state snapshot; "not wired" is shown
// verbatim when a provider has no key.

import { el, createWindow, fmtUsd } from './windows.js';
import { currentRun, grantedTools } from '../state.js';

export function createComms({ parent, getState, api, x, y, w }) {
  const { body } = createWindow({ id: 'comms', title: 'COMMS', x, y, w, parent });

  const providerSel = el('select', { class: 'sel' });
  const modelInput = el('input', { class: 'inp', placeholder: 'model (default per provider)' });
  const turns = el('input', { class: 'inp num', type: 'number', min: 1, max: 50, value: 8, title: 'max turns' });
  const budget = el('input', { class: 'inp num', type: 'number', min: 0, step: 0.05, value: 1, title: 'budget USD' });
  const prompt = el('textarea', { class: 'prompt', rows: 3, placeholder: 'Brief for the Ranger (Ctrl+Enter to run)' });
  const runBtn = el('button', { class: 'btn primary', text: 'Run', onclick: () => start() });
  const cancelBtn = el('button', { class: 'btn', text: 'Cancel', disabled: true, onclick: () => cancel() });
  const grants = el('div', { class: 'grants' });
  const notice = el('div', { class: 'notice' });
  const log = el('div', { class: 'log' });

  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
  });

  body.append(
    el('div', { class: 'row' }, el('label', { text: 'provider' }), providerSel, modelInput),
    el('div', { class: 'row' }, el('label', { text: 'turns' }), turns, el('label', { text: 'budget $' }), budget),
    grants,
    prompt,
    el('div', { class: 'row' }, runBtn, cancelBtn, notice),
    log,
  );

  let lastRenderedRun = null;
  let lastItemCount = -1;
  let lastStatus = null;

  async function start() {
    const state = getState();
    const text = prompt.value.trim();
    if (!text) return setNotice('Type a prompt first.', 'warn');
    const agent = state.layout.agents[0];
    if (!agent) return setNotice('No Ranger in the park layout.', 'warn');
    runBtn.disabled = true;
    setNotice('Starting…');
    const res = await api.post('/api/run', {
      agentId: agent.id,
      prompt: text,
      provider: providerSel.value || undefined,
      model: modelInput.value.trim() || undefined,
      maxTurns: Number(turns.value) || 8,
      budgetUsd: Number(budget.value) || 0,
    });
    if (!res.ok) {
      setNotice(`${res.body.code || res.status}: ${res.body.error || 'request failed'}`, 'error');
      runBtn.disabled = false;
      return;
    }
    setNotice(`Run ${res.body.runId} started on ${res.body.provider} / ${res.body.model}${res.body.tier ? ` (${res.body.tier} tier)` : ' (explicit provider, no tier)'}.`);
  }

  async function cancel() {
    const state = getState();
    if (!state.activeRun) return;
    cancelBtn.disabled = true;
    await api.post('/api/cancel', { runId: state.activeRun.runId });
    setNotice('Cancel requested.');
  }

  function setNotice(text, kind = '') {
    notice.textContent = text;
    notice.className = `notice ${kind}`;
  }

  function renderProviders(state) {
    const names = Object.keys(state.providers);
    const current = providerSel.value;
    const worker = state.policy && state.policy.tiers ? state.policy.tiers.worker : null;
    const workerLabel = worker ? `${worker.provider}${worker.model ? '/' + worker.model : ''}` : '?';
    providerSel.replaceChildren(
      el('option', { value: '', text: `route by policy (worker tier: ${workerLabel})` }),
      ...names.map((name) => {
        const p = state.providers[name];
        let label = name;
        if (p.local) label = p.reachable ? `${name} (local, ${p.models.length} model${p.models.length === 1 ? '' : 's'})` : `${name} (not reachable at ${p.host})`;
        else if (!p.configured) label = `${name} (not wired: set ${p.envVar})`;
        if (p.tierHint) label += ` · ${p.tierHint}`;
        return el('option', { value: name, text: label });
      }),
    );
    providerSel.value = names.includes(current) ? current : '';
    const sel = state.providers[providerSel.value];
    if (!providerSel.value) modelInput.placeholder = worker && worker.model ? `model (policy: ${worker.model})` : 'model (policy default)';
    else modelInput.placeholder = sel ? (sel.defaultModel ? `model (default ${sel.defaultModel})` : 'model (none installed)') : 'model';
  }

  function renderItem(it) {
    if (it.kind === 'text') return el('div', { class: 'item text' }, it.text);
    if (it.kind === 'note') return el('div', { class: 'item note', text: it.text });
    if (it.kind === 'cost') {
      const who = `${it.tier ? it.tier + ' · ' : ''}${it.provider}/${it.model}`;
      const cost = it.reconciled ? fmtUsd(it.usd) : 'unpriced';
      return el('div', { class: 'item cost', text: `turn ${it.turn} · ${who} · ${it.inputTokens} in / ${it.outputTokens} out · ${cost}` });
    }
    const res = it.result;
    const status = !res ? 'running' : res.ok ? 'ok' : 'failed';
    const details = el('details', { class: `item tool ${status}` },
      el('summary', {}, el('span', { class: 'tool-name', text: it.name }), ' ', el('span', { class: 'tool-status', text: status })),
      el('pre', { class: 'tool-io', text: `input: ${JSON.stringify(it.input, null, 1)}` }),
      res ? el('pre', { class: 'tool-io', text: res.ok ? `output: ${truncate(res.output || '', 4000)}` : `error: ${res.error || ''}` }) : null,
    );
    if (!res || !res.ok) details.open = true;
    return details;
  }

  function render() {
    const state = getState();
    renderProviders(state);
    const agent = state.layout.agents[0];
    const granted = agent ? grantedTools(state, agent.id) : [];
    grants.replaceChildren(
      el('span', { class: 'muted', text: agent ? `${agent.name} can use: ` : 'no Ranger' }),
      granted.length ? el('span', { text: granted.join(', ') }) : el('span', { class: 'muted', text: 'nothing (place fixtures in BUILD)' }),
    );
    const active = Boolean(state.activeRun);
    runBtn.disabled = active || !state.connected;
    cancelBtn.disabled = !active;

    const run = currentRun(state);
    if (!run) {
      if (lastRenderedRun !== null) log.replaceChildren();
      lastRenderedRun = null;
      return;
    }
    if (run.runId !== lastRenderedRun) {
      lastRenderedRun = run.runId;
      lastItemCount = -1;
      lastStatus = null;
      log.replaceChildren(
        el('div', { class: 'run-head' }, el('b', { text: run.runId }), ` · ${run.provider} / ${run.model} · tools: ${run.tools.join(', ') || 'none'}`),
        el('div', { class: 'item user', text: run.prompt }),
        el('div', { class: 'items' }),
        el('div', { class: 'run-foot' }),
      );
    }
    const items = log.querySelector('.items');
    // Re-render items (cheap at phase 1 sizes) only when something changed.
    const signature = `${run.items.length}:${run.items.map((i) => (i.kind === 'text' ? i.text.length : i.result ? 'r' : 'p')).join(',')}`;
    if (signature !== lastItemCount) {
      lastItemCount = signature;
      items.replaceChildren(...run.items.map(renderItem));
      log.scrollTop = log.scrollHeight;
    }
    const statusText = run.status === 'running'
      ? `running · turn ${run.turns || 1}`
      : run.status === 'error'
        ? `error: ${run.error ? run.error.message : 'unknown'}`
        : `ended: ${run.reason} · ${run.turns} turn${run.turns === 1 ? '' : 's'} · ${run.usage.inputTokens} in / ${run.usage.outputTokens} out · ${fmtUsd(run.spentUsd)} reconciled${run.unreconciledTurns ? ` · ${run.unreconciledTurns} turn(s) unpriced` : ''}`;
    if (statusText !== lastStatus) {
      lastStatus = statusText;
      const foot = log.querySelector('.run-foot');
      foot.textContent = statusText;
      foot.className = `run-foot ${run.status}`;
    }
  }

  return { render };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;
}
