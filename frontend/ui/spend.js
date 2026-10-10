// SPEND window: fed only by reconciled cost events (plus the persisted total they produced).
import { el, createWindow, fmtUsd } from './windows.js';
import { currentRun } from '../state.js';

export function createSpend({ parent, getState, x, y, w }) {
  const { body } = createWindow({ id: 'spend', title: 'SPEND', x, y, w, parent });
  const total = el('div', { class: 'big', text: '$0.000' });
  const detail = el('div', { class: 'muted' });
  const run = el('div', { class: 'muted' });
  body.append(total, detail, run, el('div', { class: 'muted small', text: 'Reconciled = provider-reported usage × known price, or provider-reported cost. Unpriced turns are counted, not estimated.' }));
  return {
    render() {
      const s = getState();
      total.textContent = fmtUsd(s.spend.totalUsd);
      detail.textContent = `${s.spend.reconciledTurns} reconciled turn${s.spend.reconciledTurns === 1 ? '' : 's'}` + (s.spend.unreconciledTurns ? ` · ${s.spend.unreconciledTurns} unpriced` : '');
      const r = currentRun(s);
      run.textContent = r ? `current run: ${fmtUsd(r.spentUsd)}${r.unreconciledTurns ? ` (+${r.unreconciledTurns} unpriced)` : ''}` : 'no run yet';
    },
  };
}
