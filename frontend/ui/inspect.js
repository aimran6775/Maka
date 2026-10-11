// INSPECT window: the card for whatever was clicked in the park. Shows only what the
// harness has emitted this session: no projections, no placeholders for phase 2 features.
import { el, createWindow, setChildren, fmtUsd } from './windows.js';
import { workerLines } from './worker.js';
import { grantedTools, toolUses, lastModel, pendingGate, pendingHandoffs, recentGate, judgeVerdicts, workInTransit, workFor } from '../state.js';
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
      s.browser ? row('browser', (() => { const mine = pendingHandoffs(s).filter((h) => h.agentId === agent.id); const open = (s.browser.sessions || []).find((b) => b.agentId === agent.id); if (mine.length) return `HANDOFF: ${mine.map((h) => `${h.kind} at ${h.url}`).join('; ')}`; if (open) return `open at ${open.url}`; return s.browser.wired ? `closed · trace at ${agent.id}/browser-trace/` : 'not wired (no Chromium found)'; })()) : null,
      row('spend', `${fmtUsd(s.spendByAgent[agent.id] || 0)} since the mission${typeof agent.budgetUsd === 'number' ? ` of $${agent.budgetUsd.toFixed(2)} budget` : ''}`),
      s.mail ? row('addresses', (() => { const mine = mailCache.addresses.filter((a) => a.agentId === agent.id || (a.kind === 'station' && a.station === agent.roomId)); if (!mailCache.addresses.length) loadMail(s, { id: agent.roomId, kind: 'zone' }); return mine.length ? mine.map((a) => a.address).join(', ') : 'none loaded'; })()) : null,
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

  // Mail views fetch from the sidecar when a station is inspected; they re-fetch on mail events.
  const mailCache = { key: null, threads: [], addresses: [], sent: [], at: 0, loading: false };
  async function loadMail(s, room) {
    const key = `${room.id}:${s.mailMessages.length}:${s.mail ? s.mail.addresses : 0}`;
    if (mailCache.key === key || mailCache.loading) return;
    mailCache.loading = true;
    try {
      const all = room.kind === 'visitor_center';
      const [threads, addresses, sent] = await Promise.all([
        api.get(all ? '/api/mail/threads?limit=30' : `/api/mail/threads?station=${encodeURIComponent(room.id)}&limit=30`),
        api.get('/api/mail/addresses'),
        api.get(all ? '/api/mail/messages?direction=out&limit=15' : `/api/mail/messages?station=${encodeURIComponent(room.id)}&direction=out&limit=15`),
      ]);
      mailCache.threads = threads.ok ? threads.body : [];
      mailCache.addresses = addresses.ok ? addresses.body : [];
      mailCache.sent = sent.ok ? sent.body : [];
      mailCache.key = key;
      mailCache.at = Date.now();
    } finally {
      mailCache.loading = false;
      if (selectionRefresh) selectionRefresh();
    }
  }
  function mailSection(s, room) {
    if (!s.mail) return [];
    loadMail(s, room);
    const all = room.kind === 'visitor_center';
    const stationAddrs = mailCache.addresses.filter((a) => all || a.station === room.id);
    const byVenture = {};
    for (const t of mailCache.threads) {
      const k = t.venture || '(no venture)';
      byVenture[k] = (byVenture[k] || 0) + 1;
    }
    return [
      el('div', { class: 'k', text: all ? 'mail · every station' : 'mail · this station' }),
      row('addresses', stationAddrs.length ? stationAddrs.map((a) => `${a.address}${a.agentId ? ` (${a.agentId})` : ''}`).join(', ') : 'none yet'),
      row('inbox', mailCache.threads.length ? `${mailCache.threads.length} thread(s) · ${mailCache.threads.reduce((n, t) => n + t.unread, 0)} unread · by venture: ${Object.entries(byVenture).map(([v, n]) => `${v} ${n}`).join(', ')}` : s.mail.keys && s.mail.keys.resend ? 'no threads yet' : 'Resend not wired (RESEND_API_KEY)'),
      ...mailCache.threads.slice(0, 8).map((t) => el('div', { class: `use ${t.unread ? 'running' : ''}`, text: `${new Date(t.last).toLocaleDateString()} · ${t.station}${t.venture ? ` · ${t.venture}` : ''} · ${t.subject || '(no subject)'} · ${t.count} msg${t.classification ? ` · ${t.classification}` : ''}` })),
      row('outbox', mailCache.sent.length ? `${mailCache.sent.length} sent recently` : 'nothing sent yet'),
      ...mailCache.sent.slice(0, 5).map((m) => el('div', { class: `use ${m.status === 'bounced' || m.status === 'complained' ? 'failed' : m.status === 'delivered' ? 'ok' : ''}`, text: `${m.status} · ${m.kind} · to ${m.to.join(', ')} · ${m.subject}` })),
    ];
  }

  // Camp cards show the connectors of their kind (finance → Stripe …) from the sidecar's
  // local store: fetched when inspected, refreshed after a sync event.
  const connCache = { key: null, rows: [], loading: false };
  async function loadConnectorData(s, room) {
    const mine = s.connectors.filter((c) => (c.zoneKinds || [c.zoneKind]).includes(room.kind));
    const key = `${room.id}:${mine.map((c) => `${c.kind}:${c.syncedAt || 0}:${c.connected}`).join(',')}`;
    if (!mine.length || connCache.key === key || connCache.loading) return;
    connCache.loading = true;
    try {
      const rows = await Promise.all(mine.map(async (c) => { const r = await api.get(`/api/connectors/${encodeURIComponent(c.kind)}`); return r.ok ? r.body : { ...c, data: null }; }));
      connCache.rows = rows;
      connCache.key = key;
    } finally {
      connCache.loading = false;
      selectionRefresh && selectionRefresh();
    }
  }
  const money = (minorAmount, currency) => `${(['jpy', 'krw'].includes(currency) ? minorAmount : minorAmount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`;
  function connectorRows(c) {
    const d = c.data;
    if (!c.connected && !(d && d.syncedAt)) return [row(c.label, `not connected (connect it at the Peak)${c.lastError ? ` · ${c.lastError.message}` : ''}`)];
    if (!d || !d.syncedAt) return [row(c.label, `connected · not synced yet${c.lastSync && !c.lastSync.ok ? ` · last sync failed: ${c.lastSync.error}` : ''}`)];
    const head = `${c.connected ? 'connected' : 'disconnected'} · synced ${new Date(d.syncedAt).toLocaleString()}${c.lastSync && !c.lastSync.ok ? ` · last sync failed: ${c.lastSync.error}` : ''}`;
    if (c.kind === 'stripe') {
      const week = Date.now() - 7 * 86_400_000;
      const sum = (rows) => rows.reduce((n, r) => n + (r.amount || 0), 0);
      const recent = (d.charges || []).filter((ch) => ch.created >= week && ch.status === 'succeeded');
      const cur = (d.charges[0] || d.balance.available[0] || {}).currency || 'usd';
      return [
        row('Stripe', head),
        row('balance', `${(d.balance.available || []).map((b) => money(b.amount, b.currency)).join(' + ') || '0'} available · ${(d.balance.pending || []).map((b) => money(b.amount, b.currency)).join(' + ') || '0'} pending${d.balance.livemode === false ? ' · TEST MODE' : ''}`),
        row('charges', `${d.charges.length} in the store · last 7 days: ${recent.length} succeeded, ${money(sum(recent), cur)}`),
        row('payouts', d.payouts.length ? `${d.payouts.length} · latest ${money(d.payouts[0].amount, d.payouts[0].currency)} ${d.payouts[0].status} (${new Date(d.payouts[0].arrivalDate).toLocaleDateString()})` : 'none'),
        row('refunds', d.refunds.length ? `${d.refunds.length} · ${money(sum(d.refunds), cur)} in total` : 'none'),
        ...d.charges.slice(0, 5).map((ch) => el('div', { class: `use ${ch.status === 'succeeded' ? 'ok' : ch.status === 'failed' ? 'failed' : ''}`, text: `${new Date(ch.created).toLocaleDateString()} · ${money(ch.amount, ch.currency)} · ${ch.status}${ch.refunded ? ' · refunded' : ch.amountRefunded ? ` · ${money(ch.amountRefunded, ch.currency)} refunded` : ''} · ${ch.description || ch.customer || ch.id}` })),
      ];
    }
    if (c.kind === 'shopify') {
      const week = Date.now() - 7 * 86_400_000;
      const recent = (d.orders || []).filter((o) => o.createdAt && Date.parse(o.createdAt) >= week && o.financialStatus === 'paid');
      const cur = (d.shop && d.shop.currency) || '';
      const stock = (d.products || []).flatMap((p) => p.variants.map((v) => v.inventoryQuantity)).filter((q) => typeof q === 'number');
      return [
        row('Shopify', `${d.shop ? `${d.shop.name} (${d.shop.domain}) · ` : ''}${head}`),
        row('products', `${d.products.length} (${d.products.filter((p) => p.status === 'active').length} active, ${d.products.filter((p) => p.status === 'draft').length} draft) · stock ${stock.reduce((n, q) => n + q, 0)} unit(s) across ${stock.length} variant(s)${stock.some((q) => q <= 0) ? ` · ${stock.filter((q) => q <= 0).length} out of stock` : ''}`),
        row('orders', `${d.orders.length} in the store · last 7 days: ${recent.length} paid, ${recent.reduce((n, o) => n + (Number(o.totalPrice) || 0), 0).toFixed(2)} ${cur} · ${d.orders.filter((o) => o.financialStatus === 'paid' && o.fulfillmentStatus !== 'fulfilled').length} paid and unfulfilled`),
        ...d.orders.slice(0, 5).map((o) => el('div', { class: `use ${o.financialStatus === 'paid' ? 'ok' : ''}`, text: `${o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''} · ${o.name} · ${o.totalPrice} ${o.currency} · ${o.financialStatus} / ${o.fulfillmentStatus} · ${o.customer || ''}` })),
      ];
    }
    if (c.kind === 'etsy') {
      const week = Date.now() - 7 * 86_400_000;
      const recent = (d.receipts || []).filter((r) => r.createdAt >= week && r.paid);
      const cur = (d.shop && d.shop.currency) || '';
      return [
        row('Etsy', `${d.shop ? `${d.shop.name} · ` : ''}${head}`),
        row('listings', `${d.listings.length} (${d.listings.filter((l) => l.state === 'active').length} active, ${d.listings.filter((l) => l.state === 'draft').length} draft) · stock ${d.listings.reduce((n, l) => n + (l.quantity || 0), 0)} unit(s)`),
        row('orders', `${d.receipts.length} receipt(s) · last 7 days: ${recent.length} paid, ${recent.reduce((n, r) => n + (r.grandTotal || 0), 0).toFixed(2)} ${cur} · ${d.receipts.filter((r) => r.paid && !r.shipped).length} to ship`),
        ...d.receipts.slice(0, 5).map((r) => el('div', { class: `use ${r.paid ? 'ok' : ''}`, text: `${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''} · #${r.receiptId} · ${(r.grandTotal || 0).toFixed(2)} ${r.currency} · ${r.paid ? 'paid' : 'unpaid'}${r.shipped ? ', shipped' : ''} · ${r.buyer || ''}` })),
      ];
    }
    if (c.kind === 'meta_ads' || c.kind === 'google_ads') {
      const rows = (c.kind === 'meta_ads' ? d.insights && d.insights.rows : d.metrics && d.metrics.rows) || [];
      const spend = rows.reduce((n, r) => n + (r.spend ?? r.cost ?? 0), 0);
      const cur = ((c.kind === 'meta_ads' ? d.account : d.customer) || {}).currency || '';
      const activeWord = c.kind === 'meta_ads' ? 'ACTIVE' : 'ENABLED';
      const active = d.campaigns.filter((x) => (x.effectiveStatus || x.status) === activeWord);
      return [
        row(c.label, `${((c.kind === 'meta_ads' ? d.account : d.customer) || {}).name ? `${((c.kind === 'meta_ads' ? d.account : d.customer) || {}).name} · ` : ''}${head}`),
        row('campaigns', `${d.campaigns.length} (${active.length} ${activeWord.toLowerCase()}) · daily budgets of the ${activeWord.toLowerCase()} ones: ${active.reduce((n, x) => n + (x.dailyBudget || 0), 0).toFixed(2)} ${cur}`),
        row('last 7 days', `spend ${spend.toFixed(2)} ${cur} · ${rows.reduce((n, r) => n + (r.clicks || 0), 0)} click(s) · ${rows.reduce((n, r) => n + (r.impressions || 0), 0)} impression(s)${c.kind === 'google_ads' ? ` · ${rows.reduce((n, r) => n + (r.conversions || 0), 0)} conversion(s)` : ''}`),
        ...d.campaigns.slice(0, 6).map((x) => el('div', { class: `use ${(x.effectiveStatus || x.status) === activeWord ? 'ok' : ''}`, text: `${x.name} · ${x.effectiveStatus || x.status} · ${typeof x.dailyBudget === 'number' ? `${x.dailyBudget.toFixed(2)} ${cur}/day` : 'no daily budget'} · 7d: ${(rows.find((r) => r.campaignId === x.id) || { spend: 0, cost: 0 }).spend ?? (rows.find((r) => r.campaignId === x.id) || { cost: 0 }).cost} ${cur}` })),
      ];
    }
    return [row(c.label, `${head}${c.summary ? ` · ${c.summary}` : ''}`)];
  }
  function connectorSection(s, room) {
    const mine = (s.connectors || []).filter((c) => (c.zoneKinds || [c.zoneKind]).includes(room.kind));
    if (!mine.length) return [];
    loadConnectorData(s, room);
    const rows = connCache.key && connCache.key.startsWith(`${room.id}:`) ? connCache.rows : mine.map((c) => ({ ...c, data: null }));
    return [el('div', { class: 'k', text: 'connectors for this camp (figures from the last sync only)' }), ...rows.flatMap(connectorRows)];
  }

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
      ...mailSection(s, room),
      ...connectorSection(s, room),
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
    const room = s.layout.rooms.find((r) => r.id === obj.roomId) || {};
    const atPeak = obj.kind === 'radio_tower' && room.kind === 'mountain_peak';
    return [
      row('grants', (def.grants || []).join(', ')),
      row('zone', room.name || obj.roomId),
      atPeak ? row('channels', s.channels && s.channels.adapters && s.channels.adapters.length ? s.channels.adapters.map((c) => `${c.label}: ${c.status === 'up' ? 'up' : c.status === 'not_wired' ? 'not wired' : c.status} · ${(c.paired || []).length} paired`).join('; ') : 'no channel registry') : null,
      atPeak ? el('div', { class: 'muted small', text: 'The lamps on this tower show the owner channels: green up, red failed, dark not wired. Pair a chat at the Peak card.' }) : null,
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

  // Connectors (step 14): one row per platform; connect (a key, or an OAuth sign-in) and
  // disconnect go through the Gate; sync now is immediate. Figures come from syncs only.
  function connectorsSection(s) {
    if (!s.connectors) return [];
    const rows = s.connectors;
    return [
      el('div', { class: 'k', text: 'connectors (official APIs; figures come from their syncs only)' }),
      rows.length ? null : el('div', { class: 'muted small', text: 'none defined yet: the platform connectors arrive in phase 2 steps 15–17' }),
      ...rows.map((c) => el('div', { class: 'connector-row' },
        el('div', { class: 'kv' }, el('span', { class: 'k', text: c.label }), el('span', { class: 'v', text: c.connected ? `connected (${c.auth}${c.by ? ` · ${c.by}` : ''})${c.syncedAt ? ` · synced ${new Date(c.syncedAt).toLocaleString()}` : ' · not synced yet'}${c.lastSync && !c.lastSync.ok ? ` · last sync failed: ${c.lastSync.error}` : ''}${c.summary ? ` · ${c.summary}` : ''}` : c.pendingItemId ? `waiting at the Gate (${c.pendingItemId})` : c.authorizeUrl ? 'sign-in started: open the link below' : `not connected${c.lastError ? ` · ${c.lastError.stage}: ${c.lastError.message}` : ''}` })),
        c.authorizeUrl ? el('a', { class: 'small', href: c.authorizeUrl, target: '_blank', rel: 'noopener', text: `Sign in to ${c.label} (opens the platform)` }) : null,
        el('div', { class: 'row' },
          c.connected ? el('button', { class: 'btn small', text: c.syncing ? 'Syncing…' : 'Sync now', disabled: c.syncing ? '' : null, onclick: async () => { const r = await api.post(`/api/connectors/${encodeURIComponent(c.kind)}/sync`, {}); missionNotice.textContent = r.ok ? `${c.label} synced: ${Object.entries(r.body.counts || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new'}` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } }) : null,
          c.connected ? el('button', { class: 'btn small', text: 'Disconnect (via the Gate)', onclick: async () => { const r = await api.post(`/api/connectors/${encodeURIComponent(c.kind)}/disconnect`, {}); missionNotice.textContent = r.ok ? `Disconnect waiting at the Gate (${r.body.itemId}).` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } }) : null,
          !c.connected && !c.pendingItemId && !c.authorizeUrl ? el('button', { class: 'btn small primary', text: c.auth === 'oauth2' ? 'Connect (sign in, via the Gate)' : 'Connect (API key, via the Gate)', onclick: async () => { const body = {}; if (c.auth === 'api_key') { const k = window.prompt(`${c.label} API key (stored in the 0600 keystore after your approval at the Gate):`, ''); if (!k) return; body.apiKey = k; } const r = await api.post(`/api/connectors/${encodeURIComponent(c.kind)}/connect`, body); missionNotice.textContent = r.ok ? `Connect waiting at the Gate (${r.body.itemId}).` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } }) : null,
        ),
      )),
    ];
  }

  // Owner channels (phase 4 step 1): the Peak on the phone. Pairing code, paired chats, the
  // bot token through the Gate. Everything shown comes from the snapshot and channel.* events.
  const channelNotice = { text: '' };
  function channelsSection(s) {
    if (!s.channels) return [];
    const rows = s.channels.adapters || [];
    const pairing = s.channels.pairing && s.channels.pairing.expiresAt > Date.now() ? s.channels.pairing : null;
    const recent = s.channelEvents.slice(-5).reverse();
    return [
      el('div', { class: 'k', text: 'owner channels (the Peak on your phone; only a paired chat may act on the Gate)' }),
      rows.length ? null : el('div', { class: 'muted small', text: 'no channel adapters registered: Telegram, Discord and Slack arrive in phase 4 steps 2 and 3' }),
      ...rows.map((c) => el('div', { class: 'connector-row' },
        el('div', { class: 'kv' }, el('span', { class: 'k', text: c.label }), el('span', { class: 'v', text: c.status === 'up' ? `up (${c.by || '?'}${c.detail ? ` · ${c.detail}` : ''}) · ${c.paired.length} paired chat(s)` : c.status === 'not_wired' ? `not wired: set ${(c.missing || c.keys || []).join(', ')} or connect below` : c.pendingItemId ? `waiting at the Gate (${c.pendingItemId})` : `${c.status}${c.lastError ? ` · ${c.lastError.message}` : ''} · ${c.paired.length} paired chat(s)` })),
        ...c.paired.map((ch) => el('div', { class: 'row' }, el('span', { class: 'small', text: `chat ${ch.chatId} (user ${ch.userId}) paired ${new Date(ch.pairedAt).toLocaleString()}` }), el('button', { class: 'btn small', text: 'Unpair', onclick: async () => { const r = await api.post(`/api/channels/${encodeURIComponent(c.name)}/unpair`, { chatId: ch.chatId }); channelNotice.text = r.ok ? `Unpaired ${c.label} chat ${ch.chatId}.` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; selectionRefresh && selectionRefresh(); } }))),
        el('div', { class: 'row' },
          c.status !== 'up' && !c.pendingItemId && c.keys && c.keys.length === 1 ? el('button', { class: 'btn small primary', text: 'Connect (bot token, via the Gate)', onclick: async () => { const t = window.prompt(`${c.label} bot token (stored in the keystore after your approval at the Gate):`, ''); if (!t) return; const r = await api.post(`/api/channels/${encodeURIComponent(c.name)}/connect`, { token: t }); channelNotice.text = r.ok ? `Connect waiting at the Gate (${r.body.itemId}).` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; selectionRefresh && selectionRefresh(); } }) : null,
          c.status === 'up' && !c.pendingItemId ? el('button', { class: 'btn small', text: 'Disconnect (via the Gate)', onclick: async () => { const r = await api.post(`/api/channels/${encodeURIComponent(c.name)}/disconnect`, {}); channelNotice.text = r.ok ? `Disconnect waiting at the Gate (${r.body.itemId}).` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; selectionRefresh && selectionRefresh(); } }) : null,
        ),
      )),
      rows.length ? el('div', { class: 'row' },
        el('button', { class: 'btn small', text: pairing ? 'New pairing code' : 'Pairing code', title: 'A single-use code, valid ten minutes; send it from your chat to pair it', onclick: async () => { const r = await api.post('/api/channels/pair', {}); channelNotice.text = r.ok ? `Pairing code ${r.body.code}: send it to the bot from your chat within 10 minutes.` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; selectionRefresh && selectionRefresh(); } }),
        pairing ? el('span', { class: 'small warn', text: `code ${pairing.code} · expires ${new Date(pairing.expiresAt).toLocaleTimeString()}${pairing.attempts ? ` · ${pairing.attempts} wrong attempt(s)` : ''}` }) : el('span', { class: 'small muted', text: 'no pairing code active' }),
      ) : null,
      ...recent.map((e) => el('div', { class: `use ${e.type === 'channel.delivery' ? (e.status === 'sent' ? 'ok' : 'failed') : e.paired === false ? 'failed' : ''}`, text: e.type === 'channel.delivery' ? `${new Date(e.ts).toLocaleTimeString()} · ${e.channel} → ${e.chatId}: ${e.kind} ${e.status}${e.error ? ` (${e.error})` : ''}` : e.type === 'channel.inbound' ? `${new Date(e.ts).toLocaleTimeString()} · ${e.channel} ← ${e.chatId}: ${e.action}${e.decision ? ` ${e.decision} ${e.itemId}` : ''} · ${e.outcome}` : `${new Date(e.ts).toLocaleTimeString()} · ${e.channel}: ${e.status}${e.message ? ` (${e.message})` : ''}` })),
      channelNotice.text ? el('div', { class: 'notice', text: channelNotice.text }) : null,
    ];
  }

  // Venture briefs (step 18): listed from every Ranger's outbox, fetched when the Peak is
  // inspected and again when a work item finishes.
  const briefCache = { key: null, rows: [], loading: false };
  async function loadBriefs(s) {
    const key = `${s.workOrder.length}:${Object.values(s.workItems).filter((w) => w.status === 'done').length}`;
    if (briefCache.key === key || briefCache.loading) return;
    briefCache.loading = true;
    try {
      const r = await api.get('/api/briefs?limit=10');
      briefCache.rows = r.ok ? r.body : [];
      briefCache.key = key;
    } finally {
      briefCache.loading = false;
      selectionRefresh && selectionRefresh();
    }
  }
  function briefsSection(s) {
    if (!s.research) return [];
    loadBriefs(s);
    return [
      row('research', `search via ${s.research.search} · trends: ${(s.research.trends || []).join(', ')} · judge ${s.research.judge ? 'reviews briefs' : 'not wired'}`),
      row('venture briefs', briefCache.rows.length ? `${briefCache.rows.length} (newest first)` : 'none yet: a Scout with a Trailhead sign submits them'),
      ...briefCache.rows.slice(0, 6).map((b) => el('div', { class: `use ${b.judge && b.judge.verdict === 'approve' ? 'ok' : b.judge && b.judge.verdict === 'reject' ? 'failed' : ''}`, text: `${new Date(b.submittedAt).toLocaleDateString()} · ${b.title} · ${b.recommendation.replace(/_/g, ' ')} (${Math.round(b.confidence * 100)} %) · judge ${b.judge ? b.judge.verdict : '?'} · ${b.evidence} source(s) · one-off $${b.totals.one_off.toFixed(2)}, monthly $${b.totals.monthly.toFixed(2)} · ${b.agentId} · ${b.path}` })),
    ];
  }

  // The Peak's worker actions (step 4): the outcome shows under the lines, then the
  // snapshot is re-read so the models and memory lines are the sidecar's, not ours.
  const workerNotice = { text: '' };
  async function peakAct(step, label, req) {
    workerNotice.text = `${label}…`;
    if (selectionRefresh) selectionRefresh();
    const r = await req();
    workerNotice.text = r.ok ? `${label}: ok${r.body && r.body.how ? ` (${r.body.how})` : ''}` : `${label}: ${r.body.code || r.status}: ${r.body.error || 'failed'}`;
    const snap = await fetch('/api/state');
    if (snap.ok && window.maka && window.maka.refresh) await window.maka.refresh(await snap.json());
    if (selectionRefresh) selectionRefresh();
    return r;
  }

  // Offsite backup (step 5): what the sidecar reports, and the owner's actions.
  const backupNotice = { text: '', key: null };
  const backupAt = el('input', { class: 'inp num', value: '03:00', title: 'daily, local time (HH:MM)' });
  const backupBucket = el('input', { class: 'inp', placeholder: 'R2 bucket name' });
  async function backupAct(label, req) {
    backupNotice.text = `${label}…`;
    if (selectionRefresh) selectionRefresh();
    const r = await req();
    backupNotice.text = r.ok ? `${label}: ok${r.body && r.body.key ? ` · ${r.body.key}` : ''}${r.body && r.body.into ? ` → ${r.body.into}` : ''}${r.body && typeof r.body.files === 'number' ? ` · ${r.body.files} file(s)` : ''}` : `${label}: ${r.body.code || r.status}: ${r.body.error || 'failed'}`;
    if (r.ok && r.body && r.body.keyHex) backupNotice.key = r.body.keyHex;
    const snap = await fetch('/api/state');
    if (snap.ok && window.maka && window.maka.refresh) await window.maka.refresh(await snap.json());
    if (selectionRefresh) selectionRefresh();
    return r;
  }
  function backupSection(s) {
    const b = s.backup;
    if (!b) return [];
    if (!backupBucket.value && b.bucket) backupBucket.value = b.bucket;
    if (b.at && backupAt.value === '03:00' && b.at !== '03:00') backupAt.value = b.at;
    const last = b.last;
    return [
      el('div', { class: 'k', text: 'offsite backup (Cloudflare R2, encrypted)' }),
      row('wired', b.wired ? `yes · ${b.bucket} under ${b.prefix}/` : `no: set ${b.missing.join(', ')}`),
      row('schedule', b.enabled ? `daily at ${b.at}${b.job && b.job.nextRunAt ? ` · next ${new Date(b.job.nextRunAt).toLocaleString()}` : ''}` : 'disabled'),
      row('key', b.hasKey ? 'in the Keychain (keystore without the app)' : 'none yet: enabling makes one and shows it once'),
      row('last', b.running ? `running (${b.running.reason}) since ${new Date(b.running.startedAt).toLocaleTimeString()}` : last ? `${last.status} · ${new Date(last.at).toLocaleString()} · ${last.reason}${typeof last.files === 'number' ? ` · ${last.files} file(s)` : ''}${last.error ? ` · ${last.error}` : ''}` : 'no snapshot yet'),
      b.lastRestore ? row('restored', `${new Date(b.lastRestore.at).toLocaleString()} → ${b.lastRestore.into}`) : null,
      el('div', { class: 'row' }, el('label', { text: 'daily at' }), backupAt, el('label', { text: 'bucket' }), backupBucket,
        el('button', { class: `btn ${b.enabled ? '' : 'primary'}`, text: b.enabled ? 'Disable' : 'Enable', onclick: () => backupAct(b.enabled ? 'Disable' : 'Enable', () => api.post('/api/backup/config', { enabled: !b.enabled, at: backupAt.value.trim(), bucket: backupBucket.value.trim() || undefined })) })),
      el('div', { class: 'row' },
        el('button', { class: 'btn', text: 'Back up now', disabled: !b.wired || !b.hasKey || Boolean(b.running), onclick: () => backupAct('Snapshot', () => api.post('/api/backup/now', {})) }),
        el('button', { class: 'btn', text: 'Verify latest', disabled: !b.wired || !b.hasKey, title: 'Downloads the latest snapshot, opens it with the key and lists it; writes nothing', onclick: () => backupAct('Verify', () => api.post('/api/backup/verify', {})) }),
        el('button', { class: 'btn', text: 'Restore latest', disabled: !b.wired || !b.hasKey, title: 'Restores into workspace/_restore/<time>/; never over live data', onclick: () => { if (window.confirm('Restore the latest snapshot into a fresh _restore/ folder under the workspace?')) backupAct('Restore', () => api.post('/api/backup/restore', {})); } }),
      ),
      backupNotice.key ? el('div', { class: 'small warn', text: `Snapshot key (shown once; write it down): ${backupNotice.key}` }) : null,
      el('div', { class: 'notice', text: backupNotice.text }),
    ];
  }

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
      s.mail ? row('mail DNS', `${s.mail.domain} · Resend ${s.mail.keys.resend ? 'wired' : 'not wired'} · Cloudflare ${s.mail.keys.cloudflare ? 'wired' : 'not wired'}${s.mailDns.length ? ` · last: ${(() => { const d = s.mailDns.at(-1); return `${d.change}${d.message ? ` (${d.message})` : d.change === 'planned' ? ` (+${d.create} ~${d.update} -${d.remove}, ${d.unchanged} unchanged)` : ''}`; })()}` : s.mail.lastPlan ? ` · planned ${new Date(s.mail.lastPlan.at).toLocaleString()}` : ' · not planned yet'}`) : null,
      s.mail ? el('div', { class: 'row' },
        el('button', { class: 'btn', text: 'Plan DNS', disabled: !(s.mail.keys.resend && s.mail.keys.cloudflare), title: 'Dry run: Resend records vs the Cloudflare zone', onclick: async () => { const r = await api.post('/api/mail/dns/plan', {}); missionNotice.textContent = r.ok ? `DNS plan: +${r.body.counts.create} ~${r.body.counts.update} -${r.body.counts.remove}, ${r.body.counts.unchanged} unchanged${r.body.notes.length ? ` · ${r.body.notes.join(' ')}` : ''}` : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } }),
        el('button', { class: 'btn', text: 'Apply DNS (via the Gate)', disabled: !(s.mail.keys.resend && s.mail.keys.cloudflare), onclick: async () => { const r = await api.post('/api/mail/dns/apply', {}); missionNotice.textContent = r.ok ? (r.body.itemId ? `DNS change waiting at the Gate (${r.body.itemId}).` : r.body.status) : `${r.body.code || r.status}: ${r.body.error || 'failed'}`; } }),
      ) : null,
      row('gate queue', `${pendingGate(s).length} waiting`),
      ...connectorsSection(s),
      ...channelsSection(s),
      ...briefsSection(s),
      s.browser ? row('browser', `${s.browser.wired ? `${s.browser.chromium}${s.browser.headless ? ' (headless)' : ''}` : 'not wired: no Chromium found (browser.chromiumPath or CHROMIUM)'} · ${(s.browser.sessions || []).length} open · ${pendingHandoffs(s).length} handoff(s) waiting`) : null,
      ...backupSection(s),
      row('judge today', s.judge ? `${fmtUsd(s.judge.today.usd)} of $${s.judge.caps.judgeUsdPerDay} cap · ${s.judge.today.calls} call(s) · ${s.judge.provider}/${s.judge.model || 'default'}` : 'no judge wired'),
      s.ollama ? el('div', { class: 'k', text: 'worker (local model, Ollama)' }) : null,
      ...(s.ollama ? workerLines({ s, w: s.ollama, api, act: peakAct, busy: false, step: 'worker', showRemove: true }) : []),
      s.ollama ? el('div', { class: 'notice', text: workerNotice.text }) : null,
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
