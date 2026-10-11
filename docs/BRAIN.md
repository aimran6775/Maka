# BRAIN — orientation

Start here if you are new to the codebase. This page says how Maka is shaped and where to
read next. It describes only what is on disk; `CODE_MAP.md` is the authoritative file list.

## The shape

```
browser (frontend/, vanilla JS, canvas)
   │  HTTP + SSE, JSON events validated against shared/events.js
   ▼
sidecar (one Node process, no dependencies)
   ├─ chief       mission → plan (schema-checked) → hire → delegate; follow-ups on work.done
   ├─ reflect     daily and on budget breach: actuals per venture → document + briefings
   ├─ mail        Resend in and out, routed to stations by address rules, stored locally
   ├─ runs        N runs at once, one per Ranger, queued past the cap
   ├─ trails      work items between zones: handoff → receiver run → done
   ├─ loop        the agentic while-loop; every transition is an event
   ├─ capability  world layout → tool allowlist; a placed object is a tool grant;
   │              the leash decides whether a granted action runs, waits at the Gate,
   │              or is refused
   ├─ gate-queue  the Entrance Gate: items waiting on the Superintendent, decisions,
   │              loosening proposals; leash-ledger counts the day's actions and money
   ├─ providers   Anthropic, OpenRouter, Ollama; streaming + tool use
   └─ store       atomic on-disk persistence (runs, transcripts, spend, layout, leash,
                  ledger, gate items)
```

Three ideas carry everything:

1. **Events are the only truth.** The loop emits events; the store persists them; the
   frontend renders them. Nothing in the UI changes without an event, and every event is
   schema-checked by both sender and receiver.
2. **Layout is permission.** A tool is callable only when the agent's room contains the
   object that grants it (or the agent's role grants it, for crew tools). The user builds
   the org by placing things; the layout's agents ARE the agent records.
3. **Pure core, injected edges.** Loop, gate and store are plain functions over injected
   provider / clock / signal / fs so they are tested with fakes and the real HTTP paths
   stay small.

## Current state

Phase 4 (`docs/PHASE4_BRIEF.md`, "beyond StarNet") is under way. Step 1 done: the owner
channels' contract and registry (`sidecar/channels/`). An adapter is transport only
(start / stop, send a card or a text, hand every inbound message to the registry); the
registry decides everything: a chat is trusted only after it sent the single-use
8-character pairing code shown at the Peak (ten minutes, five wrong attempts revoke it),
only a paired chat may approve, revise or reject a Gate item (a button or a slash
command; Revise takes the notes from the next message), re-list the Gate, toggle away
mode or ask the Peak a question, which is one tool-less run of the Chief on its planning
model over the recorded data, answered with the run id as evidence. Every pending Gate
item goes to every paired chat as a card, decided items tell the other chats who decided,
reflections and away digests go as text, and every send and every inbound message is an
event (`channel.delivery`, `channel.inbound`); an unpaired chat's attempt to act is
refused and logged. Bot tokens live in the keystore or the Keychain, reach the adapter's
`start()` only, and go in through the Gate like a connector key. The adapters themselves
(Telegram, Discord, Slack) are steps 2 and 3.

Safety review (`docs/SECURITY_REVIEW_2026-10-10.md`, before the first Mac build): the
findings are being fixed in order, each with a regression test in `test/safety.test.js`
and its row's Status updated. H1 done: `sidecar/netguard.js` keeps every Ranger-facing
network tool (`web.fetch`, `web.read`, `browser.open`, `browser.download`) and every page
the browser lands on to the public internet, checked after DNS and on every redirect hop,
so a Ranger cannot drive Maka's own routes through its tools. H2 done: a money_out
action whose amount the tool cannot prove (an ad campaign with no campaign-level budget,
a Stripe charge the store does not know) is a Gate item at every leash level, never a $0
pass under the cap; a lifetime budget counts in full; activation of a campaign with no
campaign-level budget is refused outright. M1 done: at Act with cap the ledger reserves
the amount before the action runs and commits it on success (releases it otherwise), so
concurrent runs cannot all pass the same cap between a check and a record. M2 done: a
leash layer that omits a cap inherits the cap of the next layer out, so an override can
never drop the park's money cap; money_out and money_in are never proposed for Act
freely, and a cap in those domains holds at Act freely too; an agent-scoped cap is
compared with that agent's own spend, a zone or park cap with the park's. M3 done:
`POST /api/run` passes only its documented fields to the run manager, so a request can
no longer switch the judge off, borrow the Chief's planning step or replace the system
prompt. M4 done: every mutating `/api` request needs the per-boot token from
`/api/state` in `x-maka-token`, a same-origin Origin when a browser sends one, and
`application/json`; the park page and the menu bar item carry the token, the Resend
webhook keeps its signature instead. M5 and M6 done: a message's kind is derived from
its recipients and the thread, never declared (one recipient answering mail the park
holds is a reply; everything else is a campaign under publishing with the footer and the
recipient ceiling), a send names at most 50 recipients, and drafts are not mail history
for the new-recipient judge trigger or the hourly ceilings. L1 done: the browser's
handoff check runs before an action as well as after it, and a payment page is handed
back only with notes, so a returned checkout page cannot let the next "Place order"
click run unchecked. L2 done: a Stripe refund is for USD charges only; a charge in
another currency has no provable amount and is refused. L3 done: a tool whose domain
function throws falls back to its known domain, or is refused; it never runs unleashed. L4 done: a
delegated budget is capped at what the delegator has left (the mission for the Chief,
the active run for a Ranger), so sub-runs cannot multiply a budget. L5 done: no
connector fixture stands at the Mountain Peak (placement and layout replacement refuse
it, and one in a hand-edited layout grants the Chief nothing), so the unjudged Chief
never holds a money tool. Every row of the review is fixed, and the flaky test it saw
is gone with it: syncs of one connector now queue instead of one answering "skipped"
(D124).

Phase 3 (the macOS app, `docs/PHASE3_BRIEF.md`) is built. Step 7 done: the release
gates and the runbook. `npm run release` refuses to start unless `HEAD` is the release
tag and the tree is clean, then runs `test:fast`, the phase 2 demo and the shell check,
builds, notarizes, launches the built app once with a fresh home
(`scripts/release-smoke.mjs`: the park answers from the bundle, the first-run card is
due, secrets go through the Keychain broker, SIGTERM stops app and sidecar together) and
assembles the site. `docs/RELEASE_RUNBOOK.md` has the exact Mac commands, the one-time
setup, the clean-account launch to observe by hand, publishing, the updater end to end
and rollback; a test keeps it naming every script, variable and gate. What this Linux
build environment cannot run (Xcode, the Keychain, Gatekeeper) is scripted and written
down, not claimed. Step 6 done: the release
scripts (`scripts/release*.mjs`). `release-bump` sets one version in three files and
tags; `release-node` downloads the official Node binary and verifies it against
nodejs.org's checksums before Tauri bundles it; `release-build` runs `cargo tauri build`
with the committed config overlay (the updater's public key substituted from the
environment) so Tauri's bundler signs every binary with the Developer ID certificate,
notarizes and staples the `.app`, builds the `.dmg` and the signed updater tarball;
`release-notarize` notarizes and staples the `.dmg` too and runs Gatekeeper's own checks;
`release-site` assembles `dist/site/` from `website/` (a version-free page) plus
`releases/latest.json` for the updater and `download.json` for the page. `release.mjs`
runs them in order after the gates; `--dry-run` prints every command and writes
`plan.sh` and dry-run manifests, which is how the sequence is tested here without
Xcode. Secrets are six environment variables, never files in the repo. Step 5 done: the
offsite backup (`sidecar/backup/`). A snapshot is a tar of the Peak's files, the mail
store, every Ranger's outbox and the home's ledgers and records (never transcripts,
browser profiles or the keystore), gzipped and sealed with AES-256-GCM under a 32-byte
key that lives in the Keychain (the keystore without the app) and is shown once when
backups are enabled; it is `PUT` to Cloudflare R2 with a hand-written Signature V4
client over `fetch` (checked against AWS's own example) under `<prefix>/<host>/`, with
an unencrypted `latest.json` index beside it. The Superintendent enables it on the Peak
(daily at a time, into a bucket), runs one now, verifies the latest (opened and listed,
nothing written) or restores it into a fresh `workspace/_restore/<stamp>/`, never over
live data. Every outcome is a `backup.snapshot` / `backup.restore` event; "not wired"
names the variables that are missing. Step 4 done: Ollama
management on the Peak as well as at first run, from one shared module
(`frontend/ui/worker.js` over `sidecar/ollama.js`): found or not with the install hint
and a Start button, the pulled models each with their file size, a resident estimate
(1.3 × the file, said as a rule of thumb), the headroom against half the machine's
memory or "over the budget", a remove button, the recommended pull with Ollama's own
progress. The router does not change: without a reachable worker a run answers
`OLLAMA_UNREACHABLE` (now saying what to do), without a model `NO_MODEL`, and nothing
runs on a paid provider unless `policy.json` opts into the hosted fallback (D71). Step 3
done: the first
run. A card over the park (`frontend/ui/firstrun.js`, state from `sidecar/setup.js`)
walks the Superintendent through four steps, each true to what the sidecar found: the
workspace root (the LaCie at `/Volumes/LaCie/Maka/workspace` is the default when it is
mounted; a changed root goes into `config.json` and the sidecar restarts itself
in-process, the page reconnects), the judge key (checked with the provider before it is
stored; an invalid key is refused, an unreachable provider is said), the worker
(`sidecar/ollama.js`: Ollama found or not with the install hint and a Start button, the
models it has, memory as the OS reports it, the largest tool-capable model that fits
half of it offered as one Pull with Ollama's own byte progress as `ollama.pull` events),
and the mission (the Chief is already at the Peak; the same `POST /api/mission` as the
Peak card). Done or Later closes it for good (`setup.json`). Step 2 done: the shell
owns every secret in the macOS Keychain (`src-tauri/src/credentials.rs`) and hands the
sidecar a session-scoped handle instead: a Unix socket plus a random token
(`src-tauri/src/broker.rs`, `MAKA_CREDENTIALS_SOCKET` / `MAKA_CREDENTIALS_TOKEN`) that
die with the session. `sidecar/providers/keys.js` resolves a key from the environment,
then the broker when there is one, else the 0600 keystore file, which is now the
development fallback only: with a broker configured the file is never read, and a broker
that refuses or is gone is a reported "no key". Every write (a connector key approved at
the Gate, an OAuth token, the first-run key of step 3) goes through the same `setKey`,
so the Keychain is the one store in the app. Step 1 done: the Tauri 2
shell in `src-tauri/`. It is a thin host, not a second application: it finds the bundled
Node and the bundled `sidecar/` + `shared/` + `frontend/`, starts `node sidecar/index.js`
on a free loopback port with the app-data directory as `MAKA_HOME`, waits for
`/api/state`, and points one webview window at the park the sidecar serves. The window
closing hides it; the app lives in the menu bar (the Gate's pending count as the title,
the Away toggle, "Start at login", the updater, Quit) until Quit, which stops the sidecar.
A sidecar that dies is restarted, three times a minute at most, then the splash page
shows the error and the log path. Everything the shell shows comes from `/api/state`.
The Rust is cross-checked from Linux (`cargo check --target aarch64-apple-darwin`); the
build, signing and notarization happen on the owner's Mac (steps 6 and 7).

Phase 2 is complete. `npm run demo` proves the chain against the fakes from recorded
events (`scripts/demo-phase2.mjs`); `docs/LIVE_TEST.md` is the runbook for the real
services; `node scripts/park-check.mjs` shows the crew moving in headless Chromium.

Phase 2 step 18 done: the Scout's kit, and with it every step of the phase 2 brief. A
Trailhead sign now grants a Scout `web.search` (the Brave Search API when the
Superintendent set a key, otherwise the Ranger's own browser on DuckDuckGo, traced like
any browser action), `web.read` (a page as an article: title, author, date, the text
without the chrome, its links), `web.trends` (Wikipedia pageviews and Hacker News activity
for a topic, from official keyless APIs; Google Trends has none) and `brief.submit`. The
venture brief is a schema: evidence with source URLs, costs with a basis, a revenue model,
risks, a go / no-go with confidence. The judge reviews it (approve, revise with what is
missing, reject), the brief lands in the Scout's outbox as a deliverable with the verdict
written in, the Peak lists every brief, and the Chief, when the work item finishes, is
told to decide within the mission budget.

Phase 2 step 17 done: the ad networks. Meta Ads (a long-lived access token and the ad
account id) and Google Ads (a Google sign-in approved at the Gate with the owner's OAuth
client and developer token, the customer id) sync their campaigns, budgets and the last
seven days of spend and results into the local store; the Marketing camp card, the Ads
Ranger's tools and the reflection read from there. A Notice board placed in the camp
grants the reads (research) and the money: a new campaign (always created paused), a
daily budget change and an activation are money_out with the daily budget as the amount,
so the Gate item and the ledger carry the figure and the daily cap applies; pausing
moves nothing. Ad sets, ad groups and creatives are not managed in this build.

Phase 2 step 16 done: the storefronts. Shopify (a custom app's Admin API token and the
shop domain) and Etsy (an OAuth sign-in approved at the Gate, the app keystring as the
client id) sync their products or listings, orders and stock into the local store; the
Listings and Sales camp cards and the Storefront Ranger's tools read from there. A Park
Store placed in a camp grants the reads (research), listing creation and updates
(publishing: a new Etsy listing is always a draft until a separate update activates it)
and price changes (money_in). Neither platform's API buys from a supplier, so no
money_out tool exists for the storefronts and the park does not pretend one does. A
connected platform with an empty store syncs at boot, so the camps show figures within
seconds of a restart.

Phase 2 step 15 done: Stripe. `STRIPE_API_KEY` (or a key approved at the Gate) connects
it; every 15 minutes and on demand the balance, charges, payouts and refunds are read into
the local store, and that store is what the Finance camp card, the Books Ranger's tools
and the reflection show, amounts in the platform's own currency. A Fee booth placed in the
Finance camp grants the reads (research) and `stripe.refund`, the one write: money out,
so the Gate item and the ledger carry the real amount (the charge's remaining amount when
none is given), the daily cap applies at act_capped, and the refund is tagged with the
Ranger that made it.

Phase 2 step 14 done: the connector framework. One registry defines each platform as data
plus two functions (a client and a sync); a platform's environment variable connects it
at boot, and a key or an OAuth sign-in given in the park is an Entrance Gate item the
Superintendent approves before anything lands in the 0600 keystore. Connected platforms
sync on the scheduler into a local store the park reads; every sync and failure is an
event, and the figures shown anywhere come only from those syncs. A Park Store placed in
a camp grants the framework's own tools; the platforms (Stripe, Shopify, Etsy, the ad
networks) are the next steps, so the Peak's connector list is empty and says so.

Phase 2 step 13 done: the browser. A Field office placed in a camp grants its Rangers a
real Chromium driven over the DevTools protocol with core modules only: open, read (text
and accessibility tree), click, type, upload (workspace files only), download (into the
workspace) and screenshot, every action under the browser_control leash and appended to
a per-Ranger trace with a screenshot. Each Ranger has its own profile directory in the
workspace, so a login survives; the browser closes with the run. When a page asks for a
password, a one-time code, a captcha or card details, the action parks, the Peak and the
Gate show a BROWSER HANDOFF, the window comes to the front, and the Ranger continues when
the Superintendent hands the page back (with a note). Headless mode is for tests and
servers; on the desktop the window is real so the handoff can be done.

Phase 2 steps 12 and 12b done. Mail tools: a Radio tower placed in a camp grants its
Rangers `mail.search`, `mail.read`, `mail.draft`, `mail.send` and `mail.create_address`;
reads are research, sends follow the leash by kind (replies and notifications are
outbound messages, campaigns are publishing), a new address is account creation, and a
send to a never-seen address asks the judge even at Draft. Inbound mail is classified by
the worker model (the judge when it is unsure; "unclassified" when nothing is reachable)
and the Visitor Center and camp cards show addresses, inbox threads by venture and the
outbox with delivery status. Hosted worker: `huggingface` is a fourth provider behind the
`hosted_worker` tier (HF_TOKEN), metered by calls per day in the ledger; a policy may
route turns to it or opt into a fallback when Ollama is unreachable, always recorded.

Phase 2 step 11 done: mail policy. `sidecar/mail/send.js` decides who may send from
which address (a Ranger from its aliases and its station, the Chief from the Peak and any
station, the Superintendent from any station), which leash domain a message falls under
(replies and notifications are outbound messages, campaigns are publishing), hourly
ceilings per Ranger, per station and for campaign recipients, and asks the judge to review
a send to an address the park has never exchanged mail with even while the domain is at
Draft for review. A tool's leash domain may now depend on its input, which is how the mail
tool of step 12 will pick its domain by kind.

Phase 2 step 10 done: the mail system's store and transport. Station addresses exist as
routing rules the moment the park boots (peak@, rangers@, visitors@, the camps, gate@ for
the Superintendent, unsubscribe@), Ranger aliases are rules too, and unknown recipients
land in visitors@ for triage. With `RESEND_API_KEY` wired the sidecar polls Resend's
receiving API every minute after a persisted cursor (and takes the `email.received`
webhook when `RESEND_WEBHOOK_SECRET` is set), downloads attachments, threads messages
and stores them under `<root>/_mail/`; delivery webhooks mark sent copies and a hard
bounce or a complaint suppresses the address; a reply to unsubscribe@ suppresses the
sender. `send()` is the mechanics only (suppression, thread headers, campaign footer);
step 11 decides who may send what.

Phase 2 step 9 done: the mail domain's DNS. With `RESEND_API_KEY` and
`CLOUDFLARE_API_TOKEN` wired, "Plan DNS" on the Peak (or `POST /api/mail/dns/plan`) asks
Resend for makapark.com's records, adds DMARC, diffs them against the Cloudflare zone and
shows what would change; "Apply DNS" parks the write at the Entrance Gate as an
`account_settings` item with the diff as evidence, and only an approval registers the
domain at Resend if needed, writes the records and asks Resend to verify. Tested against
fake Cloudflare and Resend servers; `docs/LIVE_TEST.md` will carry the live sequence.

Phase 2 step 8 done: away mode. "I'm away" on the Peak card (or `POST /api/away`) turns
on the evidence log: every Gate decision and the other notable events are appended to
`<root>/_peak/away-log.ndjson`, Gate items are stamped `away`, and the Peak shows "Away
since …, N actions, M waiting". "I'm back" writes a digest (counts by status, domain and
Ranger, what still waits, work done, spend, notable events) next to the log, emits
`away.digest`, and will mail gate@ once the mail system exists. Part A of phase 2 is done.

Phase 2 step 7 done: the park shows the crew. Department camps, the Visitor Center (made
at boot) and a trailhead per venture (made when the Chief submits a plan) are rooms in the
layout, drawn as clearings dressed per kind; trails run hub-and-spoke through the Ranger
Station plus trailhead ↔ the camps serving that venture, and a walk between any two zones
is one or two legs. Every agent has a body cloned from the rigged template with its role's
tint and size (the Chief gold on the Peak, Juniors small), a name and a state badge; the
receiver walks the route after a `work.handoff`, and walks its deliverable to the Visitor
Center after a `work.done` with files. Panels: Ranger (brief / pause / reassign, spend vs
budget, work items), zone (roster, budget burn, editable leash defaults, queue), trail
(items in transit), Gate (approve / revise / reject), Peak (portfolio). The headless check
is `scripts/park-check.mjs`.

Phase 2 step 6 done: the reflection cycle. A persisted cron-like scheduler runs the
reflection daily (`reflectAt`, 07:00 by default) and a budget watcher runs it when a
venture or the mission crosses 100 % of its model-spend budget (80 % and 100 % are
`budget.threshold` events). The reflection gathers only recorded facts per venture, asks
the Chief's model for a JSON document, grounds every morale note in a number, stores the
document, writes it to the Chief's outbox and a briefing to each department's notes
store, emits `reflection.posted`, and hands the Chief a follow-up to revise the plan. At
the judge cap it is recorded as skipped with the reason.

Phase 2 step 5 done: Chief Ranger planning. `POST /api/mission` (or the form on the
Peak card) gives the Chief a mission with a budget and horizon; the Chief runs on the
judge tier's planning model and must call `plan.submit` with a schema-checked plan
(ventures, roles, tasks, budgets, risks, what needs the owner), then `crew.hire` to staff
department camps (created on demand) and `delegate` to start tasks. Every version is
stored and written to the Chief's outbox; `plan.updated` keeps the Peak current; a
finished delegated item brings the Chief back for a bounded follow-up. The judge daily
cap and a per-mission follow-up cap pause the mission rather than spend past them.

Phase 2 step 4 done: concurrency and handoffs. The run manager runs several Rangers at
once (one run per Ranger, a global cap from `config.json`), queues the rest in arrival
order and announces a queued run with `agent.run.queued`. `sidecar/trails.js` turns a
delegation (the `delegate` tool, or `POST /api/work` from the Superintendent) into a
persisted work item, a `work.handoff` along the trail between the two zones, and a run
for the receiver briefed from the item; when that run ends, `work.done` names the files
that appeared in the receiver's outbox. `work.check` lets the delegator read the result.

Phase 2 step 3 done: agents and the hierarchy. `sidecar/agents.js` owns agent records
(the layout's agent entries, now with venture, specialty, persona, per-agent worker
policy and budget), the Chief Ranger singleton at a `mountain_peak` room created at boot,
the parent rules (Rangers under the Chief, Juniors one hop under a Ranger), per-agent
leash overrides, and `/api/agents` CRUD. Rangers get the `crew.spawn_junior` tool by
role. Runs carry the agent's persona in the system prompt. Only one run at a time still
(step 4), and the park still draws one body (step 7).

Phase 2 step 2 done: the judge step. `sidecar/judge.js` supplies the loop's review hook:
before a worker's tool calls in a non-research domain at Act with cap / Act freely, and
before every run ends, Claude (`claude-sonnet-5-5` by default) answers approve / revise /
reject with notes; revise and reject go back to the worker as its next turn (bounded).
Each judge call is a `judge.verdict` plus a `cost.estimate { tier: 'judge' }`, counted in
the ledger against a 10 USD daily cap; at the cap, without a key, or on a failed call the
verdict is `skipped` and the action falls back to the Gate as Draft for review.

Phase 2 step 1 done: leash enforcement. Every tool with a leash domain now goes through
`resolveLeash` (agent override → zone default → park default) in the capability gate:
Observe refuses, Draft for review parks the call as a `gate.item` until the Superintendent
approves / revises / rejects it at the Gate (`POST /api/gate/:id`), Act with cap runs
while the ledger's daily USD and action caps hold, Act freely runs and is counted. Five
approvals in a row raise a proposal to loosen that Ranger one level; approving it writes
an agent override into `leash.json`. The park shows the queue as cards and on the Gate,
Ranger and Peak inspector panels, and a Ranger whose run is parked stands at the Gate.

Phase 1 (done): the first slice of the 3D park. `npm run assets` vendors Three.js
and the CC0 kits (hash-verified), `npm start` serves the park: seeded terrain with a river,
sky and sun from the real clock, instanced forest, the Ranger Station clearing with its
building, the Entrance Gate clearing with its gate, a trail between them, one animated
Ranger whose clip and place follow real run state, the Mountain Peak as a raised control
centre with a phase 1 panel, orbit / fly / follow cameras, click to inspect, build mode by
clicking inside a clearing, and the DOM panels (COMMS, SPEND, BUILD, INSPECT, Gate cards).
The workspace root is configurable and may vanish (external drive): the sidecar then
pauses runs and the page says "workspace offline". Everything shown comes from sidecar
events and GET endpoints.

### The event contract (`shared/events.js`)

An event is `{ v, id, type, ts, seq?, payload }`. Payload schemas are strict
(`additionalProperties: false`) so a typo is a validation failure, not silent data loss.
`cost.estimate.reconciled` is the single flag the spend readout trusts: a cost event is
reconciled only when the token counts came from the provider's own usage report and the
model has a known price.

### The leash (`shared/leash.js`, `sidecar/capability/gate.js`, `sidecar/gate-queue.js`)

A tool declares a domain (`tool.domain` or `TOOL_DOMAINS`). The gate resolves the agent's
level for it and either runs the tool, refuses it, or submits a Gate item and awaits the
decision with the tool call parked (no provider call is in flight, so waiting is free).
The ledger (`sidecar/leash-ledger.js`) is the only counter of "what ran today" per domain,
and the only source for the daily caps. Everything the Gate decides is a `gate.item` event
with the same `itemId` across its status changes.

### The judge (`sidecar/judge.js`)

A second model never rewrites the first. The judge sees the brief, what the worker said,
and the tool calls with their leash levels, and returns one JSON verdict. The loop turns a
revise / reject into error tool results (for actions) or a new user turn (for the closing
answer). The judge's cost is a reconciled cost event like any other, with `tier: 'judge'`,
so SPEND and the Peak show it; when the judge cannot run, the event says so.

### The loop (`sidecar/loop.js`)

One turn = one provider call + the tool calls it asked for. Before every provider call the
loop checks, in order: cancelled, max turns reached, spend at or over budget. The provider
streams normalized chunks (`text_delta`, `tool_use_start`, `tool_input_delta`,
`message_end`); the loop accumulates them by content-block index, then answers every
`tool_use` block with exactly one `tool_result`, even for a thrown tool, unparsable input
JSON, or a cancel that lands between two tool calls. Spend only counts reconciled cost, so
an unpriced model cannot be budget-capped (the UI shows its tokens as unreconciled).

## Reading order once code exists

1. `shared/events.js` — the vocabulary.
2. `sidecar/loop.js` — the behaviour.
3. `sidecar/capability/`, `shared/leash.js`, `sidecar/gate-queue.js`, `sidecar/leash-ledger.js` — the permission model.
4. `sidecar/router.js`, `sidecar/judge.js` and `sidecar/providers/` — which model runs and what it costs.
5. `sidecar/index.js` — how it is served and persisted.
6. `frontend/app.js` — how it is shown.
