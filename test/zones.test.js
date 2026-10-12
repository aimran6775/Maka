// Arranging the park (D168): zones keep a gap between them, a zone moves with everything
// standing in it, a point in the park maps back to a tile, and the sidecar refuses a
// layout whose zones overlap while telling the page that a zone appeared or moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomsOverlap, overlappingRooms, moveRoom, freeZoneRect, ZONE_GAP, defaultLayout } from '../shared/world.js';
import { tileToWorld, worldToTile } from '../frontend/park/placement.js';
import { startTestServer } from './helpers/test-server.js';

test('zones keep a tile between them: touching rectangles overlap, a gap apart they do not', () => {
  const a = { id: 'a', x: 0, y: 0, w: 4, h: 4 };
  assert.equal(roomsOverlap(a, { id: 'b', x: 2, y: 2, w: 4, h: 4 }), true, 'plainly on top of each other');
  assert.equal(roomsOverlap(a, { id: 'b', x: 4, y: 0, w: 4, h: 4 }), true, `edge to edge is not ${ZONE_GAP} tile apart`);
  assert.equal(roomsOverlap(a, { id: 'b', x: 5, y: 0, w: 4, h: 4 }), false, 'a tile of clear ground between them');
  assert.equal(roomsOverlap(a, { id: 'b', x: 0, y: 9, w: 4, h: 4 }), false, 'clear the other way too');

  assert.equal(overlappingRooms({ rooms: [a, { id: 'b', x: 5, y: 0, w: 4, h: 4 }] }), null);
  const clash = overlappingRooms({ rooms: [a, { id: 'b', x: 5, y: 0, w: 4, h: 4 }, { id: 'c', x: 1, y: 1, w: 2, h: 2 }] });
  assert.deepEqual(clash && clash.map((r) => r.id), ['a', 'c'], 'the first pair that clashes is named');
  assert.equal(overlappingRooms({ rooms: [] }), null);
  assert.equal(overlappingRooms(null), null);
  // Whatever freeZoneRect finds never clashes with what is already there.
  const layout = { rooms: [a, { id: 'b', x: 9, y: 2, w: 6, h: 6 }] };
  const found = freeZoneRect(layout, { w: 5, h: 5 });
  assert.equal(overlappingRooms({ rooms: [...layout.rooms, { id: 'new', ...found }] }), null);
});

test('a zone moves with its fixtures and its crew, and refuses to go off the grid', () => {
  const layout = {
    version: 1,
    rooms: [{ id: 'camp', name: 'Camp', x: 10, y: 10, w: 4, h: 4 }, { id: 'other', name: 'Other', x: 0, y: 0, w: 4, h: 4 }],
    objects: [{ id: 'o1', kind: 'supply_cache', roomId: 'camp', x: 11, y: 12 }, { id: 'o2', kind: 'supply_cache', roomId: 'other', x: 1, y: 1 }],
    agents: [{ id: 'ada', name: 'Ada', roomId: 'camp', x: 12, y: 11 }, { id: 'bo', name: 'Bo', roomId: 'other', x: 2, y: 2 }],
  };
  const moved = moveRoom(layout, 'camp', { x: 4, y: 20 });
  assert.deepEqual(moved.rooms.find((r) => r.id === 'camp'), { id: 'camp', name: 'Camp', x: 4, y: 20, w: 4, h: 4 });
  // Everything in the zone shifted by the same delta (-6, +10); everything else sat still.
  assert.deepEqual(moved.objects.find((o) => o.id === 'o1'), { id: 'o1', kind: 'supply_cache', roomId: 'camp', x: 5, y: 22 });
  assert.deepEqual(moved.agents.find((a) => a.id === 'ada'), { id: 'ada', name: 'Ada', roomId: 'camp', x: 6, y: 21 });
  assert.deepEqual(moved.objects.find((o) => o.id === 'o2'), layout.objects[1], 'another zone keeps its fixtures where they were');
  assert.deepEqual(moved.agents.find((a) => a.id === 'bo'), layout.agents[1]);
  // The input is untouched: the move is a new layout, not an edit in place.
  assert.equal(layout.rooms[0].x, 10);

  assert.equal(moveRoom(layout, 'camp', { x: 10, y: 10 }), layout, 'a move to where it already is changes nothing');
  assert.equal(moveRoom(layout, 'nope', { x: 1, y: 1 }), null, 'an unknown zone');
  assert.equal(moveRoom(layout, 'camp', { x: -1, y: 0 }), null, 'off the grid');
  assert.equal(moveRoom(layout, 'camp', { x: 1.5, y: 0 }), null, 'tiles are whole numbers');
  assert.ok(moveRoom(layout, 'camp', { x: 0, y: 0 }), 'a zone whose things sit inside it can always reach the corner');
  // A hand-written layout can put a fixture outside the zone it belongs to; moving the
  // zone must not push it onto a tile that cannot exist.
  const strayed = { ...layout, objects: [{ id: 'o3', kind: 'supply_cache', roomId: 'camp', x: 2, y: 11 }] };
  assert.equal(moveRoom(strayed, 'camp', { x: 7, y: 10 }), null, 'a strayed fixture would land on a negative tile');
});

test('a point in the park maps back to the tile it stands on', () => {
  for (const [tx, ty] of [[0, 0], [7, 7], [12, 3], [40, 25]]) {
    const w = tileToWorld(tx, ty);
    assert.deepEqual(worldToTile(w), { tx, ty }, `${tx},${ty} round-trips`);
  }
  assert.deepEqual(worldToTile({ x: -1e6, z: -1e6 }), { tx: 0, ty: 0 }, 'west of the grid clamps to its corner');
});

test('the sidecar: moving a zone tells the page, and a layout whose zones overlap is refused', async () => {
  const h = await startTestServer({});
  try {
    const stream = await h.sse(0);
    const layout = (await h.get('/api/layout')).body;
    const room = layout.rooms[0];
    const roomEvents = () => stream.events.filter((e) => e.type === 'layout.room');
    const seen = () => roomEvents().map((e) => [e.payload.change, e.payload.roomId]);

    // A new zone reaches the page as `created`, which is what a camp the Chief hires into
    // depends on: before D168 the page only knew the zones its first snapshot carried.
    const withCamp = { ...layout, rooms: [...layout.rooms, { id: 'camp', name: 'Camp', kind: 'research', x: 40, y: 40, w: 4, h: 4 }] };
    assert.equal((await h.put('/api/layout', withCamp)).status, 200);
    await stream.waitFor((e) => e.type === 'layout.room' && e.payload.change === 'created');
    assert.deepEqual(seen(), [['created', 'camp']]);

    // Moving it says so, with the zone's new rectangle on the event.
    const moved = await h.post('/api/layout/move', { roomId: 'camp', x: 30, y: 44 });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.rooms.find((r) => r.id === 'camp'), { id: 'camp', name: 'Camp', kind: 'research', x: 30, y: 44, w: 4, h: 4 });
    await stream.waitFor((e) => e.type === 'layout.room' && e.payload.change === 'moved');
    assert.deepEqual(seen().at(-1), ['moved', 'camp']);
    const ev = roomEvents().at(-1);
    assert.equal(ev.payload.room.x, 30);

    // Onto another zone: refused, named, and nothing moved.
    const clash = await h.post('/api/layout/move', { roomId: 'camp', x: room.x, y: room.y });
    assert.equal(clash.status, 400);
    assert.equal(clash.body.code, 'ZONES_OVERLAP');
    assert.match(clash.body.error, /camp/);
    assert.equal((await h.get('/api/layout')).body.rooms.find((r) => r.id === 'camp').x, 30, 'the refused move did not happen');

    const offGrid = await h.post('/api/layout/move', { roomId: 'camp', x: -3, y: 0 });
    assert.equal(offGrid.status, 400);
    assert.equal(offGrid.body.code, 'BAD_MOVE');
    assert.equal((await h.post('/api/layout/move', { roomId: 'nope', x: 1, y: 1 })).status, 400);

    // Removing it says so too.
    const without = { ...(await h.get('/api/layout')).body };
    without.rooms = without.rooms.filter((r) => r.id !== 'camp');
    without.objects = without.objects.filter((o) => o.roomId !== 'camp');
    without.agents = without.agents.filter((a) => a.roomId !== 'camp');
    assert.equal((await h.put('/api/layout', without)).status, 200);
    await stream.waitFor((e) => e.type === 'layout.room' && e.payload.change === 'removed');
    assert.deepEqual(seen().at(-1), ['removed', 'camp']);
  } finally {
    await h.close();
  }
});

test('the park model and the page agree about a moved zone', async () => {
  const { applyEvent, initialState, applySnapshot } = await import('../frontend/state.js');
  const { makeEvent } = await import('../shared/events.js');
  const layout = {
    ...defaultLayout(),
    rooms: [{ id: 'ranger-station', name: 'Ranger Station', x: 5, y: 5, w: 6, h: 6 }],
    objects: [{ id: 'o1', kind: 'supply_cache', roomId: 'ranger-station', x: 6, y: 6 }],
    agents: [{ id: 'ranger', name: 'Ranger', roomId: 'ranger-station', x: 7, y: 7 }],
  };
  let s = applySnapshot(initialState(), { layout, seq: 0 });
  const room = { id: 'ranger-station', name: 'Ranger Station', x: 15, y: 5, w: 6, h: 6 };
  s = applyEvent(s, makeEvent('layout.room', { change: 'moved', roomId: 'ranger-station', room }, { seq: 1 }));
  // The page shifts the fixture and the Ranger exactly as the sidecar did (both call
  // shared/world.js moveRoom), so what it draws matches what the sidecar saved.
  assert.deepEqual(s.layout.rooms[0], room);
  assert.deepEqual(s.layout.objects[0], { id: 'o1', kind: 'supply_cache', roomId: 'ranger-station', x: 16, y: 6 });
  assert.deepEqual(s.layout.agents[0], { id: 'ranger', name: 'Ranger', roomId: 'ranger-station', x: 17, y: 7 });
  assert.deepEqual(s.layout, moveRoom(layout, 'ranger-station', { x: 15, y: 5 }), 'the same layout the sidecar holds');

  // A zone the page has never seen is added, and a removal takes it away again.
  s = applyEvent(s, makeEvent('layout.room', { change: 'created', roomId: 'camp', room: { id: 'camp', name: 'Camp', x: 30, y: 30, w: 4, h: 4 } }, { seq: 2 }));
  assert.deepEqual(s.layout.rooms.map((r) => r.id), ['ranger-station', 'camp']);
  s = applyEvent(s, makeEvent('layout.room', { change: 'removed', roomId: 'camp' }, { seq: 3 }));
  assert.deepEqual(s.layout.rooms.map((r) => r.id), ['ranger-station']);
});
