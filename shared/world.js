// World data shared by the sidecar and the frontend: object kinds (what a placed object
// grants), the layout schema, and the default layout. Theme-specific drawing data lives
// in frontend/theme/*.js; this file is theme-agnostic on purpose so the theme can change
// without touching the permission model.

import { deepFreeze } from './schema.js';

// A placed fixture of kind K in zone R grants every tool in OBJECT_KINDS[K].grants to every
// Ranger whose roomId is R. `label` and `hint` are shown in the build palette. Internally a
// zone is still a "room" and a fixture an "object" (event and field names are frozen).
//
// Only fixtures whose tools exist in phase 1 are listed. The brief's other fixtures (radio
// tower, park store, notice board, fee booth, ledger desk) arrive with their connectors in
// phase 2 and are documented in CODE_MAP.md, not faked here.
export const OBJECT_KINDS = deepFreeze({
  trailhead_sign: { label: 'Trailhead sign', grants: ['web.fetch'], hint: 'Rangers in this zone can fetch public web pages.' },
  supply_cache: { label: 'Supply cache', grants: ['fs.read', 'fs.write'], hint: 'Rangers in this zone can read and write files in their own workspace (writes ask you first at the Entrance Gate).' },
});

export const OBJECT_KIND_NAMES = deepFreeze(Object.keys(OBJECT_KINDS));

const id = { type: 'string', minLength: 1 };
const int0 = { type: 'integer', minimum: 0 };
const int1 = { type: 'integer', minimum: 1 };

// Hierarchy (docs/KICKOFF_BRIEF.md, "Hierarchy and decision model"). Data only in phase 1:
// the Superintendent is the user, a Chief Ranger is judge-tier, Rangers run work, Junior
// Rangers are one trail hop below a Ranger. `parentAgentId` on an agent names who it
// reports to; it is optional so existing layouts stay valid.
export const AGENT_ROLES = deepFreeze(['superintendent', 'chief_ranger', 'ranger', 'junior_ranger']);

export const LAYOUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['version', 'rooms', 'objects', 'agents'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    // Park seed: the 3D terrain and foliage are a pure function of it. Re-rolled by the
    // Superintendent through POST /api/layout/reroll (emits layout.seed).
    seed: { type: 'integer', minimum: 1 },
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
        properties: { id, name: { type: 'string' }, roomId: id, x: int0, y: int0, role: { type: 'string', enum: AGENT_ROLES }, parentAgentId: id },
      },
    },
  },
});

// Tile coordinates are integers; the room rectangle is in tiles.
export const DEFAULT_SEED = 20261010;

export function defaultLayout() {
  return {
    version: 1,
    seed: DEFAULT_SEED,
    rooms: [{ id: 'ranger-station', name: 'Ranger Station', x: 1, y: 1, w: 12, h: 8 }],
    objects: [],
    agents: [{ id: 'ranger', name: 'Ranger', roomId: 'ranger-station', x: 3, y: 4, role: 'ranger' }],
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
    if (kind) for (const t of kind.grants) tools.add(t);
  }
  return [...tools].sort();
}
