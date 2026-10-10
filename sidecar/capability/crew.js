// Crew tools (phase 2 step 3): tools granted by role (shared/world.js ROLE_GRANTS) rather
// than by a fixture. They act on the agents registry injected through the gate's
// toolContext ({ agents }). No leash domain: creating a Junior Ranger is an org change
// inside the park, not an outside effect; the registry enforces the one-hop depth and the
// gate only lists the tool for chief_ranger and ranger roles.

import { SPECIALTY_NAMES } from '../../shared/world.js';

export const spawnJunior = {
  name: 'crew.spawn_junior',
  description:
    'Create a Junior Ranger reporting to you, in your zone, for one bounded subtask. Give it a short name, ' +
    'a persona (what it does and must not do) and the venture. Junior Rangers cannot create Juniors of their own. ' +
    'Returns the new agent id; hand it work with the delegate tool when you have it.',
  inputSchema: {
    type: 'object',
    required: ['name', 'persona'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 60, description: 'Display name, e.g. "Listing drafter"' },
      persona: { type: 'string', minLength: 1, maxLength: 2000, description: 'What this Junior does and its limits' },
      specialty: { type: 'string', enum: SPECIALTY_NAMES, description: 'Optional specialty' },
      venture: { type: 'string', description: 'Optional venture name; defaults to yours' },
    },
  },
  confirm: false,
  async run(input, ctx) {
    if (!ctx.agents) return { ok: false, error: 'no agents registry is available in this run' };
    const me = ctx.agents.get(ctx.agentId);
    if (!me) return { ok: false, error: `unknown caller "${ctx.agentId}"` };
    try {
      const junior = await ctx.agents.create(
        { name: input.name, role: 'junior_ranger', zoneId: me.roomId, parentAgentId: me.id, persona: input.persona, specialty: input.specialty, venture: input.venture || me.venture },
        { by: me.id },
      );
      return { ok: true, output: JSON.stringify({ agentId: junior.id, name: junior.name, zone: junior.roomId, parentAgentId: junior.parentAgentId }) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
};

export const CREW_TOOLS = Object.freeze({ 'crew.spawn_junior': spawnJunior });
