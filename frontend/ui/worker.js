// The local worker's lines and actions (phase 3 step 4), shared by the first-run card and
// the Peak card. Everything comes from the sidecar's /api/ollama summary: Ollama found or
// not, the install hint, the models with their sizes and whether each fits the memory
// budget, memory as the OS reports it, the recommendation, a pull's own progress.
import { el } from './windows.js';

export const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

// `act(step, label, request)` runs a request and shows its outcome; `busy` disables.
export function workerLines({ s, w, api, act, busy = false, step = 'worker', showRemove = false }) {
  if (!w) return [el('div', { class: 'small muted', text: 'Ollama status not loaded yet.' })];
  const pull = s.ollamaPull;
  const mem = w.memory || null;
  const rec = mem && mem.recommended;
  const recRow = mem && mem.candidates ? mem.candidates.find((c) => c.name === rec) : null;
  const pullLine = pull && !pull.done ? `${pull.model}: ${pull.status}${pull.total ? ` · ${gb(pull.completed || 0)} of ${gb(pull.total)}` : ''}` : pull && pull.done ? `${pull.model}: ${pull.error ? `failed (${pull.error})` : 'pulled'}` : '';
  return [
    el('div', { class: 'small', text: `Ollama at ${w.host}: ${w.reachable ? `reachable${w.version ? ` (v${w.version})` : ''}` : `not reachable (${w.problem || 'unknown'})`} · ${w.worker}` }),
    !w.reachable ? el('div', { class: 'small', text: w.installed && (w.installed.app || w.installed.binary) ? `Installed at ${w.installed.app || w.installed.binary}.` : w.installHint || '' }) : null,
    !w.reachable ? el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Start Ollama', disabled: busy, onclick: () => act(step, 'Start', () => api.post('/api/ollama/start', {})) }), el('button', { class: 'btn', text: 'Check again', disabled: busy, onclick: () => act(step, 'Check', () => api.get('/api/ollama')) })) : null,
    w.reachable ? el('div', { class: 'small', text: w.models.length ? `the run uses ${w.chosen}` : 'no model pulled yet' }) : null,
    ...(w.reachable ? w.models.map((m) => el('div', { class: 'row' }, el('span', { class: `small ${m.fits ? '' : 'warn'}`, text: `${m.name} · ${gb(m.sizeBytes)} on disk · about ${gb(m.residentBytes)} resident · ${m.fits ? `${gb(m.headroomBytes)} headroom` : `${gb(-m.headroomBytes)} over the budget`}${m.parameters ? ` · ${m.parameters}` : ''}${m.quantization ? ` ${m.quantization}` : ''}` }), showRemove ? el('button', { class: 'btn small', text: 'remove', disabled: busy, onclick: () => { if (window.confirm(`Remove ${m.name} from Ollama?`)) act(step, 'Remove', () => api.send('DELETE', `/api/ollama/models/${encodeURIComponent(m.name)}`)); } }) : null)) : []),
    mem ? el('div', { class: 'small muted', text: `memory: ${gb(mem.totalBytes)} total, ${gb(mem.freeBytes)} free as the OS reports it · budget for the model ${gb(mem.budgetBytes)} (half) · resident ≈ ${mem.residentFactor || 1.3}× file size · ${mem.note}` }) : null,
    w.reachable && rec && !w.models.some((m) => m.name === rec) ? el('div', { class: 'row' }, el('button', { class: 'btn primary', text: `Pull ${rec} (about ${gb(recRow.approxBytes)} download)`, disabled: busy || Boolean(w.pulling), onclick: () => act(step, 'Pull', () => api.post('/api/ollama/pull', { model: rec })) })) : null,
    pullLine ? el('div', { class: `small ${pull.error ? 'warn' : ''}`, text: pullLine }) : null,
  ];
}
