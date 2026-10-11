// Agent records and the hierarchy (phase 2 step 3).
//
//   createAgents({ layoutState, leashState, bus, clock })
//     -> { list(), get(id), create(spec, { by }), update(id, patch, { by }), remove(id, { by }),
//          ensureChief(), ensurePeak() }
//
// An agent record IS the layout's agent entry (shared/world.js LAYOUT_SCHEMA agents[]):
// id, name, role, roomId (its zone), parentAgentId, venture, specialty, persona, policy
// (per-agent worker model), budgetUsd, createdBy, createdAt. Keeping it in the layout means
// one atomic file (layout.json), one source of truth for the park, the grants and the org
// chart (docs/DECISIONS.md D45). Per-agent leash overrides stay in leash.json (D40) and
// are read / written here through leashState.
//
// Rules enforced here (the capability gate enforces them for tools too):
//   - the Chief Ranger is a singleton and lives in the Mountain Peak zone, which is created
//     as a room of kind 'mountain_peak' on demand;
//   - a parent must have a role PARENT_ROLES allows; a Junior Ranger's parent is a Ranger,
//     so the tree is one hop deep below Rangers;
//   - an agent with reports cannot be removed; an agent with an active run cannot be removed.
// Every change emits crew.agent so the park updates without a snapshot.

import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';
import { AGENT_ROLES, PARENT_ROLES, SPECIALTIES, SPECIALTY_NAMES, ZONE_KINDS, ZONE_LABELS, LAYOUT_SCHEMA, agentOf, roomOf, childrenOf, freeTile, allGrantsFor, freeZoneRect } from '../shared/world.js';
import { validate } from '../shared/schema.js';
import { resolveAllLeash, withAgentLeash, validateLeash, DOMAINS } from '../shared/leash.js';

export const PEAK_ROOM_ID = 'mountain-peak';
export const CHIEF_ID = 'chief-ranger';

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ranger';
}

export function createAgents({ layoutState, leashState = null, bus, clock = { now: () => Date.now() }, activeRunFor = () => null } = {}) {
  if (!layoutState || !bus) throw new TypeError('createAgents needs layoutState and bus');
  const emit = (payload) => bus.emit(makeEvent('crew.agent', payload, { ts: clock.now() }));
  const layout = () => layoutState.get();

  function view(a) {
    const l = layout();
    const room = roomOf(l, a.roomId);
    const out = {
      ...a,
      role: a.role || 'ranger',
      zone: room ? { id: room.id, name: room.name, kind: room.kind || null } : null,
      reports: childrenOf(l, a.id).map((c) => c.id),
      grants: allGrantsFor(l, a.id),
      specialtyLabel: a.specialty ? SPECIALTIES[a.specialty].label : null,
    };
    if (leashState) {
      out.leash = resolveAllLeash(leashState.get(), { agentId: a.id, roomId: a.roomId });
      out.leashOverrides = (leashState.get().agents && leashState.get().agents[a.id] && leashState.get().agents[a.id].domains) || {};
    }
    return out;
  }

  function checkParent(role, parentAgentId, l, selfId) {
    const allowed = PARENT_ROLES[role] || [];
    if (!parentAgentId) {
      if (role === 'junior_ranger') throw fail('BAD_REQUEST', 'a Junior Ranger needs a parentAgentId (its Ranger)');
      return;
    }
    if (parentAgentId === selfId) throw fail('BAD_REQUEST', 'an agent cannot report to itself');
    if (parentAgentId === 'superintendent') {
      if (!allowed.includes('superintendent')) throw fail('BAD_REQUEST', `a ${role} cannot report to the Superintendent directly`);
      return;
    }
    const parent = agentOf(l, parentAgentId);
    if (!parent) throw fail('BAD_REQUEST', `unknown parent agent "${parentAgentId}"`);
    const parentRole = parent.role || 'ranger';
    if (!allowed.includes(parentRole)) {
      if (role === 'junior_ranger' && parentRole === 'junior_ranger') throw fail('DEPTH', 'Junior Rangers cannot have Junior Rangers: the tree is one hop deep below a Ranger', 400);
      throw fail('BAD_REQUEST', `a ${role} cannot report to a ${parentRole}`);
    }
  }

  async function ensurePeak() {
    const l = layout();
    let peak = l.rooms.find((r) => r.kind === 'mountain_peak');
    if (peak) return peak;
    // Place the Peak room clear of every existing room: to the north-west of the layout.
    const minX = Math.min(...l.rooms.map((r) => r.x), 1);
    const minY = Math.min(...l.rooms.map((r) => r.y), 1);
    peak = { id: PEAK_ROOM_ID, name: 'Mountain Peak', kind: 'mountain_peak', x: Math.max(0, minX - 8), y: Math.max(0, minY - 8), w: 4, h: 4 };
    if (l.rooms.some((r) => r.id === PEAK_ROOM_ID)) throw fail('CONFLICT', `room "${PEAK_ROOM_ID}" exists but is not the Mountain Peak`, 409);
    await layoutState.replace({ ...l, rooms: [...l.rooms, peak] });
    return peak;
  }

  // The first room of a kind, created on the layout grid when none exists (department
  // camps for the Chief's staffing, the Visitor Center, trailheads).
  async function ensureZone(kind, { name, id, venture, size } = {}) {
    if (!ZONE_KINDS.includes(kind)) throw fail('BAD_REQUEST', `unknown zone kind "${kind}"`);
    if (kind === 'mountain_peak') return ensurePeak();
    const l = layout();
    const existing = l.rooms.find((r) => r.kind === kind && (!id || r.id === id) && (!venture || r.venture === venture));
    if (existing) return existing;
    const rect = freeZoneRect(l, size || (kind === 'trailhead' ? { w: 4, h: 4 } : {}));
    if (!rect) throw fail('CONFLICT', 'no room left on the layout grid', 409);
    const roomId = id || (venture ? `${kind.replace(/_/g, '-')}-${venture}` : kind.replace(/_/g, '-'));
    if (l.rooms.some((r) => r.id === roomId)) throw fail('CONFLICT', `room "${roomId}" exists with another kind`, 409);
    const room = { id: roomId, name: name || ZONE_LABELS[kind] || kind, kind, ...rect };
    if (venture) room.venture = venture;
    await layoutState.replace({ ...l, rooms: [...l.rooms, room] });
    return room;
  }

  return {
    PEAK_ROOM_ID,
    CHIEF_ID,
    ensureZone,
    list: () => layout().agents.map(view),
    get: (id) => {
      const a = agentOf(layout(), id);
      return a ? view(a) : null;
    },
    ensurePeak,
    // The Chief Ranger: a singleton at the Peak, created on demand.
    async ensureChief({ name = 'Chief Ranger', persona = '' } = {}) {
      const existing = layout().agents.find((a) => a.role === 'chief_ranger');
      if (existing) return view(existing);
      const peak = await ensurePeak();
      return this.create({ id: CHIEF_ID, name, role: 'chief_ranger', zoneId: peak.id, parentAgentId: 'superintendent', persona }, { by: 'superintendent' });
    },
    async create({ id, name, role = 'ranger', zoneId, parentAgentId, venture, specialty, persona, policy, budgetUsd, x, y } = {}, { by = 'superintendent' } = {}) {
      const l = layout();
      if (!AGENT_ROLES.includes(role) || role === 'superintendent') throw fail('BAD_REQUEST', `role must be one of ${AGENT_ROLES.filter((r) => r !== 'superintendent').join(', ')}`);
      if (typeof name !== 'string' || !name.trim()) throw fail('BAD_REQUEST', 'name is required');
      if (specialty !== undefined && !SPECIALTY_NAMES.includes(specialty)) throw fail('BAD_REQUEST', `specialty must be one of ${SPECIALTY_NAMES.join(', ')}`);
      if (role === 'chief_ranger') {
        if (l.agents.some((a) => a.role === 'chief_ranger')) throw fail('CONFLICT', 'the Chief Ranger already exists; there is one Chief', 409);
        if (!zoneId) zoneId = (await ensurePeak()).id;
      }
      const room = roomOf(layout(), zoneId);
      if (!room) throw fail('BAD_REQUEST', `unknown zone "${zoneId}"`);
      if (role === 'chief_ranger' && room.kind !== 'mountain_peak') throw fail('BAD_REQUEST', 'the Chief Ranger sits at the Mountain Peak');
      if (role !== 'chief_ranger' && room.kind === 'mountain_peak') throw fail('BAD_REQUEST', 'only the Chief Ranger sits at the Mountain Peak');
      checkParent(role, parentAgentId, layout(), id);
      const agentId = id || `${slug(name)}-${randomUUID().slice(0, 6)}`;
      if (agentOf(layout(), agentId)) throw fail('CONFLICT', `agent "${agentId}" already exists`, 409);
      let tile = Number.isInteger(x) && Number.isInteger(y) ? { x, y } : freeTile(layout(), room);
      if (!tile) throw fail('CONFLICT', `zone "${room.name}" has no free tile`, 409);
      const record = { id: agentId, name: name.trim(), roomId: room.id, x: tile.x, y: tile.y, role, createdBy: by, createdAt: clock.now() };
      if (parentAgentId) record.parentAgentId = parentAgentId;
      if (venture) record.venture = String(venture);
      if (specialty) {
        record.specialty = specialty;
        if (!persona) persona = SPECIALTIES[specialty].persona;
      }
      if (persona) record.persona = String(persona);
      if (policy) record.policy = policy;
      if (typeof budgetUsd === 'number') record.budgetUsd = budgetUsd;
      const next = { ...layout(), agents: [...layout().agents, record] };
      const r = validate(LAYOUT_SCHEMA, next);
      if (!r.ok) throw fail('BAD_REQUEST', `agent invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      await layoutState.replace(next);
      emit({ agentId, change: 'created', agent: record, by });
      return view(record);
    },
    async update(id, patch = {}, { by = 'superintendent' } = {}) {
      const l = layout();
      const current = agentOf(l, id);
      if (!current) throw fail('NOT_FOUND', `no agent "${id}"`, 404);
      const allowed = ['name', 'zoneId', 'parentAgentId', 'venture', 'specialty', 'persona', 'policy', 'budgetUsd', 'x', 'y', 'leash', 'paused', 'skills'];
      const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
      if (unknown.length) throw fail('BAD_REQUEST', `cannot change ${unknown.join(', ')}`);
      if ('role' in patch) throw fail('BAD_REQUEST', 'role cannot change');
      const record = { ...current };
      if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) throw fail('BAD_REQUEST', 'name must be a non-empty string');
        record.name = patch.name.trim();
      }
      if (patch.zoneId !== undefined && patch.zoneId !== current.roomId) {
        const room = roomOf(l, patch.zoneId);
        if (!room) throw fail('BAD_REQUEST', `unknown zone "${patch.zoneId}"`);
        if ((current.role === 'chief_ranger') !== (room.kind === 'mountain_peak')) throw fail('BAD_REQUEST', 'only the Chief Ranger sits at the Mountain Peak');
        const tile = freeTile(l, room);
        if (!tile) throw fail('CONFLICT', `zone "${room.name}" has no free tile`, 409);
        record.roomId = room.id;
        record.x = tile.x;
        record.y = tile.y;
      }
      if (patch.x !== undefined || patch.y !== undefined) {
        const tx = patch.x !== undefined ? patch.x : record.x;
        const ty = patch.y !== undefined ? patch.y : record.y;
        const room = roomOf(l, record.roomId);
        if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < room.x || ty < room.y || tx >= room.x + room.w || ty >= room.y + room.h) throw fail('BAD_REQUEST', 'tile is outside the zone');
        if (l.objects.some((o) => o.x === tx && o.y === ty) || l.agents.some((a) => a.id !== id && a.x === tx && a.y === ty)) throw fail('CONFLICT', 'tile is occupied', 409);
        record.x = tx;
        record.y = ty;
      }
      if (patch.parentAgentId !== undefined) {
        if (patch.parentAgentId === null || patch.parentAgentId === '') {
          if (current.role === 'junior_ranger') throw fail('BAD_REQUEST', 'a Junior Ranger keeps a parent');
          delete record.parentAgentId;
        } else {
          checkParent(current.role || 'ranger', patch.parentAgentId, l, id);
          record.parentAgentId = patch.parentAgentId;
        }
      }
      if (patch.skills !== undefined) {
        // Phase 4 step 12: skill ids on the persona (the recipes module holds the texts).
        if (patch.skills === null || (Array.isArray(patch.skills) && !patch.skills.length)) delete record.skills;
        else if (Array.isArray(patch.skills) && patch.skills.every((s) => typeof s === 'string' && s.trim())) record.skills = [...new Set(patch.skills.map((s) => s.trim()))].slice(0, 12);
        else throw fail('BAD_REQUEST', 'skills must be a list of skill ids');
      }
      for (const k of ['venture', 'persona']) {
        if (patch[k] !== undefined) {
          if (patch[k] === null || patch[k] === '') delete record[k];
          else record[k] = String(patch[k]);
        }
      }
      if (patch.specialty !== undefined) {
        if (patch.specialty === null || patch.specialty === '') delete record.specialty;
        else if (!SPECIALTY_NAMES.includes(patch.specialty)) throw fail('BAD_REQUEST', `specialty must be one of ${SPECIALTY_NAMES.join(', ')}`);
        else record.specialty = patch.specialty;
      }
      if (patch.policy !== undefined) {
        if (patch.policy === null) delete record.policy;
        else record.policy = patch.policy;
      }
      if (patch.budgetUsd !== undefined) {
        if (patch.budgetUsd === null) delete record.budgetUsd;
        else record.budgetUsd = patch.budgetUsd;
      }
      if (patch.paused !== undefined) {
        if (patch.paused) record.paused = true;
        else delete record.paused;
      }
      const next = { ...l, agents: l.agents.map((a) => (a.id === id ? record : a)) };
      const r = validate(LAYOUT_SCHEMA, next);
      if (!r.ok) throw fail('BAD_REQUEST', `agent invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      await layoutState.replace(next);
      if (patch.leash !== undefined) {
        if (!leashState) throw fail('BAD_REQUEST', 'leash overrides are not available');
        const domains = patch.leash && patch.leash.domains;
        if (!domains || typeof domains !== 'object') throw fail('BAD_REQUEST', 'leash must be { domains: { <domain>: { level, dailyCapUsd?, dailyCapActions? } } }');
        let leash = leashState.get();
        for (const [d, entry] of Object.entries(domains)) {
          if (!DOMAINS.includes(d)) throw fail('BAD_REQUEST', `unknown leash domain "${d}"`);
          if (entry === null) {
            const agents = { ...(leash.agents || {}) };
            if (agents[id]) {
              const dom = { ...agents[id].domains };
              delete dom[d];
              agents[id] = { domains: dom };
            }
            leash = { ...leash, agents };
          } else leash = withAgentLeash(leash, id, d, entry);
        }
        const v = validateLeash(leash);
        if (!v.ok) throw fail('BAD_REQUEST', `leash invalid: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
        await leashState.set(leash);
      }
      emit({ agentId: id, change: 'updated', agent: record, by });
      return view(record);
    },
    // Pause: no new runs start for the agent until resumed; its active and queued runs are
    // cancelled by the caller (the run manager) so nothing keeps going behind the owner's back.
    async setPaused(id, paused, { by = 'superintendent' } = {}) {
      const l = layout();
      const current = agentOf(l, id);
      if (!current) throw fail('NOT_FOUND', `no agent "${id}"`, 404);
      const record = { ...current };
      if (paused) record.paused = true;
      else delete record.paused;
      await layoutState.replace({ ...l, agents: l.agents.map((a) => (a.id === id ? record : a)) });
      emit({ agentId: id, change: 'updated', agent: record, by });
      return view(record);
    },
    async remove(id, { by = 'superintendent' } = {}) {
      const l = layout();
      const current = agentOf(l, id);
      if (!current) throw fail('NOT_FOUND', `no agent "${id}"`, 404);
      if (childrenOf(l, id).length) throw fail('CONFLICT', `${id} has reports; remove or reassign them first`, 409);
      if (activeRunFor(id)) throw fail('CONFLICT', `${id} has a run in progress`, 409);
      if (l.agents.length === 1) throw fail('CONFLICT', 'the park keeps at least one Ranger', 409);
      await layoutState.replace({ ...l, agents: l.agents.filter((a) => a.id !== id) });
      if (leashState && leashState.get().agents && leashState.get().agents[id]) {
        const agents = { ...leashState.get().agents };
        delete agents[id];
        await leashState.set({ ...leashState.get(), agents });
      }
      emit({ agentId: id, change: 'removed', by });
      return { removed: id };
    },
  };
}

// System prompt lines for an agent's runs: role, specialty persona, venture.
export function personaLines(agent) {
  if (!agent) return [];
  const role = agent.role || 'ranger';
  const out = [];
  const roleText = {
    chief_ranger: 'You are the Chief Ranger at the Mountain Peak: you own the portfolio, plan ventures, staff them and delegate; you escalate to the Superintendent only when a leash or budget says so.',
    ranger: 'You are a Ranger: you own a venture or a function inside it and report to the Chief Ranger.',
    junior_ranger: `You are a Junior Ranger on a bounded subtask for ${agent.parentAgentId || 'your Ranger'}; you cannot delegate further.`,
  }[role];
  if (roleText) out.push(roleText);
  if (agent.specialty && SPECIALTIES[agent.specialty]) out.push(`${SPECIALTIES[agent.specialty].label}.`);
  if (agent.persona) out.push(agent.persona);
  if (agent.venture) out.push(`Your venture: ${agent.venture}.`);
  return out;
}

export { ZONE_KINDS };
