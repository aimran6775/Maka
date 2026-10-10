// World data shared by the sidecar and the frontend: object kinds (what a placed object
// grants), the layout schema, and the default layout. Theme-specific drawing data lives
// in frontend/theme/*.js; this file is theme-agnostic on purpose so the theme can change
// without touching the permission model.

import { deepFreeze } from './schema.js';

// A placed object of kind K in room R grants tool OBJECT_KINDS[K].grants to every agent
// whose roomId is R. `label` and `hint` are shown in the build palette.
export const OBJECT_KINDS = deepFreeze({
  bookshelf: { label: 'Bookshelf', grants: 'fs.read', hint: 'Lets agents in this room read files in their workspace.' },
  workbench: { label: 'Workbench', grants: 'fs.write', hint: 'Lets agents in this room write files in their workspace (asks you first).' },
  window: { label: 'Window', grants: 'web.fetch', hint: 'Lets agents in this room fetch public web pages.' },
});

export const OBJECT_KIND_NAMES = deepFreeze(Object.keys(OBJECT_KINDS));

const id = { type: 'string', minLength: 1 };
const int0 = { type: 'integer', minimum: 0 };
const int1 = { type: 'integer', minimum: 1 };

export const LAYOUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['version', 'rooms', 'objects', 'agents'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'x', 'y', 'w', 'h'],
        additionalProperties: false,
        properties: { id, name: { type: 'string' }, x: int0, y: int0, w: int1, h: int1 },
      },
    },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'roomId', 'x', 'y'],
        additionalProperties: false,
        properties: { id, kind: { type: 'string', enum: OBJECT_KIND_NAMES }, roomId: id, x: int0, y: int0 },
      },
    },
    agents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'roomId', 'x', 'y'],
        additionalProperties: false,
        properties: { id, name: { type: 'string' }, roomId: id, x: int0, y: int0 },
      },
    },
  },
});

// Tile coordinates are integers; the room rectangle is in tiles.
export function defaultLayout() {
  return {
    version: 1,
    rooms: [{ id: 'atelier', name: 'Atelier', x: 1, y: 1, w: 12, h: 8 }],
    objects: [],
    agents: [{ id: 'hero', name: 'Hero', roomId: 'atelier', x: 3, y: 4 }],
  };
}

export function roomOf(layout, roomId) {
  return layout.rooms.find((r) => r.id === roomId) || null;
}

export function agentOf(layout, agentId) {
  return layout.agents.find((a) => a.id === agentId) || null;
}

// True when tile (x, y) is inside the room rectangle.
export function tileInRoom(room, x, y) {
  return x >= room.x && y >= room.y && x < room.x + room.w && y < room.y + room.h;
}

// Tool names granted to an agent by the objects placed in its room, sorted, deduplicated.
export function grantsFor(layout, agentId) {
  const agent = agentOf(layout, agentId);
  if (!agent) return [];
  const tools = new Set();
  for (const o of layout.objects) {
    if (o.roomId !== agent.roomId) continue;
    const kind = OBJECT_KINDS[o.kind];
    if (kind) tools.add(kind.grants);
  }
  return [...tools].sort();
}
