// Entrance Gate cards: one card per pending permission.prompt (phase 1 per-call
// confirmation) and one per pending gate.item (phase 2 leash decisions and loosening
// proposals). Buttons post the answer; a card disappears only when the sidecar echoes the
// decision (or the run ends), never on click alone.
import { el } from './windows.js';
import { pendingGate, pendingHandoffs } from '../state.js';
import { LEASH_LEVEL_LABELS } from '../../shared/leash.js';

export function createPermission({ parent, getState, api }) {
  const host = el('div', { class: 'perm-host' });
  parent.append(host);
  let shown = '';

  async function answer(q, allow) {
    const btns = host.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    const res = await api.post('/api/permission', { promptId: q.promptId, runId: q.runId, allow });
    if (!res.ok) btns.forEach((b) => (b.disabled = false));
  }

  async function decide(item, decision, notesEl) {
    const btns = host.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    const res = await api.post(`/api/gate/${encodeURIComponent(item.itemId)}`, { decision, notes: notesEl ? notesEl.value.trim() : '' });
    if (!res.ok) btns.forEach((b) => (b.disabled = false));
  }

  function promptCard(q) {
    return el('div', { class: 'perm-card' },
      el('div', { class: 'perm-gate', text: 'ENTRANCE GATE' }),
      el('div', { class: 'perm-title', text: `Allow ${q.tool}?` }),
      el('div', { class: 'muted small', text: q.reason }),
      q.leash ? el('div', { class: 'perm-leash', text: `leash: ${q.leash.domain} · ${LEASH_LEVEL_LABELS[q.leash.level] || q.leash.level}` }) : el('div', { class: 'perm-leash muted', text: 'no leash domain (workspace-only action, confirmed per call)' }),
      el('pre', { class: 'perm-input', text: summarize(q.input) }),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', text: 'Allow', onclick: () => answer(q, true) }),
        el('button', { class: 'btn', text: 'Deny', onclick: () => answer(q, false) }),
        el('span', { class: 'muted small', text: `run ${q.runId}` }),
      ),
    );
  }

  async function handBack(h, notesEl, paidEl = null) {
    const btns = host.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    const body = { notes: notesEl ? notesEl.value.trim() : '' };
    if (paidEl && paidEl.value.trim() !== '') body.paidUsd = Number(paidEl.value.trim().replace(/[$,]/g, ''));
    const res = await api.post(`/api/browser/handoff/${encodeURIComponent(h.handoffId)}/return`, body);
    if (!res.ok) btns.forEach((b) => (b.disabled = false));
  }

  function handoffCard(s, h) {
    const agent = s.layout.agents.find((a) => a.id === h.agentId);
    const who = agent ? agent.name : h.agentId;
    const notes = el('textarea', { class: 'perm-notes', rows: 2, placeholder: h.kind === 'payment' ? 'required: what you did (paid, or not) and whether the Ranger may continue' : 'a note for the Ranger (what you did, or why not)' });
    // Safety 2026-10-11 M2: on a payment page the amount paid comes from you, not the Ranger;
    // without it a purchase settles at the larger of the declared and the reported amounts.
    const paid = h.kind === 'payment' ? el('input', { class: 'perm-notes', type: 'number', min: '0', step: '0.01', placeholder: 'amount you paid, USD (leave empty if you did not pay)' }) : null;
    return el('div', { class: 'perm-card gate-item handoff' },
      el('div', { class: 'perm-gate', text: `BROWSER HANDOFF · ${h.kind.replace('_', ' ').toUpperCase()}` }),
      el('div', { class: 'perm-title', text: `${who}'s browser needs you: ${h.reason || h.kind}` }),
      el('div', { class: 'muted small', text: `${h.title ? `${h.title} · ` : ''}${h.url || ''}` }),
      h.headless ? el('div', { class: 'perm-leash', text: 'the browser is headless, so there is no window to show; hand it back to let the Ranger continue' }) : el('div', { class: 'perm-leash', text: 'the window is in front: finish the step there, then hand the page back' }),
      notes,
      paid,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', text: 'Hand back', onclick: () => handBack(h, notes, paid) }),
        el('span', { class: 'muted small', text: h.runId ? `run ${h.runId}` : '' }),
      ),
    );
  }

  function itemCard(s, item) {
    const agent = s.layout.agents.find((a) => a.id === item.agentId);
    const who = agent ? agent.name : item.agentId;
    if (item.kind === 'proposal') {
      return el('div', { class: 'perm-card gate-item proposal' },
        el('div', { class: 'perm-gate', text: 'ENTRANCE GATE · LEASH PROPOSAL' }),
        el('div', { class: 'perm-title', text: `Loosen ${who}'s ${item.domain} leash?` }),
        el('div', { class: 'perm-leash', text: `${LEASH_LEVEL_LABELS[item.proposal.from]} → ${LEASH_LEVEL_LABELS[item.proposal.to]}` }),
        el('div', { class: 'muted small', text: item.summary }),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', text: 'Approve', onclick: () => decide(item, 'approve') }),
          el('button', { class: 'btn', text: 'Reject', onclick: () => decide(item, 'reject') }),
        ),
      );
    }
    const notes = el('textarea', { class: 'perm-notes', rows: 2, placeholder: 'notes for the Ranger (used by Revise and Reject)' });
    return el('div', { class: 'perm-card gate-item' },
      el('div', { class: 'perm-gate', text: `ENTRANCE GATE · ${item.domain.toUpperCase()}` }),
      el('div', { class: 'perm-title', text: `${who} wants to ${item.summary}` }),
      el('div', { class: 'perm-leash', text: `leash: ${LEASH_LEVEL_LABELS[item.level] || item.level}${typeof item.amountUsd === 'number' && item.amountUsd > 0 ? ` · $${item.amountUsd.toFixed(2)}` : ''}${item.reason ? ` · ${item.reason}` : ''}` }),
      el('div', { class: 'evidence' }, ...(item.evidence || []).map((e) => el('div', {}, el('span', { class: 'ek', text: e.kind }), e.text))),
      notes,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', text: 'Approve', onclick: () => decide(item, 'approve', notes) }),
        el('button', { class: 'btn', text: 'Revise', onclick: () => decide(item, 'revise', notes) }),
        el('button', { class: 'btn', text: 'Reject', onclick: () => decide(item, 'reject', notes) }),
        el('span', { class: 'muted small', text: item.runId ? `run ${item.runId}` : '' }),
      ),
    );
  }

  return {
    render() {
      const s = getState();
      const items = pendingGate(s);
      const handoffs = pendingHandoffs(s);
      const key = s.pendingPrompts.map((q) => q.promptId).concat(items.map((i) => i.itemId), handoffs.map((h) => h.handoffId)).join('|');
      if (key === shown) return;
      shown = key;
      host.replaceChildren(...s.pendingPrompts.map(promptCard), ...items.map((it) => itemCard(s, it)), ...handoffs.map((h) => handoffCard(s, h)));
    },
  };
}

function summarize(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    out[k] = typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}… (${v.length} chars)` : v;
  }
  return JSON.stringify(out, null, 1);
}
