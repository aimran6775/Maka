// Mail setup orchestration (phase 2 step 9): the DNS plan and the Gate-approved apply.
//
//   createMailSetup({ bus, gateQueue, env, keystorePath, fetch, clock, domain, region,
//                     resendBaseUrl, cloudflareBaseUrl })
//     -> { status(), plan(), apply(), lastPlan(), lastApply() }
//
// plan() needs both keys (RESEND_API_KEY, CLOUDFLARE_API_TOKEN, or the keystore), looks
// up the zone by name, asks Resend for the domain's records, and returns the dry-run diff
// (emits mail.dns { planned }). apply() re-plans, then parks the write as an Entrance
// Gate item in the account_settings domain for the Superintendent (agentId
// 'superintendent'); on approve it creates the domain at Resend when missing, re-plans,
// writes the records and emits mail.dns { applied } (or { failed } with the errors); a
// reject or revise emits { failed } with the notes. Nothing is written without that
// approval, whatever the leash says: DNS for the mail domain is a one-time owner decision.

import { makeEvent } from '../../shared/events.js';
import { resolveKey } from '../providers/keys.js';
import { createResendDomains, createCloudflare, planFor, applyPlan, desiredRecords, planDns, normalizeRecord, DEFAULT_MAIL_DOMAIN, DEFAULT_RESEND_REGION, RESEND_BASE_URL, CLOUDFLARE_BASE_URL } from './dns.js';

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createMailSetup({ bus, gateQueue = null, env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, domain = DEFAULT_MAIL_DOMAIN, region = DEFAULT_RESEND_REGION, resendBaseUrl = RESEND_BASE_URL, cloudflareBaseUrl = CLOUDFLARE_BASE_URL, log = console } = {}) {
  if (!bus) throw new TypeError('createMailSetup needs bus');
  let lastPlan = null;
  let lastApply = null;
  let pendingItem = null;
  const emit = (payload) => bus.emit(makeEvent('mail.dns', { domain, ...payload }, { ts: clock.now() }));

  async function clients() {
    const [resendKey, cfToken] = await Promise.all([resolveKey('resend', { env, keystorePath }), resolveKey('cloudflare', { env, keystorePath })]);
    const missing = [!resendKey && 'RESEND_API_KEY', !cfToken && 'CLOUDFLARE_API_TOKEN'].filter(Boolean);
    if (missing.length) throw fail('NO_KEY', `mail DNS needs ${missing.join(' and ')} (env or keystore)`);
    return { resend: createResendDomains({ apiKey: resendKey, fetch: fetchImpl, baseUrl: resendBaseUrl }), cloudflare: createCloudflare({ token: cfToken, fetch: fetchImpl, baseUrl: cloudflareBaseUrl }) };
  }

  const counts = (plan) => ({ create: plan.create.length, update: plan.update.length, remove: plan.remove.length, unchanged: plan.unchanged.length });

  return {
    domain,
    async status() {
      const [resendKey, cfToken] = await Promise.all([resolveKey('resend', { env, keystorePath }), resolveKey('cloudflare', { env, keystorePath })]);
      return { domain, region, keys: { resend: Boolean(resendKey), cloudflare: Boolean(cfToken) }, lastPlan, lastApply, pendingItemId: pendingItem ? pendingItem.itemId : null };
    },
    lastPlan: () => lastPlan,
    lastApply: () => lastApply,
    async plan() {
      const { resend, cloudflare } = await clients();
      const out = await planFor({ domain, resend, cloudflare, region });
      lastPlan = { at: clock.now(), ...out, counts: counts(out.plan) };
      emit({ change: 'planned', ...counts(out.plan) });
      return lastPlan;
    },
    // Parks the apply at the Gate; resolves with the Gate item (pending) at once. The write
    // happens after the decision and reports through mail.dns events and lastApply().
    async apply() {
      if (!gateQueue) throw fail('NO_GATE', 'no Gate queue to approve the DNS change', 500);
      if (pendingItem) throw fail('CONFLICT', `a DNS apply is already waiting at the Gate (${pendingItem.itemId})`, 409);
      const planned = await this.plan();
      const total = planned.counts.create + planned.counts.update + planned.counts.remove;
      if (total === 0 && planned.resend) return { itemId: null, status: 'nothing to do', plan: planned };
      const summary = planned.resend
        ? `write ${total} DNS record change(s) for ${domain} at Cloudflare (${planned.counts.create} new, ${planned.counts.update} updated, ${planned.counts.remove} removed)`
        : `register ${domain} at Resend (${region}) and write its DNS records at Cloudflare`;
      const evidence = [
        { kind: 'plan', text: [...planned.plan.create.map((r) => `+ ${r.type} ${r.name} ${r.content}${r.priority !== undefined ? ` (prio ${r.priority})` : ''}`), ...planned.plan.update.map((r) => `~ ${r.type} ${r.name} ${r.previous} → ${r.content}`), ...planned.plan.remove.map((r) => `- ${r.type} ${r.name} ${r.content}`)].join('\n') || '(records to be planned after Resend registers the domain)' },
        ...planned.notes.map((n) => ({ kind: 'note', text: n })),
      ];
      const decision = gateQueue.submit({ agentId: 'superintendent', domain: 'account_settings', tool: 'mail.dns.apply', summary, level: 'draft', evidence, reason: 'DNS for the mail domain is applied only with your approval' });
      pendingItem = gateQueue.pending().find((it) => it.tool === 'mail.dns.apply') || null;
      const itemId = pendingItem ? pendingItem.itemId : null;
      decision
        .then(async (d) => {
          pendingItem = null;
          if (d.decision !== 'approve') {
            lastApply = { at: clock.now(), itemId, status: 'declined', decision: d.decision, notes: d.notes || '' };
            emit({ change: 'failed', itemId, errors: [], message: `${d.decision === 'revise' ? 'sent back' : d.status === 'expired' ? 'expired' : 'rejected'} at the Gate${d.notes ? `: ${d.notes}` : ''}` });
            return;
          }
          try {
            const { resend, cloudflare } = await clients();
            let resendDomain = await resend.get(domain);
            if (!resendDomain) {
              await resend.create(domain, region);
              resendDomain = await resend.get(domain);
            }
            const zone = await cloudflare.zone(domain);
            if (!zone) throw fail('NO_ZONE', `cloudflare has no zone named ${domain}`);
            const existing = (await cloudflare.records(zone.id)).map((r) => ({ ...normalizeRecord(r, domain), id: r.id }));
            const plan = planDns(desiredRecords(resendDomain, { domain }), existing);
            const result = await applyPlan(cloudflare, zone.id, plan);
            let verify = null;
            try {
              verify = await resend.verify(resendDomain.id);
            } catch (err) {
              result.errors.push(`resend verify: ${err.message}`);
            }
            lastApply = { at: clock.now(), itemId, status: result.errors.length ? 'partial' : 'applied', ...result, verify: Boolean(verify) };
            emit({ change: result.errors.length ? 'failed' : 'applied', itemId, create: result.created, update: result.updated, remove: result.removed, unchanged: plan.unchanged.length, errors: result.errors, message: result.errors.length ? `${result.errors.length} record(s) failed` : `${result.created + result.updated + result.removed} change(s) written; Resend verification requested` });
          } catch (err) {
            log.error('mail DNS apply failed:', err);
            lastApply = { at: clock.now(), itemId, status: 'failed', errors: [err.message] };
            emit({ change: 'failed', itemId, errors: [err.message], message: err.message });
          }
        })
        .catch((err) => log.error('mail DNS gate decision failed:', err));
      return { itemId, status: 'pending', plan: planned };
    },
  };
}
