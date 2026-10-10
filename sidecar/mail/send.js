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
//   - kind is derived, never taken from the sender's word (safety review M5): 'reply' when
//     the message answers a message the park holds (In-Reply-To matching a stored
//     Message-ID, or a known thread) and goes to one recipient; everything else, more than
//     one recipient included, is 'campaign' (publishing, unsubscribe footer, the campaign
//     recipient ceiling). A declared 'campaign' is honoured because it only tightens. The
//     'notification' kind stays in the data model for what was stored before and is not
//     derived. `to` is bounded to MAX_RECIPIENTS per message;
//   - drafts (status 'draft') are not mail history (M6): they make no address known and
//     count toward no ceiling;
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
export const MAX_RECIPIENTS = 50;
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
    // The one place a message's kind is decided (M5). `msg.kind` can only tighten.
    kindOf(msg) {
      const to = addressList(msg && msg.to);
      if (to.length > 1) return 'campaign';
      if (msg && msg.kind === 'campaign') return 'campaign';
      return api.isReplyToKnownThread(msg) ? 'reply' : 'campaign';
    },
    // Does the message answer mail the park holds? A Message-ID we stored (not a draft's),
    // or a thread with real mail in it.
    isReplyToKnownThread(msg) {
      if (!msg) return false;
      const ref = typeof msg.inReplyTo === 'string' ? msg.inReplyTo.trim() : '';
      if (ref) {
        const parent = mailStore.byMessageId(ref);
        if (parent && parent.status !== 'draft') return true;
      }
      return Boolean(msg.threadId) && typeof mailStore.hasThread === 'function' && mailStore.hasThread(msg.threadId);
    },
    domainFor: (kind) => KIND_DOMAINS[kind] || 'outbound_messages',
    // The leash domain of a mail.send input, with the draft loaded when one is named
    // (M5: the tool's domain function and validate() agree). An unknown draft is judged
    // as a campaign: the stricter domain, and run() refuses it anyway.
    domainForSend(input) {
      const msg = api.messageOfSend(input);
      if (!msg) return KIND_DOMAINS.campaign;
      return api.domainFor(api.kindOf(msg));
    },
    // The recipients, reply reference and thread a mail.send input means, from the draft
    // (sync, from the store's index) when draftId is given; null when the draft is unknown.
    messageOfSend(input) {
      if (!input) return null;
      if (!input.draftId) return { to: input.to, inReplyTo: input.inReplyTo, kind: input.kind };
      const d = typeof mailStore.summary === 'function' ? mailStore.summary(input.draftId) : null;
      if (!d || d.status !== 'draft') return null;
      return { to: input.to || d.to, inReplyTo: input.inReplyTo || d.inReplyTo || null, threadId: d.threadId, kind: input.kind || d.kind };
    },
    isNewExternal(address) {
      const a = normalizeAddress(address);
      if (!a || a.endsWith(`@${domain}`)) return false;
      return !mailStore.list({ limit: 100000 }).some((m) => m.status !== 'draft' && (normalizeAddress(m.from) === a || m.to.some((t) => normalizeAddress(t) === a)));
    },
    sentLastHour({ agentId, station } = {}) {
      const since = clock.now() - HOUR_MS;
      const out = mailStore.list({ direction: 'out', limit: 100000 }).filter((m) => m.date >= since && m.status !== 'draft');
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
      if (to.length > MAX_RECIPIENTS) throw fail('BAD_REQUEST', `a message goes to at most ${MAX_RECIPIENTS} recipients; this one names ${to.length}`);
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
        const msg = api.messageOfSend(input);
        return addressList(msg && msg.to).some((a) => api.isNewExternal(a));
      } catch {
        return false;
      }
    },
    status: () => ({ ceilings: caps, lastHour: api.sentLastHour({}) }),
  };
  return api;
}
