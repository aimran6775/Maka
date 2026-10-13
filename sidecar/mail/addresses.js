// Mail addresses as routing rules (phase 2 step 10). Resend receives for the whole domain,
// so an address exists the moment Maka routes it; no provider call is needed.
//
//   createAddresses({ store, bus, domain, clock }) -> { init(), list(), get(address),
//     ensureStations(layout), createAlias({ local, agentId, venture, station }, { by }),
//     remove(address, { by }), resolve(address), forAgent(agentId), forStation(zoneId) }
//
// Rule: { address, local, kind: 'station' | 'alias' | 'system', station (zone id),
//         agentId?, venture?, createdAt, createdBy }
// Station addresses (docs/KICKOFF_BRIEF.md, Email): peak@, rangers@, visitors@, sales@,
// marketing@, finance@, support@, research@, listings@ are owned by the zone of that kind;
// gate@ belongs to the Entrance Gate (station id 'entrance-gate', mail for the
// Superintendent); unsubscribe@ is the system address whose senders are suppressed.
// Ranger aliases are <role>-<venture>@ and route into the owning station with the venture
// tag. Mail to an unknown address lands in visitors@ for triage.

import { makeEvent } from '../../shared/events.js';
import { normalizeAddress } from './store.js';

export const STATION_LOCALS = Object.freeze({
  mountain_peak: 'peak',
  ranger_station: 'rangers',
  visitor_center: 'visitors',
  sales: 'sales',
  marketing: 'marketing',
  finance: 'finance',
  operations_support: 'support',
  research: 'research',
  product_listings: 'listings',
  // D187: the four departments D178 added. Without these, `ensureStations` skipped them,
  // so a camp with a head and standing duties had no address and nothing could reach it —
  // the mailbox said so plainly, which is how it was noticed.
  people: 'people',
  business: 'business',
  legal: 'legal',
  infrastructure: 'infrastructure',
});
export const GATE_STATION = 'entrance-gate';
export const SYSTEM_STATION = 'system';

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function createAddresses({ store, bus, domain, clock = { now: () => Date.now() } } = {}) {
  if (!store || !bus || !domain) throw new TypeError('createAddresses needs store, bus and domain');
  let rules = [];
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(() => store.saveMailAddresses({ version: 1, rules })).catch((err) => console.error('mail addresses save failed:', err));
    return saving;
  };
  const emit = (payload) => bus.emit(makeEvent('mail.address', payload, { ts: clock.now() }));
  const find = (address) => rules.find((r) => r.address === normalizeAddress(address)) || null;

  async function addRule(rule, by) {
    if (find(rule.address)) throw fail('CONFLICT', `${rule.address} already exists`, 409);
    const record = { ...rule, createdAt: clock.now(), createdBy: by };
    rules.push(record);
    await save();
    const payload = { address: record.address, change: 'created', kind: record.kind, station: record.station, by };
    if (record.agentId) payload.agentId = record.agentId;
    if (record.venture) payload.venture = record.venture;
    emit(payload);
    return record;
  }

  return {
    domain,
    async init() {
      const loaded = await store.loadMailAddresses(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.rules)) rules = loaded.rules;
      return this;
    },
    list: () => rules.map((r) => ({ ...r })),
    get: find,
    // Station addresses for every zone kind present in the layout, plus gate@ and unsubscribe@.
    async ensureStations(layout, { by = 'park-setup' } = {}) {
      const created = [];
      for (const room of layout.rooms) {
        const local = STATION_LOCALS[room.kind];
        if (!local) continue;
        const address = `${local}@${domain}`;
        if (find(address)) continue;
        created.push(await addRule({ address, local, kind: 'station', station: room.id }, by));
      }
      for (const [local, station] of [['gate', GATE_STATION], ['unsubscribe', SYSTEM_STATION]]) {
        const address = `${local}@${domain}`;
        if (!find(address)) created.push(await addRule({ address, local, kind: local === 'gate' ? 'station' : 'system', station }, by));
      }
      return created;
    },
    // A Ranger alias: <local>@domain routed into a station with the venture tag.
    async createAlias({ local, agentId, venture, station } = {}, { by = 'superintendent' } = {}) {
      const l = String(local || '').trim().toLowerCase();
      if (!LOCAL_RE.test(l)) throw fail('BAD_REQUEST', 'local part must be letters, digits, dots, dashes or underscores');
      if (!station) throw fail('BAD_REQUEST', 'an alias needs the station (zone id) it routes into');
      const rule = { address: `${l}@${domain}`, local: l, kind: 'alias', station };
      if (agentId) rule.agentId = agentId;
      if (venture) rule.venture = venture;
      return addRule(rule, by);
    },
    async remove(address, { by = 'superintendent' } = {}) {
      const r = find(address);
      if (!r) throw fail('NOT_FOUND', `no address ${address}`, 404);
      if (r.kind !== 'alias') throw fail('FORBIDDEN', `${r.address} is a ${r.kind} address and stays`, 403);
      rules = rules.filter((x) => x !== r);
      await save();
      emit({ address: r.address, change: 'removed', kind: r.kind, station: r.station, by });
      return r;
    },
    // Where mail to `address` goes. Unknown addresses on the domain (and anything else)
    // route to visitors@ for triage; `fallback: true` says so.
    resolve(address) {
      const r = find(address);
      if (r) return { ...r, fallback: false };
      const visitors = rules.find((x) => x.local === 'visitors');
      return visitors ? { ...visitors, fallback: true } : { address: `visitors@${domain}`, local: 'visitors', kind: 'station', station: 'visitor-center', fallback: true };
    },
    forAgent: (agentId, roomId = null) => rules.filter((r) => r.agentId === agentId || (roomId && r.kind === 'station' && r.station === roomId)).map((r) => ({ ...r })),
    forStation: (zoneId) => rules.filter((r) => r.station === zoneId).map((r) => ({ ...r })),
    flushed: () => saving,
  };
}
