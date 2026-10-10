// Mail routing and policy (phase 2 step 11): who may send what, from where, how often,
// and under which leash.
//
//   createMailPolicy({ mailStore, addresses, sync, getLayout, clock, domain, ceilings })
//     -> { allowedFrom(agentId), kindOf(msg), domainFor(kind), isNewExternal(address),
//          sentLastHour({ agentId, station }), checkCeiling(...), validate(msg, { by }),
//          send(msg, { by }), judgeAtDraft(input, ctx), status() }
//
// Rules (docs/KICKOFF_BRIEF.md, Email; docs/PHASE2_BRIEF.md step 11):
//   - a Ranger sends from its own aliases or its station's address; the Chief from peak@
//     and any station; the Superintendent from any station address;
//   - kind: 'reply' (continues a thread) and 'notification' (one-to-one, transactional) are
//     outbound_messages; 'campaign' (bulk, marketing) is publishing;
//   - hourly ceilings: per Ranger, per station, and campaign recipients per hour, counted
//     from the store's sent copies in the last hour (config.json mailCeilings);
//   - a recipient never seen in the store (no mail from or to it) and off the domain is a
//     "new external recipient"; while the applicable domain is at Draft for review, the
//     judge reviews such a send before it reaches the Gate (judgeAtDraft, read by
//     sidecar/judge.js needsActionReview).
// The policy validates and then hands the message to sidecar/mail/resend.js send().

import { normalizeAddress, addressList } from './store.js';

export const DEFAULT_CEILINGS = Object.freeze({ perAgentPerHour: 30, perStationPerHour: 120, campaignRecipientsPerHour: 500 });
export const KINDS = Object.freeze(['reply', 'notification', 'campaign']);
export const KIND_DOMAINS = Object.freeze({ reply: 'outbound_messages', notification: 'outbound_messages', campaign: 'publishing' });
const HOUR_MS = 3600 * 1000;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createMailPolicy({ mailStore, addresses, sync, getLayout, clock = { now: () => Date.now() }, domain, ceilings = {} } = {}) {
  if (!mailStore || !addresses || !sync || typeof getLayout !== 'function' || !domain) throw new TypeError('createMailPolicy needs mailStore, addresses, sync, getLayout and domain');
  const caps = { ...DEFAULT_CEILINGS, ...ceilings };

  function agentOf(id) {
    return getLayout().agents.find((a) => a.id === id) || null;
  }

  const api = {
    ceilings: caps,
    // Addresses `by` may send from. The Superintendent: every station address.
    allowedFrom(by) {
      if (by === 'superintendent') return addresses.list().filter((r) => r.kind === 'station').map((r) => r.address);
      const agent = agentOf(by);
      if (!agent) return [];
      const own = addresses.forAgent(agent.id, agent.roomId).map((r) => r.address);
      if ((agent.role || 'ranger') === 'chief_ranger') {
        for (const r of addresses.list()) if (r.kind === 'station' && r.station !== 'system') own.push(r.address);
      }
      return [...new Set(own)];
    },
    kindOf(msg) {
      if (msg.kind && KINDS.includes(msg.kind)) return msg.kind;
      if (msg.inReplyTo || msg.threadId) return 'reply';
      return addressList(msg.to).length > 1 ? 'campaign' : 'notification';
    },
    domainFor: (kind) => KIND_DOMAINS[kind] || 'outbound_messages',
    isNewExternal(address) {
      const a = normalizeAddress(address);
      if (!a || a.endsWith(`@${domain}`)) return false;
      return !mailStore.list({ limit: 100000 }).some((m) => normalizeAddress(m.from) === a || m.to.some((t) => normalizeAddress(t) === a));
    },
    sentLastHour({ agentId, station } = {}) {
      const since = clock.now() - HOUR_MS;
      const out = mailStore.list({ direction: 'out', limit: 100000 }).filter((m) => m.date >= since);
      return {
        agent: agentId ? out.filter((m) => m.agentId === agentId).length : 0,
        station: station ? out.filter((m) => m.station === station).length : 0,
        campaignRecipients: out.filter((m) => m.kind === 'campaign').reduce((n, m) => n + m.to.length, 0),
      };
    },
    checkCeiling({ agentId, station, kind, recipients = 1 } = {}) {
      const n = api.sentLastHour({ agentId, station });
      if (agentId && agentId !== 'superintendent' && n.agent + 1 > caps.perAgentPerHour) return { ok: false, reason: `${agentId} sent ${n.agent} message(s) in the last hour; the ceiling is ${caps.perAgentPerHour}` };
      if (station && n.station + 1 > caps.perStationPerHour) return { ok: false, reason: `${station} sent ${n.station} message(s) in the last hour; the ceiling is ${caps.perStationPerHour}` };
      if (kind === 'campaign' && n.campaignRecipients + recipients > caps.campaignRecipientsPerHour) return { ok: false, reason: `campaigns reached ${n.campaignRecipients} recipient(s) in the last hour; the ceiling is ${caps.campaignRecipientsPerHour}` };
      return { ok: true, reason: null };
    },
    // Resolves kind, domain, station and the policy verdict without sending (rejects).
    async validate(msg, { by } = {}) {
      if (!by) throw fail('BAD_REQUEST', 'a sender (by) is required');
      const from = normalizeAddress(msg.from);
      const to = addressList(msg.to);
      if (!from || !to.length || !msg.subject) throw fail('BAD_REQUEST', 'from, to and subject are required');
      const allowed = api.allowedFrom(by);
      if (!allowed.includes(from)) throw fail('FORBIDDEN', `${by} may not send from ${from}; allowed: ${allowed.join(', ') || 'none'}`, 403);
      const rule = addresses.get(from);
      const kind = api.kindOf(msg);
      const station = rule ? rule.station : null;
      const agent = by === 'superintendent' ? null : agentOf(by);
      const ceiling = api.checkCeiling({ agentId: by, station, kind, recipients: to.length });
      if (!ceiling.ok) throw fail('CEILING', ceiling.reason, 429);
      const live = to.filter((a) => !mailStore.isSuppressed(a));
      if (!live.length) throw fail('SUPPRESSED', `every recipient is suppressed: ${to.join(', ')}`, 422);
      return { from, to, kind, domain: api.domainFor(kind), station, venture: msg.venture || (rule && rule.venture) || (agent && agent.venture) || null, agentId: by === 'superintendent' ? null : by, newExternal: to.filter((a) => api.isNewExternal(a)), suppressed: to.filter((a) => mailStore.isSuppressed(a)) };
    },
    async send(msg, { by } = {}) {
      const v = await api.validate(msg, { by });
      return sync.send({ ...msg, from: v.from, to: v.to, kind: v.kind, station: v.station, venture: v.venture, agentId: v.agentId });
    },
    // The judge's extra trigger (sidecar/judge.js): a send to a new external recipient
    // deserves a review even at Draft for review.
    judgeAtDraft(input, ctx = {}) {
      try {
        return addressList(input && input.to).some((a) => api.isNewExternal(a));
      } catch {
        return false;
      }
    },
    status: () => ({ ceilings: caps, lastHour: api.sentLastHour({}) }),
  };
  return api;
}
