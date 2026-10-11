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
   ├─ results     rollups per day from ledgers and syncs; unit economics; the Chief rules
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
8-character pairing code shown at the Peak (ten minutes, five wrong attempts revoke it)
from a private one-to-one chat with the bot (the adapter reports the chat type; a group,
channel or guild cannot pair, and a right code seen in one is revoked), and from then on
only the user who paired it may approve, revise or reject a Gate item (a button or a slash
command; Revise takes the notes from the next message), re-list the Gate, toggle away
mode or ask the Peak a question (another member of the chat is refused and logged with
the real sender id: safety 2026-10-11 H1), which is one tool-less run of the Chief on its planning
model over the recorded data, answered with the run id as evidence. Every pending Gate
item goes to every paired chat as a card, decided items tell the other chats who decided,
reflections and away digests go as text, and every send and every inbound message is an
event (`channel.delivery`, `channel.inbound`); an unpaired chat's attempt to act is
refused and logged. Bot tokens live in the keystore or the Keychain, reach the adapter's
`start()` only, and go in through the Gate like a connector key. Step 2 done: Telegram
(`sidecar/channels/telegram.js`), the Bot API over long polling with core `fetch` through
the outbound guard: Gate cards with inline Approve / Revise / Reject buttons, every press
answered, the offset kept so a restart replays nothing, the token verified with `getMe`
and never in an event or a message. Step 3 done: Discord (the
gateway over a guarded WebSocket with the DM intent only, button presses acknowledged,
REST for what Maka sends) and Slack (Socket Mode with the app-level token, the Web API
with the bot token, every envelope acknowledged, `mrkdwn` off), both reconnecting with
backoff, both registered at boot and shown on the Peak with their pairing state; a Radio
tower placed at the Peak carries one lamp per channel, lit only by what `channel.connect`
proved. That completes Part A of phase 4 (`docs/PHASE4_BRIEF.md`).

Part B step 4 done: MCP (`sidecar/mcp/`). The client speaks JSON-RPC to a spawned server
over stdio or to a remote one over streamable HTTP (through the outbound guard, so a
server on this machine is refused unless a test says otherwise); every tool it lists is
sanitised before the model or the gate sees it: names must be identifiers, descriptions
are clipped and cleaned, schemas rebuilt from the keywords Maka validates. The manager
keeps the servers the Superintendent configures at the Peak (each added, removed or
signed in through a Gate item; secret environment values in the keystore, never in the
config file), registers their tools as `mcp.<server>.<tool>` and maps each to a leash
domain: research when the server marks it read-only (and not destructive), outbound
messages otherwise, both overridable per tool, and a money domain only with an explicit
amount reading, so a money call whose amount cannot be read is unknown-amount and waits at
the Gate at every level (safety H2 holds for foreign tools too). The server's annotations
are the server's word, so the tool list a server shows on the connect right after its
approval is the accepted snapshot (fingerprints of name, annotations, description and
schema in `mcp-servers.json`); a tool that is new or changed on a later connect waits at
the Gate at every leash level under outbound_messages until a `mcp.accept_tools` item is
approved, and a rejected one is not granted until it changes again (safety 2026-10-11
M1). Tools reach Rangers only through an Outpost
placed in their zone for one server; an Outpost at the Peak is refused and grants nothing
(safety L5). HTTP servers that answer 401 sign in with OAuth 2.1 + PKCE after a Gate
approval (metadata discovery, dynamic client registration, the resource indicator).

Step 5 done: the curated catalog (`sidecar/mcp/catalog.json`), seven vetted servers with
what each needs and the leash domain Maka proposes per tool (reads research, writes
publishing, a new repository account creation, a file move data deletion, never a money
domain). One click at the Peak asks for the params and secrets, builds the `npx` command
or the hosted URL and parks it at the Gate like any server; a secret that must travel as an
argument (the Postgres URL) is filled from the keystore when the child starts and never
written to the config. Part B of phase 4 is done.

Part C step 6 done: the reflection's briefings reach the camps as mail. Each briefing is
internal mail from `peak@` to the camp's station address, stored straight into that
mailbox as received mail of kind `briefing` (no Resend send, no footer, no ceiling, no
classification: nothing leaves the machine), so the camp cards show it in their inbox
threads and a Ranger with a Radio tower reads it like any station mail; the notes file
stays the on-disk copy. Internal mail is refused for any recipient that is not a station
address of the park.

Step 7 done: the ad networks below the campaign. Meta: ad sets (targeting, a budget at set
level), ads and ad creatives (the Ranger's copy plus an image uploaded from its own
workspace, posted as the Superintendent's Page); Google: ad groups, responsive search ads
(checked against Google's copy limits before they leave) and image assets. Every create
is paused; activating an ad set, an ad or an ad group is money out with the real amount
(the set's budget, or the campaign's daily budget, from the store; nothing provable means
the Gate and a refusal after it, safety H2 as before); a budget change is money out with
the new figure; copy, creatives and images are publishing. Images come from the Ranger's
workspace only, through the same sandbox as fs.*.

Step 8 done: the creative kit (`sidecar/creative/`). Ad copy is written by the Ranger's own
worker and submitted through `creative.copy` with the product facts it relies on; the
platform's limits are checked first (Google's 30 / 90, Meta's 40 / 1000 / 125) and the
judge reviews every variant against those facts with its own question (not the brief's),
then the variants land as `copy.json` / `copy.md` under `outbox/creative/<venture>/<id>/`
with the verdict. Images come from a Hugging Face text-to-image model (`HF_TOKEN`, FLUX.1
schnell by default) through `creative.image`: the judge reads the prompt exactly as the
model will get it, with Maka's own "no people, no faces, no text, no logos" suffix and
negative prompt, and only an explicit approve lets the call go out; no judge, a judge at
its cap or any other verdict means no image. The call goes through the outbound guard, is
refused at the hosted worker's daily call cap and, when it succeeds, emits the same
unpriced `cost.estimate { tier: 'hosted_worker' }` as a hosted worker turn, so the ledger
counts it against the cap. The PNG and its `meta.json` (prompt, model, sha256, the
policy verdict and the fact that only the prompt was checked) are the deliverable; neither
tool has a leash domain because neither leaves the workspace: an upload is
`meta_ads.upload_image` / `google_ads.upload_image_asset`, publishing, at the Gate. The Peak
lists the newest copy and images with their verdicts.

Part D step 9 done: the results engine (`sidecar/results.js`). Per venture and per Ranger,
from real ledgers and connector syncs only: model spend by tier (every `cost.estimate` on
the bus by local day, agent and tier, seeded from stored runs at boot), revenue and orders
(Shopify and Etsy by order day; Stripe's paid charges only when no storefront is
connected), refunds and Stripe's own fees (the sync now expands the balance transaction),
ad spend by day (Meta's `time_increment=1` and Google's `segments.date` rows, kept across
syncs), external mail, work items and Gate decisions. A connector figure belongs to a
venture only through an object a Ranger of that venture created with a Maka tool, recorded
from the tool's own result (D139): the campaign, the product's variants, the listing, the
refund; everything else is park-level. Unit economics are contribution per order (revenue
less the known of refunds, fees and ad spend, the unknown named), model cost per order, and
payback as the first day recorded contribution covered recorded spend. A figure no source
holds is null and the Peak prints "no data", never 0; a synced source that shows nothing
that day is a known 0. Daily rollups persist in `results.json` and every rollup (after a
sync, a `work.done`, before a reflection, or "Roll up now") emits `results.rollup`. The
Chief rules are pure and deterministic (`proposeFor`): `no_data`, `kill` (a week of spend
with no orders past half the budget, or a fortnight at a loss past three quarters), `scale`
(orders, every component known, a positive net, payback reached), else `hold`, each with
the numbers that drove it; the reflection prints them to the Chief as RULE VERDICT lines
and a kill is executed by delegating the exact pauses (attributed campaigns still running,
attributed listings still live) as work items to the venture's own Ads and Storefront
Rangers, whose tools pass the Gate as usual (D140). The Peak draws the table and
hand-drawn SVG sparklines (`frontend/ui/sparkline.js`), no chart library.

Step 10 done: the Scout's memory (`sidecar/scout-memory.js`). Every venture brief a Scout
submits is recorded with what it declared (the niche, the channel, first-month estimates:
revenue, orders, ad spend, contribution per order; all optional fields added to the brief
schema) and the judge's verdict; the Chief records its go / no-go with the new Chief-only
tool `brief.decide`, naming the venture a go joins. A brief joined to a venture is scored
against that venture's recorded results from the results engine: each monthly estimate is
scaled to the days observed and scored by how far the figure landed from it, a go is
"held" when the venture's net is positive after 14 days and "missed" when negative, and
everything the engine does not hold stays unknown (a no-go that was never launched has no
outcome). The scored history, grouped by niche and by channel, is the "What we learned"
paragraph appended to every Scout's system prompt (`systemExtras` on the run manager) and
to the judge's review of the next brief (the brief tool's scope), asking for checkable
estimates and more evidence where past ones ran high; the Research camp card shows it
(D141).

Step 11 done: Ranger memory (`sidecar/memory/`). A memory item is a fact, a preference or
a procedure with a scope (the Ranger itself, its venture, its station), stored in
`memory.json`; a Ranger recalls its own items, its venture's and its camp's. A Ranger
proposes an item with `memory.write`: the text is redacted first (`redact.js`: provider
and platform key shapes, bot tokens, JWTs, bearer values, password assignments, emails,
phone and card numbers, IBANs, ids replaced by a bracketed label) and stored only when
the judge, asked whether it is durable, true, free of secrets and personal data and
specific, says approve; no judge, a judge at its cap or any other verdict stores nothing
and the Ranger is told why, including what was removed (D142). Recall is lexical
(`recall.js`: stems, idf, a little recency, a bounded 👍 bonus; no embeddings, no
dependency): `memory.recall` is a tool, and the top five matches for a run's brief go into
its system prompt automatically through the run manager's `systemExtras`, each recall an
event naming the items. The Superintendent votes 👍 / 👎 on the Ranger card (a net −1
mutes an item: listed, never recalled) and forgets items for good; Juniors recall and do
not write.

Step 12 done: recipes and skills (`sidecar/recipes/`). A recipe is a versioned playbook
document under `_peak/recipes/<id>/v<N>.json` (a goal, steps that are task briefs for a
specialty with a budget, the evidence to leave, the fixtures its Ranger's zone needs and
what it depends on, the leash levels it needs, a success check over the deliverables),
granted to a role or a Ranger, and run as work items along the trails in dependency order:
the plan first names what is missing (a parameter, a Ranger of the specialty in the named
venture (another venture's Ranger is never drafted in: its results and kills would land on
the wrong venture; safety 2026-10-11 M3), a fixture in the receiver's zone, a leash at
Observe) and notes where a step will wait at the Gate; every step's work item carries the
venture, and the results engine attributes what a run makes to its item's venture before
the Ranger's own;
each `work.done` delegates what it unblocked; a failed step or a failed check fails the
run. The Superintendent runs recipes from the Peak as itself; a Ranger or the Chief runs a
granted one with `recipe.run`, and its steps are the Chief's delegations under the mission
budget (D143). The starter library (`recipes/starter/`: the Etsy listing pipeline, a weekly
ad review, a support inbox sweep, a supplier reorder check, a monthly books close) is
copied in once. Skills are instruction packs in `_peak/skills/` attached to a Ranger by id;
their text and the recipes a Ranger may run open its system prompt, and both show on its
card.

Step 13 done: the listing pipeline end to end. The starter recipe `launch-etsy-listing`
drives the Listings Ranger from product facts to a live listing: a product data file,
listing copy through `creative.copy` (the Park Store now grants it; the judge checks every
claim against the facts), a product image through `creative.image` by the Ads Ranger (the
judge reads the prompt), a draft Etsy listing (publishing, at the Gate), the price
proposal (`etsy.set_price`, money in, a proven $0 at the Gate since a price moves no money)
and the activation (publishing, at the Gate). Nothing is live before the Superintendent's
third approval, and the results engine attributes the listing to the venture through the
Ranger's own write. `test/listing-pipeline.test.js` runs the whole chain against the fake
Etsy, the fake Hugging Face and a fake judge; the phase 4 demo (step 20) walks it.

Part E step 14 done: voice. In the park a "hold to talk" button records while held. Inside
the macOS app the shell recognises on the device (`src-tauri/src/voice.rs`: macOS Speech
through the objc2 bindings, an on-device `SFSpeechAudioBufferRecognitionRequest` fed by an
`AVAudioEngine` tap, exposed as Tauri commands the park page may call from the sidecar's
loopback origin); outside the app the browser records with MediaRecorder and the sidecar
relays the audio to Hugging Face's recogniser (`sidecar/voice.js`) with the bearer
`HF_TOKEN`, counted as a hosted call, kept nowhere. Either way the transcript is shown in an
editable box first and nothing acts on it until the Superintendent clicks "Ask the Peak"
(a tool-less Chief run through `POST /api/peak/ask`, the answer shown with its run id) or
"Use as the mission text" (into the Peak's form; Brief is still a click). One station voice
speaks through the shell's AVSpeechSynthesizer or the Web Speech API when switched on: Gate
items as they arrive, reflections, browser handoffs, finished recipes and the Peak's
answers, each a sentence built from the event alone (`frontend/ui/voice.js`). The sidecar
sees text only, the event carries a length and never the words (D145). What the Mac must
verify (the microphone and recognition permissions, on-device availability, the capability's
remote origin) is in the runbook; the Rust type-checks for Apple Silicon from here.

Part E step 15 done: the renderer. Foliage keeps its instancing and gains two levels by
distance: near the camera the kit mesh with shadows, farther the same items as a
vertex-clustered, flat-shaded copy without shadow, and nothing at all past the fog
(`frontend/park/lod.js`, pure and tested; `rebucketFoliage` in render.js moves the instance
matrices between the two InstancedMeshes when the camera has moved). Crew bodies stand where
they stand every frame; by distance their animation mixer runs every second or fourth frame
with the time added up, then the label, the badge and the shadow go. When the browser has
`navigator.gpu` and a real adapter answers, the park runs on Three.js's WebGPURenderer with
the WebGPU build imported on demand, the sky as SkyMesh and the water written in TSL; without
an adapter, or when only the WebGPU build's own WebGL2 backend would run, the proven
WebGLRenderer path runs and the status line says why ("webgl2 (no WebGPU adapter)"); a device
lost later restarts the park on WebGL2 with that reason (D146). A dev overlay (`?dev=1` or
the backtick key) shows measured time between frames and inside a frame, draw calls,
triangles and the LOD buckets, "no data" until there are frames. `npm run park:bench` opens
a dense park in headless Chromium once per configuration and prints the same statistics for
LOD on against LOD off, so the gain is a measurement (here, on a software rasteriser: ×1.21
between frames, 195 k against 348 k triangles). This Chromium cannot present WebGPU to a
canvas headless: `park-check --webgpu` verifies the path up to the first present and the
fallback after it; a WebGPU frame is on the Mac's list in the runbook.

Part E step 16 done: the Ledger desk and two more trend sources. A Ledger desk placed in a
camp grants `ledger.read` to the Rangers there, which is how the Books Ranger reads the
park's books: the results engine's own day rows for the park, a venture or a Ranger over the
last N days with their unit economics, the components no source holds named under `noData`
(null, never an estimate), which connectors are synced, the venture's budget and the Chief
rules' proposal, and today's leash ledger (`sidecar/ledger-desk.js`; a read, research, no
Gate item). The monthly books close recipe's second version needs the desk and reconciles
the connector reads against the engine's rows. `web.trends` now asks four sources: Wikipedia
and Hacker News as before, Reddit's public search listing under Reddit's rules (a
descriptive User-Agent, one request per lookup, requests spaced a second apart, a 429
reported and not retried) and Etsy's active listings for the keywords sorted by Etsy's own
score through the Open API with the app keystring (not wired without it; Etsy's API has no
separate trending list, and the row says so). Google Trends stays out (D86, D147).

Part E step 17 done: supplier purchasing through the browser. `purchase.request` (a Field
office tool, or the Superintendent's form at the Peak) names the venture, the supplier URL,
the items and the amount; it is money_out, so the leash and the Gate decide on it with the
amount on the card, and once allowed the amount is held in the leash ledger: a hold counts
against the money_out cap until the receipt or a cancel, across restarts and days
(`sidecar/leash-ledger.js`). The purchase becomes a work item for a Ranger in a Field office
(never the requester, never the Chief) whose browser drives the supplier's site up to the
cart. The cart, checkout and payment pages are the Superintendent's: a payment page is one
with card fields, one offering a one-click or saved-card order ("Buy now", "Confirm order",
"Buy with Shop Pay", "ending in 4242"), or any checkout / cart / order / payment URL by
itself (safety 2026-10-11 H3); it hands off as before, and on a purchase run the browser
refuses every click, type or upload on it, after the hand-back and whatever the notes say
(`PAYMENT_PAGE` in the trace), and refuses a click whose target or located element reads
like buy / confirm / submit / place order / pay / checkout wherever the page is
(`PURCHASE_CLICK`), so no order is ever placed by a Ranger, saved card or not. When the Superintendent has paid in the window and handed the page back with notes,
the Ranger reads the confirmation and files `purchase.receipt` with the order id and the
total as the page shows them; the receipt and the trace's screenshot go to the outbox (the
latest read or screenshot, which must be a page on the host the payment was handed off
on), the hold becomes money_out spend on that day at the amount the Superintendent stated
on the hand-back, else at the larger of the declared and the reported totals (safety
2026-10-11 M2: a Ranger reporting $1 on a $900 order reopens no cap room), and a
difference between the reported and the declared amount is written down. Reconciliation runs after every connector sync against
connectors that expose the owner's outgoing charges; none of the wired ones does, so a paid
purchase reads "no charge source" rather than a pretended match (D148). The Peak lists the
purchases and lets the Superintendent cancel an open one; `purchase.update` carries every
state change.

Part E step 18 done: computer control, macOS only, strictest defaults. A new leash domain
`computer_control` sits at Observe in every park until the Superintendent raises it at the
Gate: until then every `computer.*` tool is refused before the shell is even asked. The
Control desk fixture grants the seven tools (screenshot, locate by the accessibility tree,
click, type, key chords, app focus, the running apps) and never stands at the Peak. The
shell does the driving (`src-tauri/src/computer.rs`: NSWorkspace, AXUIElement, CGEvent,
CGDisplayCreateImage) and the sidecar reaches it over the credential broker's Unix socket
with one more op, `COMPUTER`, never over HTTP. Every action asks for the frontmost app
first: Maka itself, browsers (the web is driven through the browser tools, which carry the
outbound guard and the payment handoff), banking, password managers, System Settings,
Keychain Access and terminals always hand off to the Superintendent (`computer.handoff`),
who does the thing and hands back, and so does any app whose front window's title or URL
names a loopback host or the sidecar's own address (safety 2026-10-11 H2);
the Ranger's action is then refused, not retried, and the shell keeps the same list as its
own lock and never captures or types into such an app. Then a screenshot before, the
action, a screenshot after, a trace line with both paths and a `computer.action` event. The
first action of a run begins a session and the shell shows an always-on-top banner ("A Maka
Ranger is driving this Mac · ⌃⌥⌘H halts it") until the run ends; the hotkey halts in the
shell at once and tells the sidecar, which ends every session, abandons waiting handoffs
and refuses every action until the Superintendent resumes at the Peak. At Draft every
action waits at the Gate and asks the judge; at Act the judge reviews every action (it is
never research) and the day's action cap holds (D149). Linux tests cover the protocol and
the policy over a fake shell on the socket; the frameworks, the permissions dialogs, the
banner and the hotkey are on the Mac's list in the runbook.

Part E step 19 done: import from OpenClaw and Hermes homes. At the Peak the Superintendent
points at a home (the known ones on this machine are listed), previews what would come over
and imports it as one Ranger: SOUL.md becomes the persona, AGENTS.md and TOOLS.md a skill
("Imported instructions for …") saved but attached to nobody until the owner has read it
and enables it on the Ranger's card (never words in the persona the owner did not choose),
IDENTITY.md the name, MEMORY.md and the last daily logs
the memory, and the model named in `openclaw.json` or `config.yaml` the Ranger's worker when
it maps to a provider the park has (anthropic, openrouter, ollama; anything else is a
warning, not a guess). Keys are never transferred: `.env`, `auth.json`, credentials,
sessions and databases are never opened, the config is read for its model only, a symbolic
link is never followed (a SOUL.md pointing at a private key reads nothing and is listed as
skipped), the OpenClaw workspace stays inside the home whatever the config says, and the
preview shows the whole persona and the whole instructions (safety 2026-10-11 M4); every
text is redacted first and a memory line that carried a key or a token is dropped whole.
The owner's profile (USER.md) stays out of a Ranger's memory. Memory items are written
through the judge like any other (D142); without a judge they go to the Ranger's import
folder as a file, and the import's README says what was read, skipped, redacted and stored
(D150).

Part E step 20 done: the phase 4 demo and the closing of the books. `npm run demo:phase4`
(`scripts/demo-phase4.mjs`) boots one test sidecar with the fakes for research, Etsy,
Hugging Face images, Meta Ads and the Telegram Bot API and walks the chain, checking every
link from a recorded event, a fake's log or a file: the mission and the plan; the Scout's
brief judged with the memory's history in the judge's scope, recorded and decided by the
Chief (the memory then shows the brief joined to the plan's venture and "too early",
nothing projected); the listing pipeline recipe through its six steps to a live listing on
the fake Etsy with three Gate approvals; an Ads Ranger's ad set as money out at the Gate,
the card on the paired phone and the approval pressed through the fake Bot API, the set
created paused; the creative the same way; the results rollup with its known zeros named
for what they are and a hold verdict; the reflection's briefing mailed from the Peak to the
Marketing camp's station address. It is the second release gate beside the phase 2 demo
(D151). `docs/LIVE_TEST.md` carries the channel, MCP and voice steps for the real services,
and `CODE_MAP.md`'s "Not built yet" list is exactly what is left: Google Trends, a connector
that reports outgoing charges, an import beyond text, and the Mac-only verification of the
build, voice, a WebGPU frame and computer control.

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

Second safety review (`docs/SECURITY_REVIEW_2026-10-11.md`, the phase 4 surfaces, before
the first Mac build): the findings are being fixed in order, each with a regression test in
`test/safety-phase4.test.js` and its row's Status updated. H1 done: pairing binds the chat
and the user, only from a private chat (Telegram `chat.type`, Slack `channel_type`,
Discord's `guild_id` absent), and every Gate decision, note, command and question from a
paired chat must come from the user who paired it; anyone else is refused and the event
names the real sender (D152). H2 done: computer control never drives Maka's own window
(`com.makapark.maka` and the name are first on both sensitive lists), never a browser, and
never a window whose title or URL names 127.0.0.1, localhost or the sidecar's host:port;
the shell reads the front window through Accessibility and applies the same rule as its
own lock (D153). H3 done: a one-click or saved-payment checkout is a payment page by its
words alone, a checkout / cart / order / payment URL is one by itself, the page-side card
check knows express-checkout markup, and on a purchase run a click that reads like buy /
confirm / submit / pay / checkout is refused before it happens, by its target text or by
what the selector resolves to (D154). M1 done: MCP tools are accepted as a snapshot when
the server is approved; a later connect's new or changed tool holds itself at the Gate at
every leash level under outbound_messages until accepted, a rejected one is not a tool of
the park until it changes again, and read-only counts only without destructiveHint; a
tool may now hold itself at the Gate through `holdAtGate` (D155). M2 done: a payment
hand-back takes the amount the Superintendent paid, a purchase settles at it or else at
max(declared, reported), the receipt's evidence must be on the handoff's host, and a
payment hand-back counts for its own run only (D156). M3 done: a recipe step for a venture
goes only to that venture's Ranger of the specialty, work items carry their venture
(recipes, purchases and kill items name it), results attribute by the item's venture, and
a kill pauses an object through the Ranger that made it when the venture has no Ranger of
the specialty (D157).
M4 done: an import follows no symbolic link, keeps the workspace inside the home, previews
everything, and turns the home's instructions into a skill the owner enables rather than
persona (D158).
L1 done: the guarded fetch sends credential headers (the bearer, the cookie, the MCP
session id, api keys) to the host the request was made to and to no redirect hop on
another host.
L2 done: an HTTP MCP server's header values are keystore secrets by name, never plaintext in
`mcp-servers.json`.
L3 done: a stdio server's plain env is on its Gate card with the values, and the names that
redirect what a runtime loads (PATH, NODE_OPTIONS, DYLD_*, LD_* and kin) are refused.
L4 done: a hosted call (an image, a transcription, a hosted turn) is reserved against the
day's cap in one step before it is made, so concurrent calls at cap−1 let one through.
L5 done: the Chief's kill rule reads unknown orders as no data, never as zero.

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
Phase 4 is complete too: `npm run demo:phase4` proves its chain the same way
(`scripts/demo-phase4.mjs`, step 20 below), and what only the Mac can verify is listed under
"Not built yet" in `CODE_MAP.md` and in `docs/RELEASE_RUNBOOK.md`.

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
moves nothing. Phase 4 step 7 added the level below: ad sets, ads and creatives for Meta,
ad groups, responsive search ads and image assets for Google (see below).

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
