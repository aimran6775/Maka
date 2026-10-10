// BUILD window: pick an object kind, then click a tile in a room to place it. Clicking a
// placed object while in build mode reclaims it. The palette comes from the sidecar's
// objectKinds, so the grant text is the harness's own description.
import { el, createWindow } from './windows.js';

export function createBuild({ parent, getState, world, x, y, w }) {
  const { body } = createWindow({ id: 'build', title: 'BUILD', x, y, w, parent });
  const palette = el('div', { class: 'palette' });
  const hint = el('div', { class: 'muted small', text: 'Pick an object, then click a free tile. Click a placed object to reclaim it.' });
  const placed = el('div', { class: 'placed' });
  body.append(palette, hint, placed);
  let active = null;

  function select(kind) {
    active = active === kind ? null : kind;
    world.setBuild(active);
    render();
  }

  function render() {
    const s = getState();
    palette.replaceChildren(
      ...Object.entries(s.objectKinds).map(([kind, def]) =>
        el('button', { class: `btn kind ${active === kind ? 'active' : ''}`, title: def.hint, onclick: () => select(kind) }, el('b', { text: def.label }), el('span', { class: 'muted', text: ` → ${def.grants}` })),
      ),
      active ? el('button', { class: 'btn', text: 'Done', onclick: () => select(active) }) : null,
    );
    placed.replaceChildren(
      ...(s.layout.objects.length ? s.layout.objects : []).map((o) =>
        el('div', { class: 'placed-row' }, `${(s.objectKinds[o.kind] || {}).label || o.kind} @ ${o.x},${o.y}`, ' ', el('span', { class: 'muted', text: `grants ${(s.objectKinds[o.kind] || {}).grants || '?'}` })),
      ),
      s.layout.objects.length ? null : el('div', { class: 'muted', text: 'Nothing placed. The agent has no tools.' }),
    );
  }

  return { render, isActive: () => active !== null };
}
