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
  // Phase 2 step 12: the station's mail. Reads are research; sends fall under
  // outbound_messages (replies, notifications) or publishing (campaigns); a new address is
  // account_creation. Each is enforced by the leash at the Entrance Gate.
  radio_tower: { label: 'Radio tower', grants: ['mail.search', 'mail.read', 'mail.draft', 'mail.send', 'mail.create_address'], hint: "Rangers in this zone can read their station's mail, draft and send replies, notifications and campaigns, and ask for a venture address; sends and new addresses follow the leash." },
  // Phase 2 step 13: a real Chromium per Ranger, every action under browser_control;
  // logins, one-time codes, captchas and payment pages are handed to the Superintendent.
  // Phase 2 step 14: platform connectors (official APIs). The framework's own tools are
  // research; each connector adds read tools and leashed write tools (steps 15–17).
  park_store: { label: 'Park Store', grants: ['connector.status', 'connector.sync'], hint: 'Rangers in this zone use the commerce connectors (Shopify, Etsy): read what the syncs brought in and refresh them; platform writes follow their leash.' },
  // Phase 2 step 15: payments (Stripe). Reads are research; a refund is money_out.
  fee_booth: { label: 'Fee booth', grants: ['connector.status', 'connector.sync', 'stripe.balance', 'stripe.charges', 'stripe.payouts', 'stripe.refunds', 'stripe.refund'], hint: 'Rangers in this zone read the Stripe balance, charges, payouts and refunds from the last sync, and can refund a charge under the money_out leash and its daily cap.' },
  field_office: { label: 'Field office', grants: ['browser.open', 'browser.read', 'browser.click', 'browser.type', 'browser.upload', 'browser.download', 'browser.screenshot'], hint: 'Rangers in this zone drive a real browser with their own profile (open, read, click, type, upload, download, screenshot) under the browser_control leash; a login, code, captcha or payment page is handed to you.' },
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

// Who may report to whom (phase 2 step 3). A Junior Ranger is one hop below a Ranger and
// may not have Juniors of its own; the Chief Ranger is a singleton at the Mountain Peak.
export const PARENT_ROLES = deepFreeze({
  superintendent: [],
  chief_ranger: ['superintendent'],
  ranger: ['chief_ranger', 'superintendent'],
  junior_ranger: ['ranger'],
});

// Specialties (docs/KICKOFF_BRIEF.md, "Business scope"): a persona + the department that
// hosts it. Data only; the Chief staffs ventures with these in step 5.
export const SPECIALTIES = deepFreeze({
  scout: { label: 'Scout Ranger', zoneKind: 'research', persona: 'You find opportunities: study publicly visible success stories, trends and niches, and produce venture briefs with evidence, costs and a go/no-go for the judge. Replicate strategies, never property.' },
  storefront: { label: 'Storefront Ranger', zoneKind: 'product_listings', persona: 'You run Etsy / Shopify / dropshipping stores: original listings, pricing proposals, supplier orders and fulfilment status. Every platform action goes through its official API under its terms.' },
  ads: { label: 'Ads Ranger', zoneKind: 'marketing', persona: 'You create and manage ad campaigns, report real spend and results, and propose budget changes; money out always passes the Entrance Gate.' },
  marketing: { label: 'Marketing Ranger', zoneKind: 'marketing', persona: 'You do content, social, email campaigns and SEO with original copy and creative, under the publishing and outbound_messages leashes.' },
  support: { label: 'Support Ranger', zoneKind: 'operations_support', persona: 'You handle customer email and chat, returns and reviews, truthfully and politely, and escalate refunds and anything irreversible to the Gate.' },
  books: { label: 'Books Ranger', zoneKind: 'finance', persona: 'You keep orders, refunds, fees and the daily P&L from real connector data only. You never estimate revenue.' },
});
export const SPECIALTY_NAMES = deepFreeze(Object.keys(SPECIALTIES));

// Tools granted by role rather than by a fixture (phase 2 step 3). The capability gate
// unions these with the fixture grants of the agent's zone.
export const ROLE_GRANTS = deepFreeze({
  superintendent: [],
  chief_ranger: ['crew.spawn_junior', 'delegate', 'work.check', 'plan.submit', 'crew.hire'],
  ranger: ['crew.spawn_junior', 'delegate', 'work.check'],
  junior_ranger: [],
});

export function roleGrants(role) {
  return ROLE_GRANTS[role] ? [...ROLE_GRANTS[role]] : [];
}

// Zone kinds (docs/KICKOFF_BRIEF.md, "The park" and "Operating systems inside Maka").
// Phase 1 builds the Ranger Station, the Entrance Gate and the Mountain Peak; the
// department zones and the others are names a layout may use, nothing more yet.
export const ZONE_KINDS = deepFreeze([
  'ranger_station',
  'entrance_gate',
  'mountain_peak',
  'visitor_center',
  'trailhead',
  'sales',
  'marketing',
  'finance',
  'operations_support',
  'research',
  'product_listings',
]);

// Display names for zone kinds (the park's signage and the Chief's zone creation).
export const ZONE_LABELS = deepFreeze({
  ranger_station: 'Ranger Station',
  entrance_gate: 'Entrance Gate',
  mountain_peak: 'Mountain Peak',
  visitor_center: 'Visitor Center',
  trailhead: 'Trailhead',
  sales: 'Sales Camp',
  marketing: 'Marketing Camp',
  finance: 'Finance Camp',
  operations_support: 'Operations & Support Camp',
  research: 'Research Camp',
  product_listings: 'Product & Listings Camp',
});

// A rectangle for a new zone that overlaps no existing room: rooms are laid out on a grid
// of (w + 2) × (h + 2) cells, left to right, then the next row.
export function freeZoneRect(layout, { w = 8, h = 6 } = {}) {
  const overlaps = (r) => layout.rooms.some((o) => r.x < o.x + o.w + 1 && o.x < r.x + r.w + 1 && r.y < o.y + o.h + 1 && o.y < r.y + r.h + 1);
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 20; col++) {
      const r = { x: 1 + col * (w + 2), y: 1 + row * (h + 2), w, h };
      if (!overlaps(r)) return r;
    }
  }
  return null;
}

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
        // `venture` (phase 2 step 7, optional): a trailhead room names the venture whose
        // trails run to the camps that serve it.
        properties: { id, name: { type: 'string' }, x: int0, y: int0, w: int1, h: int1, kind: { type: 'string', enum: ZONE_KINDS }, venture: { type: 'string' } },
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
        properties: {
          id,
          name: { type: 'string' },
          roomId: id,
          x: int0,
          y: int0,
          role: { type: 'string', enum: AGENT_ROLES },
          parentAgentId: id,
          // Phase 2 step 3 agent record fields (all optional, additive).
          venture: { type: 'string' },
          specialty: { type: 'string', enum: SPECIALTY_NAMES },
          persona: { type: 'string', maxLength: 4000 },
          policy: { type: 'object', additionalProperties: false, properties: { worker: { type: 'object', required: ['provider'], additionalProperties: false, properties: { provider: { type: 'string', minLength: 1 }, model: { type: 'string' } } } } },
          createdBy: { type: 'string' },
          createdAt: int0,
          budgetUsd: { type: 'number', minimum: 0 },
          // Phase 2 step 7: a paused agent gets no new runs until resumed.
          paused: { type: 'boolean' },
        },
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
    rooms: [{ id: 'ranger-station', name: 'Ranger Station', kind: 'ranger_station', x: 1, y: 1, w: 12, h: 8 }],
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

// Fixture grants plus role grants (phase 2 step 3).
export function allGrantsFor(layout, agentId) {
  const agent = agentOf(layout, agentId);
  if (!agent) return [];
  return [...new Set([...grantsFor(layout, agentId), ...roleGrants(agent.role || 'ranger')])].sort();
}

// Agents whose parentAgentId is `agentId`.
export function childrenOf(layout, agentId) {
  return layout.agents.filter((a) => a.parentAgentId === agentId);
}

// First free tile inside a room (not under an object or an agent), scanning row by row.
export function freeTile(layout, room, { avoid = [] } = {}) {
  const taken = new Set([...layout.objects.map((o) => `${o.x},${o.y}`), ...layout.agents.map((a) => `${a.x},${a.y}`), ...avoid]);
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) if (!taken.has(`${x},${y}`)) return { x, y };
  }
  return null;
}
