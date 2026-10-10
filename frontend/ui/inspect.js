// INSPECT window: the card for whatever was clicked in the park. Shows only what the
// harness has emitted this session: no projections, no placeholders for phase 2 features.
import { el, createWindow, setChildren, fmtUsd } from './windows.js';
import { grantedTools, toolUses, lastModel } from '../state.js';
import { LEASH_LEVEL_LABELS } from '../../shared/leash.js';

export function createInspect({ parent, getState, x, y, w }) {
  const { body, setTitle } = createWindow({ id: 'inspect', title: 'INSPECT', x, y, w, parent });
  let selection = null;

  const row = (k, v, cls = '') => el('div', { class: `kv ${cls}` }, el('span', { class: 'k', text: k }), el('span', { class: 'v' }, v));

  function renderAgent(s, agent) {
    setTitle(`INSPECT · ${agent.name}`);
    const st = s.agentStates[agent.id] || 'idle';
    const runId = s.agentRuns[agent.id];
    const run = runId ? s.runs[runId] : null;
    const model = lastModel(run);
    const leash = s.leash && s.leash.domains ? Object.entries(s.leash.domains) : [];
    return [
      row('state', st),
      row('zone', (s.layout.rooms.find((r) => r.id === agent.roomId) || {}).name || agent.roomId),
      row('tools', grantedTools(s, agent.id).join(', ') || 'none (place fixtures in BUILD)'),
      row('run', run ? `${run.runId} · ${run.status}${run.reason ? ` (${run.reason})` : ''}` : 'no run yet'),
      run ? row('brief', run.prompt) : null,
      row('model', model ? `${model.tier ? model.tier + ' · ' : ''}${model.provider}/${model.model}` : run ? `${run.provider}/${run.model} (no turn finished yet)` : '—'),
      run ? row('spend', `${fmtUsd(run.spentUsd)} reconciled${run.unreconciledTurns ? ` · ${run.unreconciledTurns} unpriced turn(s)` : ''}`) : null,
      el('div', { class: 'k', text: 'leash (per domain, not yet enforced)' }),
      leash.length
        ? el('div', { class: 'leash' }, ...leash.map(([d, v]) => el('div', { class: 'kv' }, el('span', { class: 'k', text: d }), el('span', { class: 'v', text: `${LEASH_LEVEL_LABELS[v.level] || v.level}${v.dailyCapUsd !== undefined ? ` · cap $${v.dailyCapUsd}/day` : ''}` }))))
        : el('div', { class: 'muted', text: 'no leash policy loaded' }),
    ];
  }

  function renderZone(s, room) {
    setTitle(`INSPECT · ${room.name}`);
    const roster = s.layout.agents.filter((a) => a.roomId === room.id);
    const fixtures = s.layout.objects.filter((o) => o.roomId === room.id);
    return [
      row('size', `${room.w} × ${room.h} tiles`),
      row('rangers', roster.length ? roster.map((a) => `${a.name} (${s.agentStates[a.id] || 'idle'})`).join(', ') : 'none'),
      row('fixtures', fixtures.length ? fixtures.map((o) => `${(s.objectKinds[o.kind] || {}).label || o.kind} @ ${o.x},${o.y}`).join('; ') : 'none'),
      row('grants', [...new Set(fixtures.flatMap((o) => (s.objectKinds[o.kind] || {}).grants || []))].sort().join(', ') || 'none'),
      el('div', { class: 'muted small', text: 'Queues, budgets and trails arrive with phase 2.' }),
    ];
  }

  function renderObject(s, obj) {
    const def = s.objectKinds[obj.kind] || { label: obj.kind, grants: [], hint: '' };
    setTitle(`INSPECT · ${def.label}`);
    const uses = toolUses(s, def.grants || []);
    return [
      row('grants', (def.grants || []).join(', ')),
      row('zone', (s.layout.rooms.find((r) => r.id === obj.roomId) || {}).name || obj.roomId),
      el('div', { class: 'muted small', text: def.hint || '' }),
      el('div', { class: 'k', text: `tool calls through it this session: ${uses.length}` }),
      ...uses.slice(-20).reverse().map((u) => el('div', { class: `use ${u.ok === null ? 'running' : u.ok ? 'ok' : 'failed'}`, text: `${u.name} · ${u.ok === null ? 'running' : u.ok ? 'ok' : 'failed'} · ${JSON.stringify(u.input).slice(0, 60)}` })),
    ];
  }

  function renderGate(s, room) {
    setTitle('INSPECT · Entrance Gate');
    const pending = s.pendingPrompts;
    return [
      row('zone', room.name),
      row('waiting on you', pending.length ? pending.map((q) => `${q.tool} (${q.runId})`).join('; ') : 'nothing'),
      el('div', { class: 'muted small', text: 'Approvals appear as cards at the top of the park. Phase 1 gates file writes; money-out and connector actions are phase 2.' }),
    ];
  }

  return {
    select(info) {
      selection = info;
      this.render();
    },
    render() {
      const s = getState();
      if (!selection) {
        setTitle('INSPECT');
        setChildren(body, el('div', { class: 'muted', text: 'Click a Ranger, a fixture, the Entrance Gate or a zone.' }));
        return;
      }
      if (selection.type === 'agent') {
        const agent = s.layout.agents.find((a) => a.id === selection.agent.id);
        if (!agent) return this.select(null);
        return setChildren(body, ...renderAgent(s, agent));
      }
      if (selection.type === 'object') {
        const obj = s.layout.objects.find((o) => o.id === selection.object.id);
        if (!obj) return this.select(null);
        return setChildren(body, ...renderObject(s, obj));
      }
      if (selection.type === 'zone' || selection.type === 'gate') {
        const room = s.layout.rooms.find((r) => r.id === selection.room.id);
        if (!room) return this.select(null);
        return setChildren(body, ...(selection.type === 'gate' ? renderGate(s, room) : renderZone(s, room)));
      }
    },
  };
}
