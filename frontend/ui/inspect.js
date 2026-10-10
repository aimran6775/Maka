// INSPECT window: the card for whatever was clicked in the park. Shows only what the
// harness has emitted this session: no projections, no placeholders for phase 2 features.
import { el, createWindow, setChildren, fmtUsd } from './windows.js';
import { grantedTools, toolUses, lastModel, pendingGate, recentGate, judgeVerdicts, workInTransit, workFor } from '../state.js';
import { LEASH_LEVEL_LABELS, LEASH_LEVELS, DOMAINS, resolveAllLeash, resolveLeash } from '../../shared/leash.js';

export function createInspect({ parent, getState, api, x, y, w }) {
  const { body, setTitle } = createWindow({ id: 'inspect', title: 'INSPECT', x, y, w, parent });
  let selection = null;

  const row = (k, v, cls = '') => el('div', { class: `kv ${cls}` }, el('span', { class: 'k', text: k }), el('span', { class: 'v' }, v));

  // Ranger actions (phase 2 step 7): brief (start a run), pause / resume, reassign to a zone.
  const briefText = el('textarea', { class: 'prompt', rows: 2, placeholder: 'Brief this Ranger (starts a run on the worker tier)' });
  const actionNotice = el('div', { class: 'notice' });
  async function act(label, req) {
    actionNotice.textContent = `${label}…`;
    const r = await req();
    actionNotice.textContent = r.ok ? `${label}: ok${r.body && r.body.queued ? ' (queued)' : ''}` : `${label}: ${r.body.code || r.status}: ${r.body.error || 'failed'}`;
    return r;
  }
  function agentActions(s, agent) {
    const busy = s.activeRuns.some((r) => r.agentId === agent.id) || s.queuedRuns.some((r) => r.agentId === agent.id);
    const zoneSel = el('select', { class: 'sel' }, ...s.layout.rooms.filter((r) => (r.kind === 'mountain_peak') === (agent.role === 'chief_ranger')).map((r) => el('option', { value: r.id, selected: r.id === agent.roomId ? '' : null, text: r.name })));
    return el('div', { class: 'mission-form' },
      briefText,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', text: 'Brief', disabled: agent.paused || !briefText.value.trim() && false, onclick: () => { const text = briefText.value.trim(); if (!text) return (actionNotice.textContent = 'Write a brief first.'); act('Brief', () => api.post('/api/run', { agentId: agent.id, prompt: text })); } }),
        agent.paused
          ? el('button', { class: 'btn', text: 'Resume', onclick: () => act('Resume', () => api.post(`/api/agents/${encodeURIComponent(agent.id)}/resume`, {})) })
          : el('button', { class: 'btn', text: busy ? 'Pause (stops its run)' : 'Pause', onclick: () => act('Pause', () => api.post(`/api/agents/${encodeURIComponent(agent.id)}/pause`, {})) }),
      ),
      el('div', { class: 'row' }, el('label', { text: 'reassign to' }), zoneSel, el('button', { class: 'btn', text: 'Move', onclick: () => act('Reassign', () => api.send('PATCH', `/api/agents/${encodeURIComponent(agent.id)}`, { zoneId: zoneSel.value })) })),
      actionNotice,
    );
  }

  function renderAgent(s, agent) {
    setTitle(`INSPECT · ${agent.name}`);
    const st = s.agentStates[agent.id] || 'idle';
    const runId = s.agentRuns[agent.id];
    const run = runId ? s.runs[runId] : null;
    const model = lastModel(run);
    const leash = s.leash ? Object.entries(resolveAllLeash(s.leash, { agentId: agent.id, roomId: agent.roomId })) : [];
    const waiting = pendingGate(s).filter((it) => it.agentId === agent.id);
    const parent = agent.parentAgentId ? (s.layout.agents.find((a) => a.id === agent.parentAgentId) || { name: agent.parentAgentId }).name : null;
    const reports = s.layout.agents.filter((a) => a.parentAgentId === agent.id);
    return [
      row('state', agent.paused ? `${st} · PAUSED` : st),
      row('role', `${(agent.role || 'ranger').replace('_', ' ')}${agent.specialty ? ` · ${agent.specialty}` : ''}${parent ? ` · reports to ${parent}` : ''}`),
      reports.length ? row('reports', reports.map((a) => `${a.name} (${a.role === 'junior_ranger' ? 'junior' : a.role})`).join(', ')) : null,
      agent.venture ? row('venture', agent.venture) : null,
      agent.persona ? row('persona', agent.persona) : null,
      row('zone', (s.layout.rooms.find((r) => r.id === agent.roomId) || {}).name || agent.roomId),
      row('tools', grantedTools(s, agent.id).join(', ') || 'none (place fixtures in BUILD)'),
      row('run', run ? `${run.runId} · ${run.status}${run.reason ? ` (${run.reason})` : ''}` : 'no run yet'),
      run ? row('brief', run.prompt) : null,
      row('model', model ? `${model.tier ? model.tier + ' · ' : ''}${model.provider}/${model.model}` : run ? `${run.provider}/${run.model} (no turn finished yet)` : '—'),
      run ? row('spend', `${fmtUsd(run.spentUsd)} reconciled${run.unreconciledTurns ? ` · ${run.unreconciledTurns} unpriced turn(s)` : ''}`) : null,
      run ? row('judge', judgeVerdicts(run).length ? judgeVerdicts(run).map((v) => `${v.scope} ${v.verdict}${v.notes ? ` (${v.notes})` : v.reason ? ` (${v.reason})` : ''}`).join('; ') : 'not consulted yet') : null,
      row('at the Gate', waiting.length ? waiting.map((it) => `${it.domain}: ${it.summary}`).join('; ') : 'nothing waiting'),
      row('spend', `${fmtUsd(s.spendByAgent[agent.id] || 0)} since the mission${typeof agent.budgetUsd === 'number' ? ` of $${agent.budgetUsd.toFixed(2)} budget` : ''}`),
      s.queuedRuns.some((r) => r.agentId === agent.id) ? row('queued', `${s.queuedRuns.filter((r) => r.agentId === agent.id).length} run(s) waiting for this Ranger`) : null,
      agentActions(s, agent),
      ...workFor(s, agent.id).slice(0, 8).map((it) => el('div', { class: `use ${it.status === 'done' ? 'ok' : it.status === 'failed' || it.status === 'cancelled' ? 'failed' : 'running'}`, text: `${it.fromAgentId === agent.id ? '→ ' + it.toAgentId : '← ' + it.fromAgentId} · ${it.status} · ${(it.brief || '').slice(0, 50)}${it.deliverables && it.deliverables.length ? ` · ${it.deliverables.length} file(s)` : ''}` })),
      el('div', { class: 'k', text: 'leash (per domain, enforced by the gate)' }),
      leash.length
        ? el('div', { class: 'leash' }, ...leash.map(([d, v]) => el('div', { class: 'kv' }, el('span', { class: 'k', text: d }), el('span', { class: 'v', text: `${LEASH_LEVEL_LABELS[v.level] || v.level}${typeof v.dailyCapUsd === 'number' ? ` · cap $${v.dailyCapUsd}/day` : ''}${typeof v.dailyCapActions === 'number' ? ` · ${v.dailyCapActions}/day` : ''}${v.scope !== 'park' ? ` (${v.scope})` : ''}${s.ledger && s.ledger.domains[d] ? ` · today $${s.ledger.domains[d].usd.toFixed(2)}, ${s.ledger.domains[d].actions} action(s)` : ''}` }))))
        : el('div', { class: 'muted', text: 'no leash policy loaded' }),
    ];
  }

  const zoneNotice = el('div', { class: 'notice' });
  async function setZoneLeash(roomId, domain, level) {
    const leash = JSON.parse(JSON.stringify(getState().leash || { version: 1, domains: {} }));
    leash.zones = leash.zones || {};
    leash.zones[roomId] = leash.zones[roomId] || { domains: {} };
    if (level === '') delete leash.zones[roomId].domains[domain];
    else {
      const prev = leash.zones[roomId].domains[domain] || {};
      leash.zones[roomId].domains[domain] = { ...prev, level };
    }
    if (!Object.keys(leash.zones[roomId].domains).length) delete leash.zones[roomId];
    const r = await api.send('PUT', '/api/leash', leash);
    zoneNotice.textContent = r.ok ? `leash for ${domain} ${level ? 'set to ' + (LEASH_LEVEL_LABELS[level] || level) : 'back to the park default'}` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`;
    if (r.ok) {
      const snap = await fetch('/api/state');
      if (snap.ok) selectionRefresh && selectionRefresh();
    }
  }
  let selectionRefresh = null;

  function renderZone(s, room) {
    setTitle(`INSPECT · ${room.name}`);
    const roster = s.layout.agents.filter((a) => a.roomId === room.id);
    const fixtures = s.layout.objects.filter((o) => o.roomId === room.id);
    const spent = roster.reduce((n, a) => n + (s.spendByAgent[a.id] || 0), 0);
    const budget = roster.reduce((n, a) => n + (typeof a.budgetUsd === 'number' ? a.budgetUsd : 0), 0);
    const zoneLeash = s.leash ? DOMAINS.map((d) => [d, resolveLeash(s.leash, { roomId: room.id }, d)]) : [];
    return [
      row('kind', room.kind ? room.kind.replace(/_/g, ' ') : 'zone'),
      room.venture ? row('venture', room.venture) : null,
      row('size', `${room.w} × ${room.h} tiles`),
      row('budget burn', `${fmtUsd(spent)} spent by its Rangers${budget ? ` of $${budget.toFixed(2)} in their budgets` : ' (no Ranger budgets set)'}`),
      row('rangers', roster.length ? roster.map((a) => `${a.name} (${s.agentStates[a.id] || 'idle'})`).join(', ') : 'none'),
      row('fixtures', fixtures.length ? fixtures.map((o) => `${(s.objectKinds[o.kind] || {}).label || o.kind} @ ${o.x},${o.y}`).join('; ') : 'none'),
      row('grants', [...new Set(fixtures.flatMap((o) => (s.objectKinds[o.kind] || {}).grants || []))].sort().join(', ') || 'none'),
      row('queue', `${workInTransit(s, room.id).length} work item(s) in transit here · ${s.queuedRuns.filter((r) => roster.some((a) => a.id === r.agentId)).length} run(s) queued`),
      ...workInTransit(s, room.id).slice(0, 6).map((it) => el('div', { class: 'use running', text: `${it.fromAgentId} → ${it.toAgentId} · ${(it.brief || '').slice(0, 60)}` })),
      el('div', { class: 'k', text: 'leash defaults for this zone (a Ranger override still wins)' }),
      el('div', { class: 'leash' }, ...zoneLeash.map(([d, v]) => el('div', { class: 'kv' },
        el('span', { class: 'k', text: d }),
        el('select', { class: 'sel small', onchange: (e) => setZoneLeash(room.id, d, e.target.value) },
          el('option', { value: '', selected: v.scope !== 'zone' ? '' : null, text: `park default (${LEASH_LEVEL_LABELS[resolveLeash({ ...s.leash, zones: {} }, {}, d).level]})` }),
          ...LEASH_LEVELS.map((l) => el('option', { value: l, selected: v.scope === 'zone' && v.level === l ? '' : null, text: LEASH_LEVEL_LABELS[l] })),
        ),
      ))),
      zoneNotice,
    ];
  }

  function renderTrail(s, trail) {
    setTitle('INSPECT · Trail');
    const name = (id) => ((s.layout.rooms.find((r) => r.id === id) || {}).name || id);
    const items = s.workOrder.map((id) => s.workItems[id]).filter((it) => it && (it.status === 'queued' || it.status === 'running') && ((it.fromRoomId === trail.from && it.toRoomId === trail.to) || (it.fromRoomId === trail.to && it.toRoomId === trail.from)));
    return [
      row('between', `${name(trail.from)} ↔ ${name(trail.to)}`),
      row('in transit', items.length ? `${items.length} work item(s)` : 'nothing right now'),
      ...items.map((it) => el('div', { class: 'use running', text: `${it.fromAgentId} → ${it.toAgentId} · ${(it.brief || '').slice(0, 80)}${it.deadline ? ` · by ${it.deadline}` : ''}` })),
      el('div', { class: 'muted small', text: 'A trail is a handoff lane: work items travel it when a Ranger delegates; the receiver walks it to collect the brief.' }),
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
    const prompts = s.pendingPrompts;
    const items = pendingGate(s);
    const recent = recentGate(s, 20);
    const name = (id) => ((s.layout.agents.find((a) => a.id === id) || {}).name || id);
    return [
      row('zone', room.name),
      row('waiting on you', `${items.length} Gate item(s)${prompts.length ? `, ${prompts.length} file write(s)` : ''}`),
      ...items.map((it) => el('div', { class: 'gate-row' },
        el('div', { class: 'use running', text: `${it.kind === 'proposal' ? 'proposal' : it.domain} · ${name(it.agentId)} · ${it.summary}` }),
        el('div', { class: 'row' },
          el('button', { class: 'btn small', text: 'Approve', onclick: () => api.post(`/api/gate/${encodeURIComponent(it.itemId)}`, { decision: 'approve' }) }),
          it.kind === 'proposal' ? null : el('button', { class: 'btn small', text: 'Revise', onclick: () => { const notes = window.prompt('Notes for the Ranger (revise):', '') || ''; api.post(`/api/gate/${encodeURIComponent(it.itemId)}`, { decision: 'revise', notes }); } }),
          el('button', { class: 'btn small', text: 'Reject', onclick: () => { const notes = it.kind === 'proposal' ? '' : window.prompt('Notes for the Ranger (reject):', '') || ''; api.post(`/api/gate/${encodeURIComponent(it.itemId)}`, { decision: 'reject', notes }); } }),
        ),
      )),
      ...prompts.map((q) => el('div', { class: 'use running', text: `${q.tool} (${q.runId})` })),
      el('div', { class: 'k', text: `recent decisions (${recent.length})` }),
      el('div', { class: 'gate-list' }, ...recent.map((it) => el('div', { class: `use ${['approved', 'allowed'].includes(it.status) ? 'ok' : ['rejected', 'refused', 'expired'].includes(it.status) ? 'failed' : ''}`, text: `${it.status} · ${it.domain} · ${name(it.agentId)} · ${it.summary}${it.notes ? ` — ${it.notes}` : ''}` }))),
      s.ledger ? row('today', Object.entries(s.ledger.domains).map(([d, v]) => `${d}: ${v.actions} action(s), $${v.usd.toFixed(2)}`).join('; ') || 'no leash-domain actions yet') : null,
      el('div', { class: 'muted small', text: 'Cards at the top of the park take the decision. Approve runs the action; Revise and Reject answer the Ranger with your notes.' }),
    ];
  }

  const missionText = el('textarea', { class: 'prompt', rows: 3, placeholder: 'Mission for the Chief Ranger (what business, what matters, what not to do)' });
  const missionBudget = el('input', { class: 'inp num', type: 'number', min: 0, step: 1, value: 5, title: 'model-spend budget USD' });
  const missionHorizon = el('input', { class: 'inp', value: '30 days', title: 'horizon' });
  const missionNotice = el('div', { class: 'notice' });
  async function briefChief() {
    const text = missionText.value.trim();
    if (!text) return (missionNotice.textContent = 'Write the mission first.');
    missionNotice.textContent = 'Briefing the Chief…';
    const r = await api.post('/api/mission', { text, budgetUsd: Number(missionBudget.value) || 0, horizon: missionHorizon.value.trim() || '30 days' });
    missionNotice.textContent = r.ok ? `Mission ${r.body.mission.id} briefed; the Chief is ${r.body.queued ? 'queued' : r.body.runId ? 'planning' : 'paused (' + (r.body.mission.reason || 'see Peak') + ')'}.` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`;
  }
  const missionForm = el('div', { class: 'mission-form' },
    missionText,
    el('div', { class: 'row' }, el('label', { text: 'budget $' }), missionBudget, el('label', { text: 'horizon' }), missionHorizon, el('button', { class: 'btn primary', text: 'Brief the Chief', onclick: briefChief })),
    missionNotice,
  );

  function renderPeak(s) {
    setTitle('INSPECT · Mountain Peak');
    const runs = s.runOrder.map((id) => s.runs[id]).reverse();
    const m = s.mission || {};
    const mission = m.mission || null;
    const plan = m.plan || null;
    const refl = s.reflection || {};
    const latest = refl.latest || null;
    const alerts = s.budgetAlerts.slice(-5).reverse();
    const away = s.away || null;
    const pendingNow = pendingGate(s).length;
    return [
      away ? row('away', away.away ? `Away since ${new Date(away.since).toLocaleString()}, ${away.actions} action(s), ${pendingNow} waiting` : `you are here${away.lastDigest ? ` · last digest: ${away.lastDigest.summary || `${away.lastDigest.actions} action(s), ${away.lastDigest.waiting} waiting`} (${away.lastDigest.path})` : ''}`) : null,
      away ? el('div', { class: 'row' }, el('button', { class: `btn ${away.away ? 'primary' : ''}`, text: away.away ? "I'm back" : "I'm away", onclick: async () => { const r = await api.post('/api/away', { away: !away.away }); missionNotice.textContent = r.ok ? (r.body.digest ? `Digest written: ${r.body.digest.path}` : 'Away mode on: every Gate decision is logged as evidence.') : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } })) : null,
      el('div', { class: 'muted small', text: 'The control centre: the Chief Ranger\'s mission and plan, the Gate queue, spend. Connector ledgers and the reflection cycle arrive in later steps.' }),
      row('mission', mission ? `${mission.status}${mission.reason ? ` (${mission.reason})` : ''} · ${(mission.text || '').slice(0, 160)}` : 'none yet: brief the Chief below'),
      plan ? row('plan', `v${plan.version} · ${(plan.summary || '').slice(0, 200)}`) : row('plan', 'no plan submitted yet'),
      row('ventures', plan && plan.ventures && plan.ventures.length ? plan.ventures.map((v) => `${v.name}: ${fmtUsd(s.layout.agents.filter((a) => a.venture === v.id).reduce((n, a) => n + (s.spendByAgent[a.id] || 0), 0))} of $${(v.budgetUsd || 0).toFixed(2)}, ${v.taskCount ?? (v.tasks ? v.tasks.length : 0)} task(s), ${s.layout.agents.filter((a) => a.venture === v.id).length} Ranger(s)`).join('; ') : 'no ventures yet'),
      plan && plan.needsSuperintendent && plan.needsSuperintendent.length ? row('needs you', plan.needsSuperintendent.join('; ')) : null,
      missionForm,
      row('reflection', latest ? `${latest.status}${latest.skipReason ? ` (${latest.skipReason})` : ''} · ${new Date(latest.at).toLocaleString()} · ${latest.reason}` : 'none yet'),
      latest && latest.portfolio ? el('div', { class: 'small', text: latest.portfolio.slice(0, 400) }) : null,
      latest && latest.ventures && latest.ventures.length ? row('ventures', latest.ventures.map((v) => `${v.id}: plan ${v.planStillRight === false ? 'needs revision' : 'still right'}${v.morale ? ` · ${v.morale.slice(0, 80)}` : ''}`).join('; ')) : null,
      row('next reflection', refl.job && refl.job.nextRunAt ? `${new Date(refl.job.nextRunAt).toLocaleString()} (daily at ${refl.schedule && refl.schedule.daily ? refl.schedule.daily : '?'})` : 'not scheduled'),
      el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Reflect now', onclick: async () => { const r = await api.post('/api/reflect', { reason: 'manual' }); missionNotice.textContent = r.ok ? 'Reflection started; it posts here when done.' : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } })),
      alerts.length ? row('budget', alerts.map((a) => `${a.scope} ${a.id}: ${(a.fraction * 100).toFixed(0)} % ($${a.spentUsd.toFixed(2)} of $${a.budgetUsd.toFixed(2)})`).join('; ')) : null,
      row('gate queue', `${pendingGate(s).length} waiting`),
      row('judge today', s.judge ? `${fmtUsd(s.judge.today.usd)} of $${s.judge.caps.judgeUsdPerDay} cap · ${s.judge.today.calls} call(s) · ${s.judge.provider}/${s.judge.model || 'default'}` : 'no judge wired'),
      row('spend', `${fmtUsd(s.spend.totalUsd)} reconciled${s.spend.unreconciledTurns ? ` · ${s.spend.unreconciledTurns} unpriced turn(s)` : ''}`),
      row('workspace', s.workspace ? (s.workspace.online ? `online · ${s.workspace.root}` : `OFFLINE (${s.workspace.reason || 'unreachable'}) · ${s.workspace.root}`) : '—'),
      row('runs', runs.length ? `${runs.length} this session` : 'none this session'),
      ...runs.slice(0, 10).map((r) => el('div', { class: `use ${r.status === 'error' ? 'failed' : r.status === 'ended' ? 'ok' : 'running'}`, text: `${r.runId} · ${r.status}${r.reason ? ` (${r.reason})` : ''} · ${fmtUsd(r.spentUsd)} · ${r.prompt.slice(0, 40)}` })),
    ];
  }

  return {
    select(info) {
      selection = info;
      selectionRefresh = () => this.render();
      this.render();
    },
    render() {
      const s = getState();
      if (!selection) {
        setTitle('INSPECT');
        setChildren(body, el('div', { class: 'muted', text: 'Click a Ranger, a fixture, a trail, the Entrance Gate, the Mountain Peak or a zone.' }));
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
      if (selection.type === 'peak') return setChildren(body, ...renderPeak(s));
      if (selection.type === 'trail') return setChildren(body, ...renderTrail(s, selection.trail));
      if (selection.type === 'zone' || selection.type === 'gate') {
        const room = s.layout.rooms.find((r) => r.id === selection.room.id);
        if (!room) return this.select(null);
        return setChildren(body, ...(selection.type === 'gate' ? renderGate(s, room) : renderZone(s, room)));
      }
    },
  };
}
