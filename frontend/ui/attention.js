// What needs you, and what the park is doing (D192).
//
//   createAttention({ parent, getState, api, onFlash, onMail }) -> { render() }
//
// Everything built since the portfolio existed only on the owner's phone. The park could be
// blocked on them, over its budget, and holding a business proposal, and the screen in front
// of them said nothing about any of it — the rails showed a box to run a Ranger from, a
// spend total, the build palette, and whatever was selected.
//
// This panel is the park's answer to one question, asked in order:
//
//   1. does anything need me?      blockers, Gate items, per-call confirmations
//   2. what is the park running?   the portfolio, its money
//   3. what is it costing?         free turns against paid decisions
//
// Nothing needing attention is itself worth saying plainly, rather than an empty box: a
// park that is fine should look fine.

import { el, setChildren, createWindow } from './windows.js';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

export function createAttention({ parent, getState, api, onFlash = () => {}, onMail = null, x = 0, y = 0, w = 278 }) {
  const { body } = createWindow({ id: 'attention', title: 'NEEDS YOU', x, y, w, parent });
  const needs = el('div', { class: 'at-needs' });
  const running = el('div', { class: 'at-running' });
  const cost = el('div', { class: 'at-cost' });
  setChildren(body, needs, running, cost);

  async function post(path, payload, what) {
    try {
      const r = await api.post(path, payload);
      if (!r || !r.ok) throw new Error((r && r.body && (r.body.error || r.body.message)) || `${path} answered ${r ? r.status : 'nothing'}`);
      onFlash(what, 'ok');
    } catch (err) {
      onFlash(err);
    }
  }

  // A blocker: what is wrong, what the owner must do, and the one button that clears it.
  function blockerCard(b) {
    return el('div', { class: 'at-card urgent' },
      el('div', { class: 'at-card-head' },
        el('span', { class: 'at-kind', text: 'blocked' }),
        el('span', { class: 'at-card-title', text: b.title }),
      ),
      el('p', { class: 'at-what', text: b.blocking }),
      el('details', { class: 'at-more' },
        el('summary', { text: `what to do (${(b.needs || []).length} step${(b.needs || []).length === 1 ? '' : 's'})` }),
        el('ol', { class: 'at-steps' }, ...(b.needs || []).map((n) => el('li', { text: n }))),
        b.tried && b.tried.length ? el('p', { class: 'at-tried', text: `Already tried: ${b.tried.join('; ')}` }) : null,
      ),
      el('div', { class: 'at-actions' },
        el('button', {
          class: 'btn small primary',
          text: 'I have done this',
          onclick: () => post(`/api/blockers/${encodeURIComponent(b.id)}/resolve`, { note: 'cleared at the park' }, `${b.key} cleared`),
        }),
        el('span', { class: 'at-by', text: `${b.raisedBy}${b.department ? ` · ${b.department}` : ''}` }),
      ),
    );
  }

  // A Gate item: the summary, the money if there is any, and the decision.
  function gateCard(it) {
    const isVenture = it.kind === 'venture';
    return el('div', { class: 'at-card' },
      el('div', { class: 'at-card-head' },
        el('span', { class: `at-kind ${isVenture ? 'venture' : 'gate'}`, text: isVenture ? 'new business' : it.domain.replace(/_/g, ' ') }),
        el('span', { class: 'at-card-title', text: it.summary }),
      ),
      typeof it.amountUsd === 'number' && it.amountUsd > 0 ? el('p', { class: 'at-what', text: `${money(it.amountUsd)} if you approve` }) : null,
      (it.evidence || []).length
        ? el('details', { class: 'at-more' },
            el('summary', { text: 'the case for it' }),
            ...(it.evidence || []).slice(0, 6).map((e) => el('p', { class: 'at-ev', text: `${e.kind}: ${e.text}` })),
          )
        : null,
      el('div', { class: 'at-actions' },
        el('button', { class: 'btn small primary', text: 'Approve', onclick: () => post(`/api/gate/${encodeURIComponent(it.itemId)}`, { decision: 'approve', notes: 'approved at the park' }, 'approved') }),
        el('button', { class: 'btn small', text: 'Send back', onclick: () => post(`/api/gate/${encodeURIComponent(it.itemId)}`, { decision: 'revise', notes: 'sent back at the park' }, 'sent back') }),
        el('button', { class: 'btn small danger', text: 'No', onclick: () => post(`/api/gate/${encodeURIComponent(it.itemId)}`, { decision: 'reject', notes: 'rejected at the park' }, 'rejected') }),
      ),
    );
  }

  function render() {
    const s = getState();
    if (!s) return;

    // ---- 1. does anything need me? ----
    const blockers = (s.blockers && s.blockers.items) || [];
    const gate = (s.gate && s.gate.pending) || [];
    const prompts = s.pendingPrompts || [];
    const waiting = blockers.length + gate.length + prompts.length;

    setChildren(needs,
      waiting
        ? el('div', { class: 'at-list' },
            ...blockers.map(blockerCard),
            ...gate.map(gateCard),
            ...prompts.map((p) => el('div', { class: 'at-card' },
              el('div', { class: 'at-card-head' }, el('span', { class: 'at-kind', text: 'confirm' }), el('span', { class: 'at-card-title', text: `a Ranger is waiting on ${p.promptId}` })),
            )),
          )
        : el('p', { class: 'at-clear', text: 'Nothing needs you.' }),
    );

    // ---- 2. what is the park running? ----
    const pf = s.portfolio;
    const ch = s.charters;
    const mail = s.mail || {};
    const depts = s.agents ? s.agents.filter((a) => a.head).length : 0;
    const rows = [];
    if (pf) {
      const active = (pf.ventures || []).filter((v) => v.status === 'active');
      const proposed = (pf.ventures || []).filter((v) => v.status === 'proposed');
      rows.push(['businesses', active.length ? `${active.length} running` : 'none running', proposed.length ? `${proposed.length} waiting on you` : '']);
      rows.push(['committed', `${money(pf.committedUsd)} of ${money(pf.ceilingUsd)}`, '']);
      for (const v of active.slice(0, 4)) rows.push([`· ${v.name}`, `${money(v.spentUsd)} of ${money(v.budgetUsd)}`, '']);
    }
    if (ch) rows.push(['departments', `${depts} with a head`, ch.enabled ? `${ch.enabled} standing duties` : 'no duties on']);
    if (mail && Number.isFinite(mail.unread)) rows.push(['mail', mail.unread ? `${mail.unread} unread` : 'nothing unread', '']);

    setChildren(running,
      el('div', { class: 'at-sec-head', text: 'The park' }),
      ...rows.map(([k, v, note]) => el('div', { class: 'at-row' },
        el('span', { class: 'at-k', text: k }),
        el('span', { class: 'at-v', text: v }),
        note ? el('span', { class: 'at-note', text: note }) : null,
      )),
      mail && Number.isFinite(mail.unread) && onMail
        ? el('button', { class: 'btn small', text: 'Open Park Mail', onclick: () => onMail() })
        : null,
    );

    // ---- 3. what is it costing? ----
    // The park is free except where a decision deserves Claude, so the readout says which
    // is which rather than showing one total that hides it.
    const judge = s.judge || {};
    const policy = s.policy || {};
    const tiers = policy.tiers || {};
    const worker = tiers.worker || {};
    const judgeTier = tiers.judge || {};
    const today = judge.today || (s.ledger && s.ledger.judge) || null;
    const spentToday = today && typeof today.usd === 'number' ? today.usd : null;
    const cap = (policy.caps && policy.caps.judgeUsdPerDay) || null;

    setChildren(cost,
      el('div', { class: 'at-sec-head', text: 'What it costs' }),
      el('div', { class: 'at-row' },
        el('span', { class: 'at-k', text: 'every turn' }),
        el('span', { class: 'at-v free', text: worker.provider === 'ollama' ? `free · ${worker.model || 'local model'}` : `paid · ${worker.provider || '?'}` }),
      ),
      el('div', { class: 'at-row' },
        el('span', { class: 'at-k', text: 'decisions' }),
        el('span', { class: 'at-v', text: judgeTier.model || judgeTier.provider || 'not wired' }),
      ),
      spentToday === null
        ? null
        : el('div', { class: 'at-row' },
            el('span', { class: 'at-k', text: 'today' }),
            el('span', { class: `at-v${cap && spentToday >= cap ? ' warn' : ''}`, text: cap ? `${money(spentToday)} of ${money(cap)}` : money(spentToday) }),
          ),
      cap && spentToday !== null
        ? el('div', { class: 'at-bar', title: `${money(spentToday)} of the ${money(cap)} daily cap` },
            el('span', { class: `at-bar-fill${spentToday >= cap ? ' over' : ''}`, style: `width:${Math.min(100, (spentToday / cap) * 100).toFixed(1)}%` }),
          )
        : null,
    );

    // The panel's own title carries the count, so a collapsed panel still says it.
    const title = parent.querySelector('#attention .win-title');
    if (title) title.textContent = waiting ? `NEEDS YOU · ${waiting}` : 'NEEDS YOU';
    const win = parent.querySelector('#attention');
    if (win) win.classList.toggle('has-waiting', waiting > 0);
  }

  return { render };
}
