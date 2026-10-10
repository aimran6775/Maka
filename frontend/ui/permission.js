// Permission card: one card per pending permission.prompt. Allow/Deny posts
// permission.response; the card disappears only when the sidecar echoes the response
// (or the run ends), never on click alone.
import { el } from './windows.js';

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

  return {
    render() {
      const s = getState();
      const key = s.pendingPrompts.map((q) => q.promptId).join('|');
      if (key === shown) return;
      shown = key;
      host.replaceChildren(
        ...s.pendingPrompts.map((q) =>
          el('div', { class: 'perm-card' },
            el('div', { class: 'perm-title', text: `Allow ${q.tool}?` }),
            el('div', { class: 'muted small', text: q.reason }),
            el('pre', { class: 'perm-input', text: summarize(q.input) }),
            el('div', { class: 'row' },
              el('button', { class: 'btn primary', text: 'Allow', onclick: () => answer(q, true) }),
              el('button', { class: 'btn', text: 'Deny', onclick: () => answer(q, false) }),
              el('span', { class: 'muted small', text: `run ${q.runId}` }),
            ),
          ),
        ),
      );
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
