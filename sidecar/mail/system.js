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
import { resolveKey } from '../providers/keys.js';
import { createMailStore } from './store.js';
import { createAddresses } from './addresses.js';
import { createResendMail, createMailSync } from './resend.js';
import { createMailPolicy } from './send.js';
import { DEFAULT_MAIL_DOMAIN, RESEND_BASE_URL } from './dns.js';

export const MAIL_SYNC_JOB_ID = 'mail-sync';
export const DEFAULT_MAIL_POLL_MS = 60_000;

export function createMailSystem({ bus, store, scheduler = null, getLayout, env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, workspaceRoot, domain = DEFAULT_MAIL_DOMAIN, pollMs = DEFAULT_MAIL_POLL_MS, resendBaseUrl = RESEND_BASE_URL, ceilings = {}, log = console } = {}) {
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
  const api = {
    domain,
    mailStore,
    addresses,
    sync,
    policy,
    send: (msg, opts) => policy.send(msg, opts),
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
      };
    },
  };
  return api;
}
