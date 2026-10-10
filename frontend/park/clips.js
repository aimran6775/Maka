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

// Where the Ranger stands: at the Gate while waiting, else at home, else mid-trail while a
// handoff is in progress. `handoff` = { trail, startedAt } with trail.table from spline.js.
export function placeFor({ agentState, home, gate, handoff, now, pointAtFraction }) {
  if (handoff && handoff.trail) {
    const elapsed = Math.max(0, (now - handoff.startedAt) / 1000);
    const fraction = Math.min(1, (elapsed * WALK_SPEED) / Math.max(1e-6, handoff.trail.table.length));
    const p = pointAtFraction(handoff.trail.table, fraction);
    return { x: p.x, z: p.z, heading: p.heading, walking: fraction < 1, fraction };
  }
  if (agentState === 'waiting' && gate) return { x: gate.x, z: gate.z, heading: Math.PI, walking: false, fraction: 1 };
  return { x: home.x, z: home.z, heading: 0, walking: false, fraction: 1 };
}

// Marker above the Ranger for the inspector-free glance: null means no badge.
export function badgeFor(agentState) {
  return { thinking: 'thinking', 'tool-running': 'tool', waiting: 'gate', error: 'error', done: 'done' }[agentState] || null;
}
