// Harness state → animation clip and standing place. The only place that decides what the
// Ranger's body does, so the rule "every visual state maps to a real event" is one table.
//
// Agent state comes from frontend/state.js (derived from events). Handoffs come from
// work.handoff events: the Ranger walks the trail from `from` to `to`, interpolated between
// the event's start time and now at WALK_SPEED, never on a loop.

export const WALK_SPEED = 3.2; // world units per second

export const STATE_CLIPS = Object.freeze({
  idle: 'idle',
  thinking: 'idle',
  'tool-running': 'work',
  waiting: 'idle',
  done: 'idle',
  error: 'error',
  walking: 'walk',
});

export function clipFor(agentState, walking) {
  if (walking) return STATE_CLIPS.walking;
  return STATE_CLIPS[agentState] || 'idle';
}

// Where the Ranger stands, in priority order:
//   1. mid-trail while a handoff walk is in progress (`handoff` = { trail, startedAt }, the
//      receiver walks the route from the sender's zone to its own; it ends at home);
//   2. on a delivery walk (`delivery` = { trail, startedAt }): out to the Visitor Center
//      along the route and back home, after a work.done with deliverables;
//   3. at the Gate while waiting on the Superintendent;
//   4. at home.
// Walk times are real: distance along the route at WALK_SPEED from the event's timestamp.
export function placeFor({ agentState, home, gate, handoff, delivery, now, pointAtFraction }) {
  if (handoff && handoff.trail) {
    const elapsed = Math.max(0, (now - handoff.startedAt) / 1000);
    const fraction = Math.min(1, (elapsed * WALK_SPEED) / Math.max(1e-6, handoff.trail.table.length));
    if (fraction < 1) {
      const p = pointAtFraction(handoff.trail.table, fraction);
      return { x: p.x, z: p.z, heading: p.heading, walking: true, fraction, leg: 'handoff' };
    }
  }
  if (delivery && delivery.trail) {
    const length = Math.max(1e-6, delivery.trail.table.length);
    const walked = Math.max(0, (now - delivery.startedAt) / 1000) * WALK_SPEED;
    if (walked < length) {
      const p = pointAtFraction(delivery.trail.table, walked / length);
      return { x: p.x, z: p.z, heading: p.heading, walking: true, fraction: walked / length, leg: 'deliver' };
    }
    if (walked < 2 * length) {
      const back = (2 * length - walked) / length;
      const p = pointAtFraction(delivery.trail.table, back);
      return { x: p.x, z: p.z, heading: p.heading + Math.PI, walking: true, fraction: back, leg: 'return' };
    }
  }
  if (agentState === 'waiting' && gate) return { x: gate.x, z: gate.z, heading: Math.PI, walking: false, fraction: 1, leg: 'gate' };
  return { x: home.x, z: home.z, heading: 0, walking: false, fraction: 1, leg: 'home' };
}

// Body size and tint per role (data for render.js). Juniors are smaller; the Chief is
// taller and wears the Peak's gold; a paused agent is greyed.
export const ROLE_LOOK = Object.freeze({
  chief_ranger: { scale: 1.12, tint: 0xf2c75c },
  ranger: { scale: 1, tint: 0xffffff },
  junior_ranger: { scale: 0.78, tint: 0x9fd0ff },
  superintendent: { scale: 1, tint: 0xffffff },
});

export function lookFor(agent) {
  const base = ROLE_LOOK[(agent && agent.role) || 'ranger'] || ROLE_LOOK.ranger;
  return agent && agent.paused ? { ...base, tint: 0x8a8a8a } : base;
}

// Marker above the Ranger for the inspector-free glance: null means no badge.
export function badgeFor(agentState, { paused = false } = {}) {
  if (paused) return 'paused';
  return { thinking: 'thinking', 'tool-running': 'tool', waiting: 'gate', error: 'error', done: 'done' }[agentState] || null;
}

// Phase 4 step 3: a Radio tower standing at the Mountain Peak carries one lamp per owner
// channel (Telegram, Discord, Slack). The lamp says only what channel.connect proved:
// lit green when the channel is up, red when it failed, dark when it is not wired or
// down; with no channel registry there are no lamps. Towers in the camps show none.
export const LAMP_LOOK = Object.freeze({
  up: { color: 0x3ddc84, emissive: 0x1f9d55, intensity: 1.2 },
  error: { color: 0xd94b3d, emissive: 0x8a2a20, intensity: 0.9 },
  down: { color: 0x4a4f55, emissive: 0x000000, intensity: 0 },
  not_wired: { color: 0x4a4f55, emissive: 0x000000, intensity: 0 },
});

export function lampsFor(channels, { atPeak = true } = {}) {
  if (!atPeak || !channels || !Array.isArray(channels.adapters)) return [];
  return channels.adapters.map((c) => ({ name: c.name, label: c.label || c.name, status: LAMP_LOOK[c.status] ? c.status : 'down', look: LAMP_LOOK[LAMP_LOOK[c.status] ? c.status : 'down'], paired: Array.isArray(c.paired) ? c.paired.length : 0 }));
}
