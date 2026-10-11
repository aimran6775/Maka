// The park's controls as data (frontend/park/controls.js, D167): the key legend the UI
// renders, the movement render.js reads every frame, and the places the Jump to menu
// offers. Pure, so it runs under node with no DOM and no Three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_MAP, MOVE_CODES, MOVE_SPEED, MOVE_SPRINT, movementFromKeys, isTyping, placesFor } from '../frontend/park/controls.js';

test('the key legend is one table, and every movement key in it is a key the park listens to', () => {
  assert.ok(KEY_MAP.length >= 3);
  for (const group of KEY_MAP) {
    assert.ok(group.group && group.rows.length, `${group.group} has rows`);
    for (const row of group.rows) {
      assert.ok(row.keys.length, 'a row names its keys');
      assert.ok(row.what && row.what.length > 8, `"${row.what}" says what the key does`);
    }
  }
  // The legend promises WASD, the arrows and Q/E; MOVE_CODES is what render.js consumes.
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.ok(MOVE_CODES.includes(code), `${code} is consumed by the park`);
  }
  const shown = KEY_MAP.flatMap((g) => g.rows.flatMap((r) => [...r.keys, ...(r.also || [])]));
  for (const k of ['W', 'A', 'S', 'D', 'Q', 'E', 'Shift', 'J', 'P', 'G', 'H', '?']) {
    assert.ok(shown.includes(k), `${k} is in the legend`);
  }
});

test('movement: nothing without keys, camera-relative with keys, diagonals never faster, sprint multiplies', () => {
  const none = movementFromKeys(new Set());
  assert.deepEqual([none.forward, none.right, none.up, none.moving], [0, 0, 0, false]);

  const fwd = movementFromKeys(new Set(['KeyW']));
  assert.equal(fwd.forward, MOVE_SPEED);
  assert.equal(fwd.right, 0);
  assert.ok(fwd.moving);
  assert.equal(movementFromKeys(new Set(['ArrowUp'])).forward, MOVE_SPEED, 'the arrows do what WASD does');
  assert.equal(movementFromKeys(new Set(['KeyS'])).forward, -MOVE_SPEED);
  assert.equal(movementFromKeys(new Set(['KeyD'])).right, MOVE_SPEED);
  assert.equal(movementFromKeys(new Set(['KeyA'])).right, -MOVE_SPEED);

  // Opposite keys cancel; a diagonal is the same speed as a straight line.
  const both = movementFromKeys(new Set(['KeyW', 'KeyS']));
  assert.deepEqual([both.forward, both.right], [0, 0]);
  const diag = movementFromKeys(new Set(['KeyW', 'KeyD']));
  assert.ok(Math.abs(Math.hypot(diag.forward, diag.right) - MOVE_SPEED) < 1e-9, 'a diagonal is not faster');

  // Up and down are their own axis and are not part of that budget.
  assert.equal(movementFromKeys(new Set(['KeyE'])).up, MOVE_SPEED);
  assert.equal(movementFromKeys(new Set(['KeyQ'])).up, -MOVE_SPEED);

  const sprint = movementFromKeys(new Set(['KeyW']), { sprint: true });
  assert.ok(Math.abs(sprint.forward - MOVE_SPEED * MOVE_SPRINT) < 1e-9);
});

test('typing is never movement', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isTyping({ tagName: tag }), true, tag);
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: 'DIV' }), false);
  assert.equal(isTyping({ tagName: 'CANVAS' }), false);
  assert.equal(isTyping(null), false);
});

test('jump places: the landmarks first, then the zones, then the crew, each with somewhere to stand', () => {
  assert.deepEqual(placesFor(null), []);
  const model = {
    clearings: [
      { id: 'ranger-station', kind: 'zone', name: 'Ranger Station', x: 0, z: 0, height: 2, radius: 18 },
      { id: 'gate:ranger-station', kind: 'gate', name: 'Entrance Gate', zoneId: 'ranger-station', x: 0, z: 44, height: 1, radius: 9 },
      { id: 'mountain-peak', kind: 'peak', name: 'Mountain Peak', x: -60, z: -60, height: 24, radius: 8 },
      { id: 'camp', kind: 'zone', name: 'Atelier camp', x: 40, z: 10, height: 3, radius: 12 },
    ],
    agents: [{ id: 'ranger', name: 'Ada', home: { x: 1, z: 2, y: 2 } }, { id: 'nowhere' }],
  };
  const places = placesFor(model, model.agents);
  assert.deepEqual(places.map((p) => p.kind), ['peak', 'gate', 'zone', 'zone', 'agent'], 'landmarks, then zones, then crew');
  assert.deepEqual(places.map((p) => p.name), ['Mountain Peak', 'Entrance Gate', 'Atelier camp', 'Ranger Station', 'Ada']);
  assert.equal(places.filter((p) => p.id === 'nowhere').length, 0, 'an agent with no home is not a place to jump to');
  for (const p of places) {
    for (const k of ['x', 'z', 'y', 'radius']) assert.ok(Number.isFinite(p[k]), `${p.name} has a finite ${k}`);
  }
});
