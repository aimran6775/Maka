// The park's navigation bar and key legend (D167).
//
// Before this there was no way to learn that the park could be walked at all, and no way
// to reach a zone except by dragging until you found it. The bar carries, left to right:
// where you are, a Jump to menu over every zone, landmark and Ranger, the camera modes,
// and the key legend — which is rendered from the same table render.js listens to
// (park/controls.js KEY_MAP), so what a person is shown is what the park does.

import { el, setChildren } from './windows.js';
import { KEY_MAP } from '../park/controls.js';

export function createNav({ parent, getState, getPark, api, onFlash = () => {} }) {
  const where = el('span', { class: 'nav-where', text: 'the park' });
  const jump = el('select', { class: 'sel nav-jump', title: 'Jump to a place or a Ranger (J)' });
  const modes = el('span', { class: 'nav-modes' });
  const keysBtn = el('button', { class: 'btn small', text: 'keys ?', title: 'Show the keys (?)', onclick: () => toggleKeys() });
  const bar = el('nav', { class: 'nav-bar' }, el('span', { class: 'nav-brand', text: 'MAKA' }), where, jump, modes, keysBtn);

  const legend = el('div', { class: 'keys-host', hidden: true });
  parent.append(bar, legend);

  function toggleKeys(show) {
    legend.hidden = show === undefined ? !legend.hidden : !show;
    if (!legend.hidden) renderKeys();
  }

  function renderKeys() {
    setChildren(
      legend,
      el(
        'div',
        { class: 'keys-card' },
        el('div', { class: 'keys-head' }, el('span', { text: 'KEYS' }), el('button', { class: 'btn small', text: 'close', onclick: () => toggleKeys(false) })),
        ...KEY_MAP.map((g) =>
          el(
            'div',
            { class: 'keys-group' },
            el('div', { class: 'keys-group-title', text: g.group }),
            ...g.rows.map((r) =>
              el(
                'div',
                { class: 'keys-row' },
                el('span', { class: 'keys-keys' }, ...r.keys.map((k) => el('kbd', { text: k })), ...(r.also || []).map((k) => el('kbd', { class: 'alt', text: k }))),
                el('span', { class: 'keys-what', text: r.what }),
              ),
            ),
          ),
        ),
        el('div', { class: 'keys-foot muted small', text: 'Click a Ranger, a zone, a trail, the Gate or the Peak to inspect it. Place fixtures from BUILD by clicking inside a clearing.' }),
      ),
    );
  }

  // The menu's options, rebuilt only when the places change, so an open menu is not
  // yanked out from under the pointer on every frame.
  let signature = '';
  function renderJump() {
    const park = getPark();
    const places = park && park.places ? park.places() : [];
    const sig = places.map((p) => `${p.kind}:${p.id}:${p.name}`).join('|');
    if (sig === signature) return;
    signature = sig;
    const label = { peak: 'Landmark', gate: 'Landmark', zone: 'Zone', agent: 'Crew' };
    const groups = new Map();
    for (const p of places) {
      const k = label[p.kind] || 'Place';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    setChildren(
      jump,
      el('option', { value: '', text: places.length ? 'Jump to…' : 'Jump to… (the park is loading)' }),
      ...[...groups].map(([name, items]) => el('optgroup', { label: name }, ...items.map((p) => el('option', { value: `${p.kind}:${p.id}`, text: p.name })))),
    );
  }

  function goTo(value) {
    const park = getPark();
    if (!park || !value) return;
    const place = (park.places() || []).find((p) => `${p.kind}:${p.id}` === value);
    if (!place) return;
    park.focus(place, place.kind === 'agent' ? { distance: 14, height: 7 } : { distance: Math.max(26, place.radius * 2.2), height: Math.max(14, place.radius) });
    where.textContent = place.name;
    jump.value = '';
  }

  // The landmark shortcuts: the first place of a kind, or the named zone for home.
  function goToKind(kind) {
    const park = getPark();
    if (!park) return;
    const places = park.places() || [];
    const place = kind === 'home' ? places.find((p) => p.kind === 'zone') : places.find((p) => p.kind === kind);
    if (!place) return onFlash(`no ${kind === 'home' ? 'zone' : kind} in the park yet`, 'warn');
    goTo(`${place.kind}:${place.id}`);
  }

  jump.addEventListener('change', () => goTo(jump.value));

  function renderModes() {
    const park = getPark();
    const mode = park ? park.cameraMode : null;
    setChildren(
      modes,
      ...[
        ['orbit', 'walk and orbit the park (1)'],
        ['fly', 'circle the station (2)'],
        ['follow', 'ride with the selected Ranger (3)'],
      ].map(([m, title]) =>
        el('button', {
          class: `btn small ${mode === m ? 'active' : ''}`,
          text: m,
          title,
          disabled: !park,
          onclick: () => {
            park.setCameraMode(m);
            render();
          },
        }),
      ),
      el('button', { class: 'btn small', text: 're-roll', title: 'New terrain seed (persisted by the sidecar)', onclick: async () => onFlash(await api.post('/api/layout/reroll', {})) }),
    );
  }

  function render() {
    renderJump();
    renderModes();
  }

  return {
    render,
    toggleKeys,
    goToKind,
    openJump() {
      jump.focus();
      if (typeof jump.showPicker === 'function') {
        try {
          jump.showPicker();
        } catch {
          /* a browser that will not open a select from script: the focus is enough */
        }
      }
    },
    setWhere(text) {
      where.textContent = text || 'the park';
    },
  };
}
