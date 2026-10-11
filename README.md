# Maka

A local-first macOS app where a crew of real AI agents, your Rangers, run an online business
for you. You supervise from a living national park whose layout is the org chart and the
permission model.

Maka is modeled on the concept and architecture of
[StarNet](https://github.com/androoAGI/starnet) (MIT, Andrew Sims) and built from scratch.

Product laws:

1. **Truthful telemetry.** The UI never asserts state the harness cannot prove.
2. **Layout is the org.** A room is a capability-scoped team; a placed object is a real tool grant.
3. **Secrets stay in the sidecar.** Never in the frontend.
4. **Ask, don't guess.** Agents turn ambiguity into one concrete question.
5. **Finished work has a front door.** Deliverables land as real files in an outbox.
6. **No outcome promises.** Maka shows what the agents did and what it cost, never what they will earn.
7. **Platform-compliant by construction.** Connector actions go through official APIs under each platform's terms.
8. **Replicate strategies, not property.** Rangers build original listings, copy and creative.
9. **Money out passes the Entrance Gate.** Always, under the leash model, with a hard daily cap.

Status: pre-alpha. See [docs/KICKOFF_BRIEF.md](docs/KICKOFF_BRIEF.md) for the plan.

## Run the park

Requires Node 22+ and a browser with WebGL2 (Safari, Chrome, or the Tauri webview later).
No npm dependencies. Three.js and the CC0 model kits are vendored by a script that verifies
each archive's SHA-256 (see `NOTICE.md` and `frontend/assets/manifest.json`); they are
committed, so the step below is only needed after a clean checkout without them or to
reproduce them.

```bash
npm run assets                        # fetch + verify Three.js and the kits (network)
ollama serve                          # local worker models (any tool-capable model pulled)
export ANTHROPIC_API_KEY=sk-ant-...   # the judge; or OPENROUTER_API_KEY; or the keystore below
# optional: HF_TOKEN (hosted worker), RESEND_API_KEY + CLOUDFLARE_API_TOKEN (mail), RESEND_WEBHOOK_SECRET
npm start                             # node sidecar/index.js
```

Then open <http://127.0.0.1:8790>. Orbit with the mouse, scroll to zoom, switch to fly or
follow with the buttons at the bottom, re-roll the terrain seed there too. Click a Ranger,
a zone, a trail, a fixture, the Entrance Gate or the Mountain Peak to inspect it. Routine turns run on the local worker model (Ollama at
`OLLAMA_HOST`, default `http://127.0.0.1:11434`, model `OLLAMA_MODEL` or the first installed).
Claude via the Anthropic API is the judge tier (see "Phase 2 so far").
Without Ollama running, a default run answers `400 OLLAMA_UNREACHABLE`; without a key, an
explicit Anthropic or OpenRouter run answers `400 NO_KEY`. The UI shows each provider as
wired, not wired, reachable or not reachable. Nothing is simulated.

Local models are smaller than Claude and must support tool calling (`ollama show <model>`
lists it). The judge pattern catches errors; it does not make a weak worker strong.

Environment: `PORT` (8790), `HOST` (127.0.0.1), `MAKA_HOME` (`./.maka`, data and keystore),
`MAKA_BACKUP_KEY` (the snapshot key when restoring on another machine),
`MAKA_WORKSPACE` (default `~/Maka/workspace`, or `workspaceRoot` in `$MAKA_HOME/config.json`;
one directory per Ranger, deliverables land in `outbox/`). The workspace root may live on an
external drive: when it is unmounted Maka pauses runs and shows "workspace offline", and
never writes anywhere else.

Scripting the sidecar: every request that changes the park (anything but a GET) needs the
per-boot token that `GET /api/state` returns, sent as `x-maka-token`, with
`Content-Type: application/json` and, from a browser, a same-origin `Origin`; the park page
and the menu bar item do this for you (`docs/SECURITY_REVIEW_2026-10-10.md`, M4). Rangers'
network tools reach the public internet only (never loopback, the LAN or this machine), a
money-out action whose amount the tool cannot prove goes to the Gate whatever the leash,
and money caps are inherited and never earned away (the same review, H1, H2, M2).

Keystore alternative to env vars (development, without the app): `$MAKA_HOME/keystore.json`
containing `{ "anthropic": "sk-ant-...", "openrouter": "..." }` with file mode `0600`. The
sidecar refuses to read a keystore with looser permissions. Inside the macOS app the
Keychain replaces the file (phase 3, below).

## What you can do in phase 1

The park has one zone (the Ranger Station), the Entrance Gate, a trail between them and one
Ranger. In BUILD, pick a Supply cache (grants `fs.read` and `fs.write` in the Ranger's own
workspace) or a Trailhead sign (grants `web.fetch`) and click inside the station clearing to
place it. In COMMS, write a brief and run it; tokens stream in, tool calls show their input
and result, and each turn says which model ran it and what it cost. A file write stops at
the Entrance Gate card until you allow or deny it; the Ranger walks to the Gate and waits
there. Deliverables land in `workspace/<ranger>/outbox/`. SPEND shows reconciled cost only.
Every animation state maps to a real event; the sun follows your clock and encodes nothing.

## Phase 2 so far

Step 1, leash enforcement: every tool with a leash domain is checked against the leash
(per Ranger, per zone, or the park default; edit `$MAKA_HOME/leash.json` or `PUT /api/leash`).
At "Observe" the call is refused; at "Draft for review" it waits as a card at the Entrance
Gate until you approve, revise or reject it, and the Ranger stands at the Gate meanwhile;
at "Act with cap" it runs while the day's USD and action caps hold; at "Act freely" it
runs and is counted. Five approvals in a row raise a proposal card to loosen that Ranger
one level. Phase 1 tools fall under `research` (reads and fetches) or none (`fs.write`,
still confirmed per call); the money, mail and connector tools arrive in later steps.
Step 2, the judge: with an Anthropic key, Claude (`claude-sonnet-5-5`, see `policy.json`)
reviews a Ranger's tool calls before they act at "Act with cap" or "Act freely" outside
research, and reviews the closing answer before a run ends; revise and reject go back to
the Ranger as its next turn. Every judge call shows in the transcript and SPEND with its
own cost, capped at $10 a day; at the cap or without a key the action waits at the Gate
instead. The judge step itself is wired; the park's "radio the station" animation is step 7.
Step 3, the crew: the Chief Ranger stands at the Mountain Peak from the first boot; Rangers
and Junior Rangers (one hop below a Ranger) are created, briefed and moved through
`/api/agents` with a venture, a specialty (scout, storefront, ads, marketing, support,
books), a persona and their own leash overrides. Rangers can spawn a Junior from a run.
Step 4, concurrency and trails: several Rangers run at once (one run each, up to
`maxConcurrentRuns` in `config.json`), the rest queue. The Chief and Rangers hand work to
each other with the `delegate` tool (the Superintendent with `POST /api/work`): the item
travels the trail between the two zones (`work.handoff`), the receiver runs with the brief,
budget, deadline and evidence requirements, and `work.done` names the files that landed in
its outbox. Step 5, the Chief plans: click the Mountain Peak and brief the Chief with a mission, a
model-spend budget and a horizon (or `POST /api/mission`). With an Anthropic key the Chief
plans on `claude-opus-5-5`, submits a plan the harness checks (ventures, roles, tasks,
budgets, what needs you), hires Rangers by specialty into department camps, and delegates
the first tasks; the plan is written to its outbox and shown at the Peak. Finished items
bring the Chief back to decide the next move, within the judge's daily cap.
Step 6, the reflection cycle: every day at `reflectAt` (07:00, `config.json`), and when a
venture or the mission spends 100 % of its budget, the Chief reflects on real recorded
data per venture (runs, spend, work items, Gate decisions; revenue is "unknown" until a
connector is wired), posts a document at the Peak and in its outbox, writes a briefing to
each department's notes, and comes back to revise the plan. "Reflect now" on the Peak
card runs it on demand. Morale notes must cite a number from the data.
Step 7, the crew in the park: every Ranger has a body (the Chief tall and gold on the
Peak, Juniors small), camps, the Visitor Center and a trailhead per venture are clearings
joined by trails through the Ranger Station, Rangers walk a trail when work is handed to
them and carry finished files to the Visitor Center. Click a Ranger to brief, pause or
reassign it; a zone for its roster, budget burn and leash defaults; a trail for the work on
it; the Gate to approve, revise or reject; the Peak for the portfolio. `node
scripts/park-check.mjs` runs the headless check against the fakes.

Step 8, away mode: click the Peak and "I'm away". Every Gate decision and notable event is
appended to `workspace/_peak/away-log.ndjson`, the Peak shows "Away since …, N actions, M
waiting", and "I'm back" writes a digest next to the log with what happened, what still
waits on you and what it cost. Nothing is hidden and nothing is rolled back for you: the
log is the account. That completes Part A of phase 2.

Step 9, the mail domain's DNS: set `RESEND_API_KEY` and `CLOUDFLARE_API_TOKEN` (or the
keystore keys `resend` and `cloudflare`), click the Peak and "Plan DNS" to see the records
Resend wants for makapark.com next to what the Cloudflare zone has; "Apply DNS" waits at
the Entrance Gate and writes them only when you approve.

Step 10, the mail store: every station has its address from boot (peak@, rangers@,
visitors@, the camps, gate@ for you, unsubscribe@), Rangers get `<role>-<venture>@`
aliases, and mail to anything else lands in visitors@ for triage. With `RESEND_API_KEY`
the sidecar polls Resend for received mail every minute (set `RESEND_WEBHOOK_SECRET` and
point Resend's webhook at `/api/mail/resend/webhook` through a tunnel for instant
delivery), threads it under `workspace/_mail/`, downloads attachments, and marks sent
copies delivered, bounced or complained; bounces, complaints and replies to unsubscribe@
suppress the address.

Step 11, mail policy: a Ranger sends only from its own aliases or its station's address,
replies and notifications fall under the outbound-messages leash and campaigns under
publishing, hourly ceilings (per Ranger, per station, campaign recipients; `mailCeilings`
in `config.json`) hold whoever sends, and a message to an address the park has never
exchanged mail with gets a judge review even at "Draft for review". You can send from any
station address with `POST /api/mail/send`.

Step 12, mail tools: place a Radio tower in a camp (BUILD) and its Rangers can search and
read the station's mail, draft and send replies, notifications and campaigns, and ask for
a venture address, each under the matching leash at the Gate. Inbound mail is classified
(customer, supplier, platform notice, spam) by the local worker, the judge when unsure.
Click the Visitor Center or a camp for its addresses, inbox threads by venture and outbox.

Step 12b, hosted worker: set `HF_TOKEN` and `policy.json` can route turns to
`hosted_worker` (Hugging Face Inference Providers, `Qwen/Qwen2.5-72B-Instruct` by
default) or opt into `"fallback": { "worker": "hosted_worker" }` for when Ollama is down.
It is metered by calls per day (`hostedWorkerCallsPerDay`), shown as unpriced spend.

Step 13, the browser: place a Field office in a camp (BUILD) and its Rangers drive a real
Chromium (found automatically, or `browser.chromiumPath` in `config.json` / `CHROMIUM`):
open, read, click, type, upload, download, screenshot, each under the browser_control
leash and traced with screenshots under `<workspace>/<ranger>/browser-trace/`. A login,
one-time code, captcha or payment page raises a BROWSER HANDOFF card at the Gate: finish
the step in the window, add a note, hand it back. Set `"browser": { "headless": true }` or
`MAKA_BROWSER_HEADLESS=1` for a server without a display.

Step 14, connectors: the Peak lists the platform connectors. A platform's environment
variable connects it at boot; "Connect" at the Peak takes an API key or starts an OAuth
sign-in, both as Gate items you approve before the credential lands in the 0600 keystore.
Connected platforms sync every 15 minutes (`connectors.syncEveryMs`) and on "Sync now";
the figures the park shows come only from those syncs. Place a Park Store in a camp to
grant its Rangers the connector tools.

Step 15, Stripe: set `STRIPE_API_KEY` (or connect at the Peak) and the balance, charges,
payouts and refunds sync into the local store; click the Finance camp to read them. Place
a Fee booth there and its Rangers can read the same figures and refund a charge, which is
money out: it waits at the Gate with its amount (or runs under the daily cap at
act_capped) and is tagged `maka:<ranger>` at Stripe.

Step 16, storefronts: Shopify needs `SHOPIFY_ACCESS_TOKEN` (a custom app's Admin API
token) and the shop domain (`"connectors": { "shopify": { "shop": "lanterns" } }` in
`config.json` or `SHOPIFY_SHOP`); Etsy needs `ETSY_CLIENT_ID` (your app's keystring) and a
sign-in started at the Peak. Products, listings, orders and stock sync into the local
store; click the Listings or Sales camp to read them. Place a Park Store there and its
Rangers can read the same, create or update listings (publishing; a new Etsy listing is a
draft until a second update activates it) and change prices (money_in).

Step 17, ad networks: Meta Ads needs `META_ACCESS_TOKEN` and the ad account
(`"connectors": { "meta_ads": { "adAccountId": "act_123" } }` or `META_AD_ACCOUNT_ID`);
Google Ads needs `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_DEVELOPER_TOKEN`, the customer id (`google_ads.customerId` or
`GOOGLE_ADS_CUSTOMER_ID`) and a sign-in started at the Peak. Campaigns, budgets and the
last seven days of spend and results sync into the local store; click the Marketing camp
to read them. Place a Notice board there and its Rangers can read the same, create a
campaign (paused), change a daily budget or activate one, each money out with the daily
budget as the amount at the Gate or under the daily cap.

Step 18, the Scout's kit: a Trailhead sign now also grants `web.search` (set
`BRAVE_SEARCH_API_KEY` for the API; without it the Ranger's browser searches DuckDuckGo,
which needs a Field office in the camp), `web.read` (a page as an article), `web.trends`
(Wikipedia pageviews and Hacker News activity for a topic) and `brief.submit`: a venture
brief with sourced evidence, real costs, a revenue model, risks and a go / no-go that the
judge reviews. Briefs land in the Scout's outbox and are listed at the Peak; the Chief
decides within the mission budget.
All of phase 2 (`docs/PHASE2_BRIEF.md`) and phase 3 (`docs/PHASE3_BRIEF.md`, the macOS
app, below) are in this build.
`npm run demo` walks the whole chain against the fakes (mission → plan → delegation →
tools → a refund at the Gate → the report in the outbox → the ledger → the reflection) and
checks every link from recorded events; `docs/LIVE_TEST.md` is the runbook for the same
chain against the real services.

```bash
npm run test:fast   # the merge gate
npm test            # everything under test/
```

## Phase 3 so far: the macOS app

Step 1, the shell: `src-tauri/` is a Tauri 2 host around the same sidecar. It starts the
bundled Node on `sidecar/index.js` with `~/Library/Application Support/com.makapark.maka`
as `MAKA_HOME`, opens one window on the park once `/api/state` answers, and keeps a menu
bar item with the Entrance Gate's pending count, the Away toggle, "Start at login" and
Quit (closing the window only hides it; the crew keeps running). On a Mac with Rust and
the Tauri CLI (`cargo install tauri-cli --version ^2 --locked`):

```bash
cargo tauri dev --config src-tauri/tauri.conf.json   # from the repo root; uses `node` on PATH
```

Step 2, the Keychain: in the app every secret lives in the macOS Keychain (service
`com.makapark.maka`), owned by the shell. The sidecar never reads the Keychain: it asks
the shell's credential broker, a Unix socket plus a token that exist for the session
only, through the same `keys.js` that reads environment variables and, without the app,
the 0600 keystore file. A key you give at the Gate or at first run goes straight into the
Keychain; the status bar says which store is in use.

Step 3, first run: the first time the park opens (also `npm start` on a fresh
`MAKA_HOME`) a card walks you through the workspace root (the LaCie external drive when
it is mounted, else `~/Maka/workspace`; the sidecar restarts itself when it changes), the
judge key (checked with Anthropic before it is stored), the worker (Ollama detected or
not, with a Start button and the install hint; one model sized to half the machine's
memory offered as a pull with real progress) and the mission for the Chief, who is
already at the Peak. Done or Later closes it; `POST /api/setup/reset` brings it back.

Step 4, Ollama management: the Peak card shows the local worker as it is: Ollama found
or not (with the install hint and a Start button), each pulled model with its size, an
estimated resident footprint and the headroom against half the machine's memory, a
Remove button, and one recommended pull with real progress. Without a reachable worker a
run is refused with `OLLAMA_UNREACHABLE` and the message says what to do; nothing falls
back to a paid provider unless `policy.json` says so.

Step 5, offsite backup: set `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` (or the keystore / Keychain names) and a bucket (`backup.bucket`
in `config.json` or `R2_BUCKET`), then Enable on the Peak: every night at the time you
set, the Peak's files, the mail store, the Rangers' outboxes and the ledgers are tarred,
encrypted with a key Maka makes once and shows once (write it down; it lives in the
Keychain), and put in the bucket under `maka/<your-mac>/`. Back up now, Verify latest
and Restore latest (into a fresh `workspace/_restore/<time>/`, never over live data) are
on the same card. Run transcripts, browser profiles and secrets are never uploaded.

Step 6, the release: `node scripts/release-bump.mjs 0.2.0` sets the version and tags;
`npm run release` (on the Mac, from the tagged checkout, with the six signing variables
in the environment) runs the gates, bundles the official Node binary (verified against
nodejs.org), builds and signs the app with the Developer ID, notarizes and staples the
`.app` and the `.dmg`, signs the updater artifact, and assembles `dist/site/`: the
version-free download page from `website/`, `releases/latest.json` for the app's
updater and `releases/download.json` for the page. `npm run release:dry` prints the exact
command sequence and writes it to `dist/release/plan.sh` without building anything.

Step 7, the gates and the runbook: the release refuses to start off the tag or on a
dirty tree, runs `test:fast`, the demo and the shell check first, launches the built app
once with a fresh home and checks it from the outside (`scripts/release-smoke.mjs`), and
`docs/RELEASE_RUNBOOK.md` has every Mac command: one-time setup, bump, build, the
clean-account launch, publishing, the updater, rollback. All seven steps of
`docs/PHASE3_BRIEF.md` are in this build; the Mac-only parts (the build, signing,
notarization, the Keychain, Gatekeeper) are scripted and documented here, verified on
the owner's Mac.

## Phase 4 so far: beyond StarNet

Step 1, the owner channels: `sidecar/channels/` holds the adapter contract and the
registry. Click the Peak for "owner channels": make a pairing code (single use, ten
minutes) and send it to the bot from your chat; from then on that chat gets every
Entrance Gate item as a card with Approve / Revise / Reject (Revise asks for your notes
as the next message), hears reflections and away digests, can `/gate`, `/status`,
`/away`, `/back`, and anything else you write is a question the Chief Ranger answers from
the recorded data (a bounded run with no tools, counted as judge spend). An unpaired chat
can do nothing but pair, and every attempt is logged. Bot tokens come from
`TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`, or
from "Connect" at the Peak through the Gate into the keystore. Step 2, Telegram: set `TELEGRAM_BOT_TOKEN`
(a bot from @BotFather) or Connect at the Peak; the sidecar long-polls the Bot API, so no
public endpoint is needed. Step 3, Discord and Slack: `DISCORD_BOT_TOKEN` (the bot's DMs only, over the gateway)
and `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (Socket Mode); both need no public endpoint,
both pair the same way, and the Peak lists every channel with its paired chats. Place a
Radio tower at the Peak (BUILD) and its lamps show which channels are up.

Step 4, MCP: at the Peak, "Add a stdio server" (a command such as `npx -y
@modelcontextprotocol/server-filesystem ~/Maka/workspace`, a secret environment variable
goes to the keystore) or "Add an HTTP server" (a URL; a server that asks for a sign-in gets
one through the Gate, OAuth 2.1 + PKCE). Each is approved at the Gate before it starts;
its tools show with their clipped descriptions and a leash domain each (read-only tools
are research, the rest outbound messages, editable; a money domain needs the amount
field). In BUILD, place an Outpost in a camp and pick the server: its Rangers get those
tools under the leash. Nothing MCP reaches the Chief.

Step 5, the catalog: the Peak's "Catalog" lists seven vetted servers (Filesystem, GitHub,
Google Drive, Notion, Slack workspace tools, Postgres read-only, Brave Search) with their
source, what they need and the leash domain proposed per tool; "Add" asks for the params
and secrets and parks the filled server at the Gate.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
