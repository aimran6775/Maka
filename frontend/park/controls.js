// What the keyboard does in the park, as data and pure functions (D167). render.js reads
// the movement vector every frame and the UI renders the same table as the key legend, so
// the keys a person is shown are the keys the park actually listens to — there is no
// second list to drift.
//
// No Three.js and no DOM here, so it is tested under node.

// The legend, in the order it is shown. `keys` are what the person presses; `code` names
// the KeyboardEvent.code values that drive it, where there is one.
export const KEY_MAP = Object.freeze([
  {
    group: 'Move',
    rows: [
      { keys: ['W', 'A', 'S', 'D'], also: ['↑', '←', '↓', '→'], what: 'Walk the view over the park' },
      { keys: ['Q', 'E'], what: 'Drop lower, rise higher' },
      { keys: ['Shift'], what: 'Hold to move faster' },
      { keys: ['drag'], what: 'Turn the camera (left mouse)' },
      { keys: ['scroll'], what: 'Closer and further away' },
    ],
  },
  {
    group: 'Go to',
    rows: [
      { keys: ['J'], what: 'Jump to… a zone, the Peak, the Gate or a Ranger' },
      { keys: ['P'], what: 'The Mountain Peak' },
      { keys: ['G'], what: 'The Entrance Gate' },
      { keys: ['H'], what: 'Home: the Ranger Station' },
      { keys: ['F'], what: 'Follow the selected Ranger' },
    ],
  },
  {
    group: 'Look',
    rows: [
      { keys: ['1', '2', '3'], what: 'Orbit, fly-around, follow' },
      { keys: ['Esc'], what: 'Close this, drop the selection' },
      { keys: ['?'], what: 'Show and hide these keys' },
      { keys: ['`'], what: 'Frame-time overlay' },
    ],
  },
]);

// Every KeyboardEvent.code the park consumes, so a key the park uses never also scrolls
// the page or types into the brief.
export const MOVE_CODES = Object.freeze(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'KeyQ', 'KeyE']);

export const MOVE_SPEED = 26; // world units a second
export const MOVE_SPRINT = 3.2; // multiplier while Shift is held

// The movement a set of held keys asks for, in camera-relative units:
//   forward  away from the camera over the ground
//   right    to the camera's right
//   up       straight up
// Pure: `pressed` is a Set of KeyboardEvent.code values. Diagonals are normalised so
// pressing two keys never moves faster than pressing one.
export function movementFromKeys(pressed, { sprint = false } = {}) {
  const on = (code) => pressed.has(code);
  let forward = (on('KeyW') || on('ArrowUp') ? 1 : 0) - (on('KeyS') || on('ArrowDown') ? 1 : 0);
  let right = (on('KeyD') || on('ArrowRight') ? 1 : 0) - (on('KeyA') || on('ArrowLeft') ? 1 : 0);
  const up = (on('KeyE') ? 1 : 0) - (on('KeyQ') ? 1 : 0);
  const flat = Math.hypot(forward, right);
  if (flat > 1) {
    forward /= flat;
    right /= flat;
  }
  const speed = MOVE_SPEED * (sprint ? MOVE_SPRINT : 1);
  return { forward: forward * speed, right: right * speed, up: up * speed, moving: Boolean(forward || right || up) };
}

// Whether a keystroke belongs to the park at all: never while the person is typing.
export function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

// The places a person can jump to, from the park model: the zones and landmarks first in
// a fixed order, then the crew. Pure, so the menu and any test agree on what exists.
export function placesFor(model, agents = []) {
  if (!model) return [];
  const rank = { peak: 0, gate: 1, zone: 2 };
  const out = model.clearings
    .map((c) => ({
      id: c.id,
      kind: c.kind === 'zone' ? 'zone' : c.kind,
      name: c.kind === 'gate' ? 'Entrance Gate' : c.name,
      x: c.x,
      z: c.z,
      y: c.height,
      radius: c.radius,
    }))
    .sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) || a.name.localeCompare(b.name));
  for (const a of agents) {
    if (!a.home) continue;
    out.push({ id: a.id, kind: 'agent', name: a.name || a.id, x: a.home.x, z: a.home.z, y: a.home.y, radius: 3 });
  }
  return out;
}
