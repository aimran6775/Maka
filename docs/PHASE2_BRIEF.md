# Maka — Phase 2 brief: the business crew

Read README.md, CODE_MAP.md, docs/BRAIN.md, docs/KICKOFF_BRIEF.md and docs/DECISIONS.md first.
The kickoff brief holds the product laws, the park metaphor, the hierarchy, the leash model,
the mail stack, the browser model and the model strategy. This brief orders the phase 2 work.
Same working rules as phase 1: Node core only in the sidecar, vanilla ES modules in the
frontend (Three.js is the one vendored library), additive-only shared contract, truthful
telemetry, atomic persistence, test:fast green before every push, docs true to what exists,
commit and push to main after every numbered step.

Defaults set by the owner (2026-10-10): judge daily cap 10 USD, business money-out daily cap
0 USD until the Superintendent raises it at the Gate. Judge models: `claude-sonnet-5-5` for
per-step review, `claude-opus-5-5` for Chief Ranger planning and reflection; both configurable
in policy.json. Workers: Ollama, model from `OLLAMA_MODEL`.

No real keys exist in the build environment: every step is built and tested against fakes
(fake provider, fake JMAP/Resend/Cloudflare/CDP servers in test/helpers). Real HTTP paths stay
small and obviously correct. A separate live-test session runs them against real services.

## Part A: crew, leashes, judge, Peak (steps 1-8)

1. Leash enforcement. `sidecar/capability/gate.js` consults `shared/leash.js`: each tool
   declares its leash domain; the gate resolves the agent's level for that domain (per-agent
   overrides → zone default → park default). Observe: tool refused with a typed result.
   Draft for review: the action is captured as a pending Gate item (`gate.item` event:
   id, agentId, domain, tool, args summary, evidence, status) and the run waits
   (`agent.waiting`). Act with cap: allowed while the domain's daily cap holds, else Gate
   item. Act freely: allowed, logged. `/api/gate` lists items; `/api/gate/:id` POST
   approve / revise(notes) / reject resolves them and resumes the run. Daily caps and
   earned loosening (N approvals without rejection → proposal item) live in
   `sidecar/leash-ledger.js`, persisted atomically.
2. Judge step. `sidecar/judge.js` implements the pre-Gate review hook left in loop.js:
   before any action in a non-research domain at level ≥ Act with cap, and before a run
   ends, the judge model reviews the worker's output and returns approve / revise(notes) /
   reject. Revise and reject go back to the worker as a new turn (bounded retries). Every
   judge call is a `judge.verdict` event (agentId, runId, verdict, model, usd) and counts
   against the judge daily cap; at cap the run falls back to Draft for review. The router
   records tier per turn (already) and the ledger records judge spend separately.
3. Agents and the hierarchy. `sidecar/agents.js`: agent records (id, name, role, zoneId,
   parentAgentId, venture, persona, model policy, leash overrides) persisted atomically;
   `/api/agents` CRUD. Chief Ranger is a singleton at the Peak. Rangers may create Junior
   Rangers (role junior_ranger, parent = creator) one level deep only; the gate enforces
   the depth.
4. Concurrency and handoffs. `sidecar/runs.js` runs N agents concurrently with separate
   workspaces (`<root>/<agentId>/`), a per-agent run queue, and a global concurrency cap
   from config. `sidecar/trails.js`: work items (id, brief, budget, deadline, evidence
   requirements, fromAgentId, toAgentId, status) persisted; a delegation emits
   `work.handoff` and enqueues a run for the receiver; completion emits `work.done` with
   the deliverable ids. A `delegate` tool is available to chief_ranger and ranger roles.
5. Chief Ranger planning. `sidecar/chief.js`: a `mission` from the Superintendent (text +
   budget + horizon) produces a plan (ventures, roles needed, tasks, budgets) as a
   structured deliverable, staffs it by creating or assigning Rangers, and delegates along
   trails. Plan changes are `plan.updated` events. Everything the Chief decides is
   visible at the Peak with evidence; approvals only for Gate domains.
6. Reflection cycle. `sidecar/reflect.js`: a scheduler (cron-like, pure math + lock,
   persisted) runs the reflection daily and on `budget.threshold` / KPI breach events:
   per venture, actuals vs targets from real ledger and connector data, what worked, what
   did not, plan revision, and a briefing per department written to that station's mailbox
   (when mail exists; until then to the station's notes store). Output is a
   `reflection.posted` event and a stored document. Morale notes are grounded in numbers
   present in the data; the prompt forbids invented praise.
7. Park: stations and crew. Frontend: department camps (sales, marketing, finance,
   support, research, listings), Visitor Center, trailheads per venture, placed by
   `frontend/park/placement.js` from the layout (zones now have `kind`); multiple Ranger
   bodies with role colors; handoff movement along trail splines from `work.handoff`;
   Junior Rangers smaller; the Chief at the Peak. Inspector panels extended: Ranger card
   gets brief / pause / reassign actions (POST routes), zone card gets roster + budget burn
   + leash defaults, Peak card gets the portfolio (ventures, plan, latest reflection, Gate
   queue count), trail card lists items in transit, Gate card is the approval queue with
   approve / revise / reject. A `work.done` makes the Ranger walk its deliverable to the
   Visitor Center outbox.
8. Away mode. `away` flag on the park: while away, all Gate items also append to an
   evidence log (`<root>/_peak/away-log.ndjson`), the Peak card shows "Away since …, N
   actions, M waiting", and the Superintendent gets a digest at return (and by mail to
   gate@ once mail exists).

## Part B: mail and browser (steps 9-13)

9. Cloudflare DNS step. `sidecar/mail/dns.js`: given the zone id and a DNS token,
   computes the full record set for Fastmail (MX, SPF, DKIM, DMARC) plus Resend (DKIM
   selector, return-path) for makapark.com, shows a dry-run diff via `/api/mail/dns/plan`,
   and applies via `/api/mail/dns/apply` only as a Gate item (account_settings). Fake
   Cloudflare server in tests.
10. Fastmail JMAP. `sidecar/mail/jmap.js`: session discovery, mailbox listing, alias /
    mailbox creation (station mailboxes peak@, rangers@, visitors@, sales@, marketing@,
    finance@, support@, research@, listings@, gate@ at park setup; Ranger aliases
    `<role>-<venture>@` on demand under account_creation), incremental sync into a local
    mail store (`sidecar/mail/store.js`, threads, labels, venture tags), sending replies
    under outbound_messages. Fake JMAP server in tests.
11. Resend. `sidecar/mail/resend.js`: bulk/transactional sends with unsubscribe link
    injection, suppression list, and a webhook receiver (`/api/mail/resend/webhook`,
    signature verified) that writes delivered / bounced / complained / opened into the mail
    store. Routing rule in `sidecar/mail/send.js`: one-to-one replies → Fastmail; campaigns
    and notifications or > N/hour → Resend. Both under leashes.
12. Mail tools and UI. Tools `mail.search`, `mail.read`, `mail.draft`, `mail.send`,
    `mail.create_address` with leash domains; Visitor Center card shows station inboxes,
    threads by venture, outbox; Ranger card shows their addresses. Classification
    (customer / supplier / platform notice / spam) by the worker model, judge on ambiguity.
13. Browser over CDP. `sidecar/browser/cdp.js`: launch a Chromium (path from config or
    discovered), connect over the DevTools WebSocket with core modules only, one profile
    directory per Ranger. Tools `browser.open`, `browser.read` (accessibility tree + text),
    `browser.click`, `browser.type`, `browser.upload`, `browser.download`,
    `browser.screenshot`, all under browser_control; a `browser.handoff` event when a
    login / 2FA / captcha / payment page is detected (heuristics + the page asking), with a
    `/api/browser/handoff/:id/return` route; every action appended to a trace with
    screenshots under `<root>/<agentId>/browser-trace/`. Tests against a local test page
    served by the sidecar and a fake CDP endpoint for the protocol layer.

## Part C: connectors (steps 14-18)

Each connector: official API only, read paths first, write paths behind the matching leash,
a fake server in tests, a sync job into the local store, and events the park can show.
Connector credentials are Gate items (account_creation / account_settings) and live in the
keystore. Spend and revenue figures shown anywhere come only from these syncs.

14. Connector framework: `sidecar/connectors/registry.js`, auth kinds (api key, OAuth 2
    with PKCE via a local callback on 127.0.0.1), token store in the keystore, sync
    scheduler reuse from step 6, `connector.sync` / `connector.error` events, Park Store
    fixture grants a connector to a zone.
15. Stripe: balance, charges, payouts, refunds (refund = money_out). Finance camp.
16. Shopify and Etsy: products, listings, orders, inventory; listing create/update =
    publishing; price change = money_in; supplier/dropship order = money_out. Listings camp
    and Sales camp.
17. Meta Ads and Google Ads: campaigns, spend, results read; budget changes and new
    campaigns = money_out with the daily cap. Marketing camp.
18. Scout research tools: `web.search` (a search API key configured by the Superintendent
    or the browser as fallback), `web.read` (readability extraction), trend sources via
    official APIs where they exist; venture brief template with evidence, costs, and a
    go/no-go the judge reviews; the Chief decides within budget.

## Done means
- All 18 steps on main, test:fast green, CODE_MAP / BRAIN / DECISIONS / README true.
- A scripted demo (`scripts/demo-phase2.mjs`) against the fakes: mission → plan →
  delegation → a Ranger run with tools → a money_out action waits at the Gate → approve →
  deliverable in the outbox → ledger matches the fake provider's reported usage →
  reflection posts. The headless browser check shows the crew moving in the park.
- A `docs/LIVE_TEST.md` runbook for the live session: which env vars, which fakes to
  disable, the exact sequence to prove the chain against real Claude, Fastmail, Resend,
  Cloudflare.
When done, send the parent session a summary via `mcp__claude-code-remote__send_message`
(session id in the first message of this session).
