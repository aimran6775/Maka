// BUILD window: pick an object kind, then click a tile in a room to place it. Clicking a
// placed object while in build mode reclaims it. The palette comes from the sidecar's
// objectKinds, so the grant text is the harness's own description.
import { el, createWindow, setChildren } from './windows.js';

export function createBuild({ parent, getState, world, x, y, w }) {
  let activeServer = null; // phase 4 step 4: the MCP server an Outpost is placed for
  const { body } = createWindow({ id: 'build', title: 'BUILD', x, y, w, parent });
  const palette = el('div', { class: 'palette' });
  const hint = el('div', { class: 'muted small', text: 'Pick a fixture, then click a spot inside a zone clearing in the park. Click a placed fixture to reclaim it. A placed fixture is a real tool grant for every Ranger in that zone.' });
  const placed = el('div', { class: 'placed' });
  body.append(palette, hint, placed);
  let active = null;

  function select(kind) {
    if (kind === 'outpost' && active !== 'outpost') {
      // An Outpost grants one MCP server's tools: pick it, with the sanitised descriptions
      // in front of you (the brief's "shown to the Superintendent at placement").
      const s = getState();
      const servers = (s.mcp || []).filter((m) => m.status === 'connected');
      if (!servers.length) { hint.textContent = 'No connected MCP server: add one at the Mountain Peak first.'; return; }
      const lines = servers.map((m, i) => `${i + 1}. ${m.label} (${m.transport}) — ${(m.tools || []).map((t) => `${t.name} [${t.domain}]: ${t.description}`).join('; ') || 'no tools'}`);
      const pick = window.prompt(`Which MCP server does this Outpost grant? Its tools and leash domains:\n\n${lines.join('\n\n')}\n\nEnter the number:`, '1');
      const chosen = servers[Number(pick) - 1];
      if (!chosen) return;
      activeServer = chosen.id;
    }
    active = active === kind ? null : kind;
    if (active !== 'outpost') activeServer = null;
    world.setBuild(active);
    render();
  }

  function render() {
    const s = getState();
    setChildren(palette,
      ...Object.entries(s.objectKinds).map(([kind, def]) => {
        // A fixture grants up to thirty tools. Listing every name turned the panel into a
        // wall of identifiers with the fixtures lost inside it (D167): the button says
        // what the fixture is and how much it grants, and the names are one click away.
        const grants = def.grants || [];
        const summary = grants.length === 0 ? (def.dynamic === 'mcp' ? "an MCP server's tools" : 'no tools') : grants.length <= 2 ? grants.join(', ') : `${grants.length} tools`;
        return el(
          'div',
          { class: 'kind-row' },
          el('button', { class: `btn kind ${active === kind ? 'active' : ''}`, title: def.hint, onclick: () => select(kind) }, el('b', { text: def.label }), el('span', { class: 'muted', text: ` · ${summary}` })),
          grants.length > 2 ? el('details', { class: 'kind-tools' }, el('summary', { class: 'muted small', text: 'what it grants' }), el('div', { class: 'muted small', text: grants.join(', ') })) : null,
        );
      }),
      active ? el('button', { class: 'btn', text: 'Done', onclick: () => select(active) }) : null,
    );
    setChildren(placed,
      ...(s.layout.objects.length ? s.layout.objects : []).map((o) =>
        el('div', { class: 'placed-row' }, `${(s.objectKinds[o.kind] || {}).label || o.kind}${o.server ? ` (${o.server})` : ''} @ ${o.x},${o.y}`, ' ', el('span', { class: 'muted', title: ((s.objectKinds[o.kind] || {}).grants || []).join(', '), text: o.kind === 'outpost' ? `grants the tools of MCP server ${o.server || '?'}` : `grants ${((s.objectKinds[o.kind] || {}).grants || ['?']).length} tool(s)` })),
      ),
      s.layout.objects.length ? null : el('div', { class: 'muted', text: 'Nothing placed. The Ranger has no tools.' }),
    );
  }

  return { render, isActive: () => active !== null, activeKind: () => active, activeServer: () => activeServer };
}
