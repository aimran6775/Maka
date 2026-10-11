// The mail system's composition root (phase 2 step 10): store + addresses + Resend sync,
// the polling job, and the status the park shows.
//
//   createMailSystem({ bus, store, scheduler, getLayout, env, keystorePath, fetch, clock,
//                      workspaceRoot, domain, pollMs, resendBaseUrl, log })
//     -> { init(), mailStore, addresses, sync, status(), resendReady(), poll() }
//
// init() creates the station addresses for the layout's zones, registers the polling job
// (every `pollMs`, default 60 s; it only runs when RESEND_API_KEY is wired, otherwise it
// records "not wired" and does nothing) and seeds nothing else: the first poll pulls what
// Resend holds after the persisted cursor.

import path from 'node:path';
import { makeEvent } from '../../shared/events.js';
import { resolveKey } from '../providers/keys.js';
import { createMailStore } from './store.js';
import { createAddresses } from './addresses.js';
import { createResendMail, createMailSync } from './resend.js';
import { createMailPolicy } from './send.js';
import { MAIL_TOOLS } from './tools.js';
import { createClassifier } from './classify.js';
import { DEFAULT_MAIL_DOMAIN, RESEND_BASE_URL } from './dns.js';

export const MAIL_SYNC_JOB_ID = 'mail-sync';
// Phase 4 step 6: kinds that never leave the machine (stored straight into a station's
// mailbox; no Resend, no footer, no ceiling, no classification).
export const INTERNAL_KINDS = Object.freeze(['briefing']);
export const DEFAULT_MAIL_POLL_MS = 60_000;

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createMailSystem({ bus, store, scheduler = null, getLayout, env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, workspaceRoot, domain = DEFAULT_MAIL_DOMAIN, pollMs = DEFAULT_MAIL_POLL_MS, resendBaseUrl = RESEND_BASE_URL, ceilings = {}, router = null, makeProvider = undefined, ledger = null, classify = true, log = console } = {}) {
  if (!bus || !store || typeof getLayout !== 'function' || !workspaceRoot) throw new TypeError('createMailSystem needs bus, store, getLayout and workspaceRoot');
  const mailStore = createMailStore({ root: path.join(workspaceRoot, '_mail'), clock });
  const addresses = createAddresses({ store, bus, domain, clock });
  let resend = null;
  let webhookSecret = null;
  const jobState = { lastReason: null };

  async function getResend() {
    if (resend) return resend;
    const key = await resolveKey('resend', { env, keystorePath });
    if (!key) {
      const err = new Error('RESEND_API_KEY is not wired (env or keystore)');
      err.code = 'NO_KEY';
      err.status = 400;
      throw err;
    }
    resend = createResendMail({ apiKey: key, fetch: fetchImpl, baseUrl: resendBaseUrl });
    return resend;
  }

  const sync = createMailSync({ store: mailStore, addresses, getResend, bus, clock, domain, log });
  const policy = createMailPolicy({ mailStore, addresses, sync, getLayout, clock, domain, ceilings });
  // The tools act on this system through toolContext.mail; mail.send asks the judge for
  // sends to new external recipients even at Draft (policy.judgeAtDraft).
  // The domain of a send follows the derived kind with the draft loaded (safety M5).
  const tools = { ...MAIL_TOOLS, 'mail.send': { ...MAIL_TOOLS['mail.send'], domain: (input) => policy.domainForSend(input), judgeAtDraft: (input) => policy.judgeAtDraft(input) } };
  const classifier = router && classify ? createClassifier({ router, makeProvider, ledger, bus, env, keystorePath, fetch: fetchImpl, clock, log }) : null;
  const classifyState = { queued: 0, done: 0, lastError: null };
  let classifying = Promise.resolve();
  if (classifier) {
    bus.listen((event) => {
      if (event.type !== 'mail.message' || event.payload.direction !== 'in' || INTERNAL_KINDS.includes(event.payload.kind) || event.payload.kind === 'unsubscribe') return; // internal mail (a briefing from the Peak) is not classified
      classifyState.queued += 1;
      classifying = classifying
        .then(async () => {
          const m = await mailStore.get(event.payload.messageId);
          if (!m) return;
          const r = await classifier.classify(m);
          if (r.classification !== 'unclassified') await mailStore.setClassification(m.id, r.classification);
          classifyState.done += 1;
        })
        .catch((err) => {
          classifyState.lastError = err.message;
          log.error('mail classification failed:', err.message);
        });
    });
  }
  const api = {
    domain,
    mailStore,
    addresses,
    sync,
    policy,
    tools,
    classifier,
    classified: () => classifying,
    send: (msg, opts) => policy.send(msg, opts),
    // Internal mail (phase 4 step 6): from a station address to station addresses only,
    // stored into each recipient's mailbox as received mail, never sent through Resend.
    // The reflection's briefings go this way (kind 'briefing'). Refused for any recipient
    // that is not a station of this park (INTERNAL_ONLY).
    async deliverInternal({ from, to, subject, text, kind = 'briefing', venture = null, ref = null } = {}) {
      if (!INTERNAL_KINDS.includes(kind)) throw fail('BAD_REQUEST', `internal mail is one of ${INTERNAL_KINDS.join(', ')}`);
      if (!from || !subject || typeof text !== 'string') throw fail('BAD_REQUEST', 'internal mail needs from, subject and text');
      const sender = addresses.get(from);
      if (!sender || sender.kind !== 'station') throw fail('INTERNAL_ONLY', `${from} is not a station address of this park`, 403);
      const recipients = [...new Set((Array.isArray(to) ? to : [to]).map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))];
      if (!recipients.length) throw fail('BAD_REQUEST', 'internal mail needs a recipient');
      const rules = recipients.map((a) => ({ address: a, rule: addresses.get(a) }));
      const foreign = rules.filter((r) => !r.rule || r.rule.kind !== 'station' || r.rule.station === 'system');
      if (foreign.length) throw fail('INTERNAL_ONLY', `internal mail goes to station addresses only; not ${foreign.map((r) => r.address).join(', ')}`, 403);
      const out = [];
      for (const { address, rule } of rules) {
        const record = await mailStore.add({ direction: 'in', from, to: [address], subject, text, station: rule.station, venture, kind, status: 'received', labels: ['internal'], messageId: `<${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@${domain}>`, headers: ref ? { 'X-Maka-Ref': String(ref) } : {} });
        const payload = { messageId: record.id, threadId: record.threadId, direction: 'in', from, to: [address], subject, station: rule.station, kind };
        if (venture) payload.venture = venture;
        bus.emit(makeEvent('mail.message', payload, { ts: clock.now() }));
        out.push(record);
      }
      return out;
    },
    async init() {
      await mailStore.init();
      await addresses.init();
      await addresses.ensureStations(getLayout());
      webhookSecret = await resolveKey('resendWebhook', { env, keystorePath });
      if (scheduler) {
        scheduler.add(MAIL_SYNC_JOB_ID, { everyMs: pollMs }, async () => {
          const key = await resolveKey('resend', { env, keystorePath });
          if (!key) {
            jobState.lastReason = 'RESEND_API_KEY not wired; nothing polled';
            return;
          }
          const r = await sync.poll();
          await sync.refreshOutbound().catch((err) => log.error('mail status refresh failed:', err.message));
          jobState.lastReason = `polled: ${r.received} new`;
        });
      }
      return api;
    },
    resendReady: async () => Boolean(await resolveKey('resend', { env, keystorePath })),
    webhookSecret: () => webhookSecret,
    poll: () => sync.poll(),
    handleWebhook: ({ headers, rawBody }) => sync.handleWebhook({ headers, rawBody, secret: webhookSecret }),
    async status() {
      const counts = mailStore.counts();
      return {
        domain,
        keys: { resend: Boolean(await resolveKey('resend', { env, keystorePath })), webhook: Boolean(webhookSecret) },
        addresses: addresses.list().length,
        counts,
        sync: { ...sync.state(), pollMs, job: scheduler ? scheduler.state()[MAIL_SYNC_JOB_ID] || null : null, lastReason: jobState.lastReason },
        policy: policy.status(),
        classify: classifier ? { ...classifyState, wired: true } : { wired: false },
      };
    },
  };
  return api;
}
