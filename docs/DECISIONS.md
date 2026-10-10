# Decisions

Choices made where the kickoff brief was ambiguous or silent. Each entry says what was
decided, why, and what it would take to change it. Newest at the bottom.

## D1. ES modules everywhere

`package.json` sets `"type": "module"`. The frontend has no build step and must import the
event contract from `shared/`, so the same files have to load as ES modules in both Node and
the browser. CommonJS would have forced a duplicate copy of `shared/`.

## D2. Persistence root is `.maka/` under the working directory

Overridable with `MAKA_HOME`. Keeps a dev checkout self-contained and is already in
`.gitignore`. The Tauri phase can point `MAKA_HOME` at the OS app-data directory.

## D3. One run at a time

The brief excludes concurrent crews from phase 1. `/api/run` answers `409` while a run is
active. The run manager is written so a later phase can lift this to a per-agent lock.

## D4. Budget counts reconciled spend only

The loop adds a turn's cost to `spentUsd` only when the provider reported usage and the
model has a known price. An unpriced model therefore runs until `maxTurns`, and its cost
events carry `usd: null, reconciled: false`. Guessing a price would violate truthful
telemetry; `maxTurns` is the hard stop in that case.

## D5. Cancellation is a normal end, not an error

A cancel at any point (before the first call, mid-stream, between tool calls) ends the run
with `agent.run.end { reason: 'cancelled' }`. Partial streamed text stays in the transcript.
`agent.run.error` is reserved for provider or harness failures.

## D6. Malformed tool input still gets a tool_result

If the model's tool input is not a JSON object, the tool is not executed; the call is
answered with an error result ("tool input was not valid JSON") so the model can retry
and the call/result pairing invariant holds.

## D7. Raw `fetch`, not the official SDKs

The brief requires zero runtime dependencies in the sidecar, so both providers are small
hand-written HTTP adapters over the documented streaming endpoints. The surface they use
is deliberately minimal (one POST, SSE parsing, tool blocks). If the dependency rule is
ever relaxed, swapping in `@anthropic-ai/sdk` is confined to `providers/anthropic.js`.

## D8. Default Anthropic model is `claude-opus-5-5`; `thinking` is left to the model default

Opus 5.5 runs adaptive thinking by default and rejects explicit disable/budget settings,
so the adapter sends no `thinking` parameter. Thinking blocks come back with empty text and
a signature; they are stored verbatim in the transcript and replayed, as the API requires.

## D9. OpenRouter cost is taken from the provider, not a local table

OpenRouter returns `usage.cost` for each request when asked. That number is the
provider's own figure, so the adapter forwards it and the loop marks the turn reconciled.
The OpenRouter default model (`anthropic/claude-sonnet-4.5`) is a placeholder that was not
verified against the live catalog in this environment; the UI lets the user set the model.

## D10. A `refusal` stop reason ends the run as `completed`

The run-end reason enum is frozen at four values. A safety refusal from the provider is an
HTTP 200 with no tool calls, so the loop ends the run normally with whatever text came
back. The stop reason is not surfaced as a distinct state in phase 1.

## D11. Permission prompts are per-call confirmation for side-effecting tools

The brief lists `permission.prompt` / `permission.response` without saying what triggers
them. Placement is the grant (layout is the org); the prompt is a second, per-call check
for tools that change the world. In phase 1 only `fs.write` has `confirm: true`. `fs.read`
and `web.fetch` run without a prompt once granted. A prompt with no answer is a denial.

## D12. Workshop object kinds: bookshelf, workbench, window

One kind per tool so the grant is legible on the canvas: bookshelf → `fs.read`,
workbench → `fs.write`, window → `web.fetch`. The mapping is data in `shared/world.js`;
sprites are theme data in the frontend.

## D13. `web.fetch` allows any http(s) host

Maka is local-first and the user is the only principal, so there is no SSRF boundary to
defend in phase 1. Non-http schemes are refused, the method is GET only, and responses are
capped and timed out.

## D14. The run record is the event list

`runs/<runId>.json` stores the run's metadata, every event with its `seq`, and the final
messages array. There is no separate transcript format: what the UI showed is what is on
disk. Token events are flushed on a short debounce; everything else flushes immediately.

## D15. The sidecar binds to 127.0.0.1 and has no authentication

Phase 1 is a local tool for one user. `HOST` can widen the bind, but nothing on the API
is protected, so it should not be. Auth is a prerequisite for channels (not phase 1).

## D16. World theme is a national park (superseded the workshop default)

Applied from step 6b on. Zones are `rooms` and fixtures are `objects` on the wire; those
names are frozen in the event contract and the layout schema, so only copy, default data
and the theme file change. The default zone is the Ranger Station and the default agent is
the Ranger. See the table in `docs/KICKOFF_BRIEF.md`.

## 2026-10-10 — owner scoping decisions
- Platform: macOS app, local-first, Tauri 2 shell over the Node sidecar. Apple Silicon first.
- Theme: NATIONAL PARK. User = Superintendent, agents = Rangers, zones/trails/fixtures as in
  docs/KICKOFF_BRIEF.md. Theme data stays swappable.
- Mission: autonomous operation of online businesses. Revenue and spend shown only from real
  connected sources; no projections; no income promises in copy.
- Autonomy: per-domain leash levels (Observe / Draft for review / Act with cap / Act freely),
  earned loosening, hard daily cap on money out, away mode with a full evidence log.
- First vertical (assumed, to confirm): e-commerce store ops with Shopify + Stripe.
- Models: local open-weight WORKER models via Ollama / OpenAI-compatible endpoints run the
  routine turns 24/7 at no marginal cost; Claude (Anthropic API) is the JUDGE for planning,
  result review before the Gate, ambiguity, and money/outbound actions. Routing is explicit
  per step and every turn records model and cost.
- Distribution: direct-download signed + notarized .dmg, not the App Store. Node sidecar in
  a Tauri 2 shell stays the settled stack; native Swift only for macOS integration points.
- Scope: every online business (ads, Etsy/Shopify, dropshipping, digital products, marketing,
  autonomous opportunity discovery). Phase 2 Ranger roles: Scout, Storefront, Ads, Marketing,
  Support, Books. Product laws 7-9 (platform compliance, originality, money-out through the
  Gate) added.

## D17. A fixture can grant more than one tool

The brief maps "Supply cache" to the filesystem as a whole, so `OBJECT_KINDS[kind].grants`
became an array (`['fs.read', 'fs.write']`). Only fixtures whose tools exist are listed;
phase 2 connector fixtures are documented in CODE_MAP.md and not shown in the palette.

## D18. Local (Ollama) turns are reconciled at $0

There is no bill for local inference, so $0 is a fact, not an estimate. The cost event is
therefore `reconciled: true, usd: 0` and the spend readout counts the turn. Token counts
still come from the server's usage report.

## D19. The default route is the local worker, and a missing local server is a plain error

`defaultPolicy()` sends routine turns to `ollama`. If Ollama is not running, `/api/run`
answers `400 OLLAMA_UNREACHABLE` before any event is emitted; the UI shows the provider as
not reachable. Nothing falls back silently to a paid provider. An explicit `provider` in
the run request bypasses the router (and then carries no tier).

## D20. The review hook answers tool calls instead of rewriting output

`runLoop({ review })` is the phase 2 judge's hook point. A revise/reject verdict does not
alter the worker's message; every tool call of that turn gets an error tool result carrying
the verdict and notes, so the worker sees the judgement as its next turn, matching the
brief's "the judge never silently rewrites a worker's output". Phase 1 passes no hook.

## D21. `policy.json` and `leash.json` are operator files with no UI

Both live in `MAKA_HOME`, are validated at boot, and fall back to defaults with a logged
warning when invalid. Editing them from the park is phase 2 (the Lookout Tower and the
Entrance Gate settings).
- Hierarchy: Superintendent (owner) → Chief Ranger (lead agent, judge-tier, owns the
  portfolio, decides and delegates) → Rangers → Junior Rangers (one level only). Humans
  approve only Gate items: cap raises, money-out above leash, new accounts/logins,
  irreversible deletes, legal/identity, Chief Ranger escalations.
- Live park UI: everything clickable and live (Ranger, zone, fixture, trail, Tower, Gate,
  Visitor Center); animation states driven only by real events; sidecar owns layout state.
- Assets: CC0/CC-BY only, recorded in NOTICE.md. Verified: Kenney Tiny Town, Kenney
  Roguelike/RPG pack, Shade Puny Characters, inkBubi forest sample.

## D22. "Waiting on you" is a frontend-derived state

The Ranger shows a raised-hand badge while a `permission.prompt` for its run has no
`permission.response`. No new event was needed: both events already exist and the state is
a pure function of them, so the UI still asserts nothing the harness did not emit.

## D23. The COMMS default is "route by policy"

Sending no provider lets the sidecar's router pick the worker tier, so the normal path is
the local model and the tier is recorded on every turn. Choosing a provider explicitly is
still possible (for the judge, or when Ollama is down) and then carries no tier, which the
transcript says.

## D24. The browser check is a script, not a test

The page was driven end to end in headless Chromium over the DevTools protocol against a
test sidecar. That script depends on a browser binary and is kept outside the repo for
now; `test:fast` covers the reducer under Node and the sidecar over real HTTP.
- Visual direction: 3D stylized low-poly national park rendered with Three.js (MIT),
  vendored as a pinned ES-module build; the one approved third-party frontend library
  (rendering library, no build step; sidecar still dependency-free). WebGPU when available,
  else WebGL2. Seeded procedural terrain, real-clock sun, orbit/fly/follow cameras,
  raycast picking. Assets: Kenney Nature Kit, Survival Kit, Animated Characters 1 and 3
  (all CC0, GLTF); Quaternius Ultimate Platformer Pack (CC0, glTF) as fallback rig.
  The 2D pixel-art plan and its assets list are superseded.

## D25. Vendored art is verified, not trusted

`scripts/fetch-assets.mjs` pins each archive's URL and SHA-256, extracts only the sheets
the renderer draws, and writes a manifest with per-file hashes; `test/assets.test.js`
checks the vendored files against it on every run. Packs that are pinned but not drawn
extract nothing. A hash mismatch refuses to extract rather than "updating" the pin.

## D26. The 2D pixel-art park is superseded by a 3D direction

Relayed on 2026-10-10 after the 2D park was working end to end: the owner wants a 3D park.
Work stopped on a hold; the 2D slice is committed as WIP. What carries over regardless of
renderer: the event contract, the frontend reducer and SSE client, the inspector's data
model, and the rule that every visual state maps to a real event. Awaiting the new spec.
- Mountain Peak replaces the Lookout Tower as the control centre: Chief Ranger's post,
  all channels report back, scheduled judge-tier reflection cycle with grounded briefings.
- Departments as zones: Sales, Marketing, Finance, Operations & Support, Research, Product &
  Listings. Ventures are trailheads.
- Mail: Maka-owned domain + provider API for mailbox/alias creation; sidecar runs the mail
  system (sync, threading, classification, drafting, sends) under leashes.
- Browser: Chromium over CDP from the sidecar (core modules only), per-Ranger profiles,
  human handoff for login/2FA/captcha/payment, browser_control leash, traced.
- Hardware: 16 GB Apple Silicon Mac → one ~7-8B 4-bit worker model; workspace root on the
  LaCie external drive with an offline-pause state. Apple Developer account available.
- Leash domains add account_creation and browser_control.
- Mail stack: domain on Cloudflare (DNS via API token scoped Zone:DNS:Edit), Fastmail via
  JMAP for mailbox/alias creation, sync and sending. Cloudflare R2 as optional encrypted
  offsite backup only. Secret names: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, FASTMAIL_API_TOKEN.
- Domain: makapark.com (Cloudflare). Ranger mail is <role>-<venture>@makapark.com; the .dmg
  download page and update manifest are served from makapark.com in phase 3.
- Outbound bulk/transactional mail: Resend on makapark.com (verified), webhooks into the
  local mail store, automatic suppression on bounce/complaint. Fastmail stays for mailboxes,
  inbound and conversational replies. Secret name: RESEND_API_KEY.
- Every station has its own mailbox (peak@, rangers@, visitors@, sales@, marketing@, finance@,
  support@, research@, listings@, gate@ on makapark.com), zone-owned and shared by its Rangers;
  Ranger venture aliases route into the owning station mailbox.
model, and the rule that every visual state maps to a real event. The 3D spec arrived the
same day and the 2D canvas files were deleted as it asked.

## D27. WebGL2 build only; the WebGPU build is not vendored

Three.js's WebGPU renderer needs its separate 2.2 MB build and node-based (TSL) materials;
the park's custom water shader is GLSL. Phase 1 vendors the WebGL2 module build and runs on
it everywhere (the Tauri webview included). Switching to the WebGPU path later means
vendoring `three.webgpu.js`, choosing the import map at load time, and porting the water
material. The status line names the renderer in use so nothing is implied.

## D28. Kenney characters are FBX, loaded with FBXLoader

The animated character packs the brief names ship binary FBX plus separate animation FBX
files and no glTF. Rather than convert offline (which would vendor a file nobody can trace
to the pack), the page loads the FBX as published with Three's FBXLoader, which comes from
the same pinned tarball. Clip mapping: idle and run are real clips; "work" reuses idle with
the tool badge, and "error" freezes the idle clip with the error badge.

## D29. The park seed lives in the layout and only the sidecar changes it

`layout.seed` is persisted with the layout; `POST /api/layout/reroll` picks a new one and
emits `layout.seed`. Terrain, river, foliage and clearings are pure functions of the seed and
the rooms, so every client draws the same park and nothing about it is stored in the page.

## D30. LOD by distance is not implemented in phase 1

Foliage is instanced per model variant with Three's frustum culling; there is no distance
LOD yet. On SwiftShader in headless Chromium the scene renders at a few frames per second,
which is a software rasteriser, not a target. The 60 fps on M1 target is unverified here
and is listed as such in CODE_MAP.

## D31. `fs.write` has no leash domain in phase 1

The brief's final domain list is about actions with outside effect (messages, publishing,
money, deletion, accounts, browser). Writing inside the Ranger's own workspace is none of
those, so `TOOL_DOMAINS['fs.write']` is `null`, the permission prompt carries no `leash`
field, and the Gate card says so. The per-call confirmation stays (tools.js `confirm`).
A phase 2 connector that writes somewhere real gets a real domain.

## D32. The merge gate refuses unlisted suites

`test/run-fast.js` fails when a `test/*.test.js` exists that `fast.list` does not name, so
adding a suite without gating it is an error rather than a quiet gap. Everything in `test/`
is in the fast list today; there is no slow tier yet.

## D33. The workspace root defaults under the home directory and can go away

`MAKA_WORKSPACE`, else `workspaceRoot` in `$MAKA_HOME/config.json`, else
`~/Maka/workspace`. A watcher polls the root; when it is unreachable the sidecar emits
`workspace.offline`, stops the active run (as `cancelled`, there is no mid-call pause),
answers `503 WORKSPACE_OFFLINE` to new runs, and emits `workspace.online` when it returns.
The sidecar's own data (`MAKA_HOME`) stays where it was so the park and ledgers survive an
unplugged drive; agents never write outside the root.

## D34. The Mountain Peak is a clearing kind, not a room

The Peak is derived by the park model from the first zone's position, like the Entrance
Gate, so no layout record changes and the sidecar needs no new route. `ZONE_KINDS` carries
`mountain_peak` for the day a layout places it explicitly.
- 2026-10-10 owner: full control granted to build until ready. Defaults: judge cap 10 USD/day,
  money-out cap 0 USD/day until raised at the Gate; judge models claude-sonnet-5-5 (review)
  and claude-opus-5-5 (Chief planning/reflection), configurable. Phase 2 and 3 briefs in
  docs/PHASE2_BRIEF.md and docs/PHASE3_BRIEF.md.
- 2026-10-10 owner: Resend is the only mail provider (it receives and sends for
  makapark.com); Fastmail dropped. Addresses are Maka routing rules over Resend's domain
  receiving; inbound by polling the Receiving API, webhook optional via tunnel. The owner's
  Cloudflare token is account-scoped; secret name CLOUDFLARE_API_TOKEN (replaces
  CLOUDFLARE_API_TOKEN). Hugging Face Inference Providers added as an optional metered
  `hosted_worker` tier (HF_TOKEN).

## D35. Leash resolution is agent override → zone default → park default; caps ride the entry

Phase 2 step 1 adds optional `zones[roomId]` and `agents[agentId]` maps to the leash policy
(additive). The most specific layer that names the domain wins as a whole entry, caps
included, so a per-agent override at "Act with cap" must carry its own `dailyCapUsd`.
`dailyCapActions` was added next to `dailyCapUsd` so Act with cap means something for
domains with no money in them (outbound messages, publishing). A missing cap is no cap.

## D36. Ledger days are the sidecar machine's local calendar day

Daily caps are the Superintendent's day; the sidecar runs on their machine, so the local
date is their date. The ledger keys days as `YYYY-MM-DD` local time and keeps 400 days.

## D37. A Gate item waits without a timeout; the run ending expires it

Unlike the phase 1 per-call confirmation (five minutes, then denied), a draft-level action
costs nothing while it waits (no provider call is open) and the owner may be away for
hours. So `gate-queue.js` has no timeout by default; cancelling the run, a run error or a
sidecar restart expire the item and the tool call is answered as expired. A timeout can
be injected for tests or a future setting.

## D38. Research at "Act freely" is counted in the ledger but not logged as a Gate item

Every allowed action in a leash domain is counted per day in the ledger. Emitting a
`gate.item { allowed }` for every `fs.read` and `web.fetch` would drown the Gate in noise
while `agent.tool_call` already records each one, so the Gate event is emitted for allowed
actions outside the research domain only. Observe refusals are always logged, in any
domain.

## D39. Earned loosening is one level at a time and proposes, never applies

After `earn.approvals` (default 5) consecutive approvals of one Ranger in one domain, the
queue raises a kind `proposal` Gate item from the current level to the next looser one.
Only an approval of that item changes the leash, as an agent override written to
`leash.json`. A rejection of any action item, or of the proposal, resets the streak.

## D40. `leash.json` is both the operator file and the persisted live policy

Phase 1 read `leash.json` once at boot and never wrote it (D21). Now `PUT /api/leash` and
approved proposals write it atomically through the store, so a hand edit and an in-park
change land in the same file. Editing it by hand while the sidecar runs is still only
picked up at the next boot.

## D41. The judge reviews only what the leash lets a Ranger do alone, plus the closing answer

Draft-level actions already stop at the Gate for the Superintendent, Observe refuses, and
research is read-only, so a judge call there would be spend without a decision. The judge
is consulted for tool calls in a non-research domain at Act with cap / Act freely, and
once before every run ends. A turn mixing reviewed and unreviewed calls is reviewed whole.

## D42. A judge that cannot run falls back to the Gate, never to silence

At the daily USD or call caps, without an Anthropic key, or when the judge call fails, the
action is escalated to the Gate as Draft for review (the gate reads `ctx.review.escalate`)
and a `judge.verdict { verdict: 'skipped', reason }` is emitted; the closing answer is
then not reviewed and the run ends. A judge answer that is not a readable verdict is a
reject carrying the raw text, so the worker and the park both see what happened.

## D43. The judge's cost is a run cost

Each judge call emits `cost.estimate { tier: 'judge' }` on the run, the loop adds the
reconciled amount to the run's spend so the budget guard sees it, and the ledger keeps a
separate judge total per day for the cap. Nothing is counted twice: the ledger is not a
spend readout.

## D44. Step models: sonnet reviews, opus plans and reflects

`policy.stepModels` overrides the tier's model per step kind. The default policy puts
`plan` and `reflect` on `claude-opus-5-5` and leaves `review` on the judge tier's
`claude-sonnet-5-5`, per the owner's defaults. `reflect` is a new step kind for step 6.

## D45. An agent record is the layout's agent entry; the Chief lives in a `mountain_peak` room

The brief asks for persisted agent records with id, name, role, zone, parent, venture,
persona, model policy and leash overrides. The layout already held id, name, zone, tile,
role and parent and is the one thing the park, the grants and the org chart read, so the
record grew there (optional fields, additive) instead of in a second file that could
drift. Leash overrides stay in `leash.json` (D40) and are edited through the same API.
The Chief Ranger is a singleton created at boot in a room of kind `mountain_peak`;
`placement.js` draws that room as the Peak clearing it used to derive (D34), so nothing
moves in the park.

## D46. Crew tools are granted by role, not by a fixture

`crew.spawn_junior` has no fixture: a Ranger can always ask for a Junior, a Junior never
can. `ROLE_GRANTS` in `shared/world.js` is unioned with the fixture grants by the run
manager (`allGrantsFor`). The tool has no leash domain: it changes the org inside the
park, which is not outbound, money, deletion or an account; the registry's depth rule and
the role grants bound it. Step 4's `delegate` tool follows the same pattern.

## D47. A per-agent worker policy overrides the router's worker tier

`agent.policy.worker = { provider, model }` lets one Ranger run on a different local or
hosted model (a bigger one for the Scout, say). An explicit provider in the run request
still wins, and the judge tier is never per-agent: the Chief's planning model is a step
model (D44).

## D48. Several runs at once, one per Ranger, the rest queued (supersedes D3)

The phase 1 rule was one run at a time with `409 RUN_ACTIVE`. Phase 2 step 4 runs up to
`maxConcurrentRuns` (default 4, `config.json`) at once, never two for the same Ranger, and
accepts everything else as queued: `/api/run` answers 202 with `queued: true`, the run is
persisted as queued and `agent.run.queued` is emitted, and it starts in arrival order when
its Ranger is free and a slot is open. The provider and key are resolved before queueing
so a misconfiguration is still a 400 and nothing is emitted. A queued run cancelled before
it starts ends with `agent.run.end { cancelled }` and no other event.

## D49. Delegation does not block the delegator

`delegate` returns the work item id at once and the receiver's run is queued. A blocking
handoff would hold a slot while waiting for a run that might be behind it in the queue
(a deadlock at cap 1) and would spend nothing useful meanwhile. The result arrives as a
`work.done` event and through `work.check`; step 5's Chief listens for it. Deliverables
are whatever appeared or changed under the receiver's `outbox/` between the run's start
and end: the harness does not ask the model to name them, it looks.

## D50. Who may hand work to whom

The Chief delegates to any Ranger or Junior; a Ranger delegates to its own Juniors and to
other Rangers (a Marketing Ranger can hand listings to the Listings Ranger); a Junior
never delegates; nobody delegates to the Chief (the Chief is briefed by the Superintendent
and by reflections). The Superintendent may delegate to anyone through `POST /api/work`
(the item then starts at the Entrance Gate's zone id for the trail).

## D51. The Chief plans inside a real run, through tools, and is not judged

The plan could have been one model call parsed from prose. Running the Chief as an agent
with `plan.submit`, `crew.hire` and `delegate` instead means the plan is validated by the
gate against a schema (a bad plan is a tool error the Chief sees and fixes, not a silent
retry), every decision is an event in a transcript the Peak can show, the hires and
handoffs are the same calls any Ranger makes, and spend is the same `cost.estimate`. The
Chief already runs on the judge tier, so its runs skip the judge's review: a judge judging
the judge is spend without a decision. Its cost events are counted as judge spend in the
ledger, and the judge daily cap pauses the mission rather than silently skipping the Chief.

## D52. Follow-ups are bounded per mission

Each `work.done` for an item the Chief delegated starts one follow-up run. Without a bound
a flaky Ranger could keep the Chief planning all day, so `maxFollowUps` (20) pauses the
mission with the reason; a new mission or a manual re-brief resumes it. Follow-ups run
with a small budget and turn count because they decide, they do not research.

## D53. The reflection reads the ledgers; the model only interprets them

Every number in a reflection comes from `gather()`: runs and reconciled spend, work items
and deliverables, Gate decisions, judge spend. The model's per-venture counts are replaced
by the harness's own, ventures it invents are dropped, briefings for zones that do not
exist are dropped, and a morale note with no digit in it is replaced by a plain "no
grounded note". Revenue, orders and ad results read "unknown (no connector wired)" until
Part C syncs them. A reflection never changes the plan itself: it hands the Chief a
follow-up so the plan is revised through `plan.submit`, with the reflection as evidence.

## D54. Budget thresholds are per scope, once each, and only 100 % reflects

`budget.threshold` fires at 80 % and 100 % for each venture, the mission and the judge's
day, once per threshold (the crossed set is kept in memory and spend is re-seeded from
persisted runs at boot, so a restart cannot re-fire a day's alerts for the same spend).
Only a venture or mission crossing 100 % triggers a reflection; the judge's own cap does
not, because the reflection would be skipped at that cap anyway.

## D55. Scheduled jobs that were due while the sidecar was down run on the first tick

The scheduler persists each job's next run. A job whose next run is in the past at boot
runs on the first tick with reason `missed`, then reschedules from that run, so a Mac that
was asleep at 07:00 still gets its reflection, labelled as late.

## D56. The Visitor Center and trailheads are rooms; trails are hub and spoke

The park is a function of the layout, so everything the park must show is in the layout:
the Visitor Center is created at boot, a trailhead room (named by its venture) when the
Chief submits a plan. Trails run from the Ranger Station to every other clearing, plus
trailhead ↔ each camp whose Rangers serve that venture; a walk between two camps is two
legs through the station. A full mesh would be unreadable at six camps; the hub keeps every
zone two hops from any other and the trails legible.

## D57. On a handoff the receiver walks; on a delivery it walks there and back

A `work.handoff` names the sender's zone and the receiver's. The park has the receiver
walk the route from the sender's zone home, as if collecting the brief, and the walk takes
real time at `WALK_SPEED` from the event's timestamp. A `work.done` with files sends the
receiver out to the Visitor Center and back. A work item in transit is listed on the trail
card from the item's own status, not from the animation.

## D58. Pause is a record field, not a run state

`agent.paused` on the layout record means: no new run starts for this agent and its active
and queued runs are cancelled when the pause is set. It survives a restart, it is visible
to every client through `crew.agent`, and the body shows it. Resume clears the field; it
restarts nothing by itself.

## D59. The evidence log is append-only NDJSON next to the Peak's files

One JSON line per event, appended with an fsync, under `<root>/_peak/` on the workspace
drive (the owner's data, not the sidecar's home). A torn last line after a crash is
skipped when the log is read; nothing is rewritten. The digest counts decided Gate items
by their latest status (an item that went pending → approved counts once, as approved) and
takes "waiting" from the live queue at the moment of return, not from the log.

## D60. Away is a persisted flag with its own counters, not a filter on history

Away state lives in `away.json` with the start time and running counters, so a restart
while away stays away and the digest still covers the whole absence. The Gate queue stamps
`away: true` on action items through its `isAway` hook rather than by consulting the away
module, so the queue stays independent of it.

## D61. DNS values come from Resend's domain API; Maka adds only DMARC

Resend tells each account exactly which SPF, DKIM, MX and return-path records its domain
needs (selectors and hosts differ per region and account), so `dns.js` reads them from
`GET /domains/:id` and never carries a table of them. The one record Resend does not
provide is DMARC; Maka adds `v=DMARC1; p=none; rua=mailto:gate@<domain>` so reports reach
the Gate's mailbox and no mail is rejected while the setup is young. Tightening to
`quarantine` or `reject` is a later owner decision.

## D62. The DNS apply is always a Gate item, and the Superintendent is its agent

Writing DNS for the mail domain is a one-time owner decision with outside effect, so
`apply()` parks it in the Gate queue under `account_settings` with the diff as evidence,
whatever the leash says, and the agent id is `superintendent`. The plan diff removes
foreign MX records at a name Resend owns (mail must not be split between providers) and
leaves other TXT records at the same name alone (site verifications live there too).
Keys: `CLOUDFLARE_API_TOKEN` (the owner's account-scoped token) and `RESEND_API_KEY`,
from the environment or the 0600 keystore like the model keys.

## D63. Addresses are routing rules; the store is the thread of record

Resend receives for the whole domain, so an address exists when Maka decides to route it:
`mail-addresses.json` maps each address to a station (zone id), an optional Ranger and a
venture, and anything unknown goes to visitors@ tagged `triage`. The local store under the
workspace root is where threads, labels and classifications live; Resend holds the raw
copies for its retention window, Maka keeps its own forever. Threading uses In-Reply-To
and References against stored Message-IDs, nothing heuristic.

## D64. Inbound by polling after a persisted cursor; the webhook is an accelerator

The Mac at home has no public endpoint, so the baseline is a one-minute poll of Resend's
receiving list after the last stored id, oldest first, paging while `has_more`. The
`email.received` webhook, when a tunnel exists, stores the same message sooner; both
paths dedupe on the Resend id, so a webhook replay or a poll after a webhook stores
nothing twice. Delivery status without webhooks comes from polling recent sends'
`last_event`.

## D65. Unsubscribe is a working mailbox, not a web endpoint

Campaigns carry `List-Unsubscribe: <mailto:unsubscribe@<domain>>` with one-click
semantics and a plain footer; any mail to unsubscribe@ (or with a subject starting
"unsubscribe") suppresses the sender in `suppression.json`, as do permanent bounces and
complaints. Temporary bounces do not. Suppressed recipients are dropped from a send and
the copy is labelled `partial`; a send to only suppressed addresses is refused.

## D66. Ceilings are counted from the store's sent copies, per hour, and the owner is capped too

Hourly ceilings (per Ranger, per station, campaign recipients) are computed from the sent
copies in the local store over the last hour, so a restart cannot reset them and nothing
is counted that was not sent. The Superintendent has no per-sender ceiling but shares the
station's: the ceiling protects the domain's reputation, not the Ranger's.

## D67. "New external recipient" means never seen, and asks the judge even at Draft

An address off the mail domain that appears nowhere in the store (no mail from it, none
to it) is new. A send to one is the moment a Ranger could spam or phish on the park's
name, so the mail tool declares `judgeAtDraft` and the judge reviews it before the Gate
item is raised, in addition to the Superintendent's decision. Known addresses at Draft go
to the Gate without a judge call, as before.

## D68. A tool's leash domain may be a function of its input

`mail.send` is one tool whose domain depends on what it sends (reply vs campaign). The
gate accepts `tool.domain` as a function of the input and resolves the leash per call;
`leashFor(tool, input)` reports the same. Static domains are unchanged.

## D69. Mail is granted by the Radio tower, scoped by station, and the Chief sees all

The brief's fixture table makes the Radio tower the mail grant, so the five mail tools
are its `grants` and a camp without a tower has no mail. A Ranger's view is its station's
shared mailbox plus its own aliases; the Chief sees every station. The tower model is an
original Maka piece built from primitives because no vendored kit has one.

## D70. Classification is worker first, judge on doubt, and never guessed

The worker model classifies inbound mail with a confidence; under 0.6 or when its answer
is unreadable the judge decides (within the judge caps); when neither is reachable the
message stays `unclassified` and the event says `by: 'none'`. The worker's turn is a
known $0 on Ollama; a judge call is a priced `cost.estimate` and counts in the ledger.

## D71. The hosted worker is metered by calls, never priced by guess, and never a silent fallback

Hugging Face's router reports tokens but no price, so its cost events are unreconciled
and the ledger caps calls per day (`hostedWorkerCallsPerDay`, 2000). It runs only when
a policy step, an agent's own policy or an explicit request names it, or when the policy
opts into `fallback.worker: 'hosted_worker'` and Ollama is unreachable; the run then
records tier `hosted_worker` and the park shows it. D19 (no silent fallback to a paid
provider) stands: the fallback is a written opt-in and every turn says which tier ran.

## D72. The Field office grants the browser, and every browser action is browser_control

The kickoff fixture table has no browser fixture, so phase 2 adds one: the Field office.
Its seven tools are all `browser_control`, reads included: a real browser carrying the
Ranger's cookies is never plain research, and the leash for that domain decides whether
each step waits at the Gate. Uploads obey the same sandbox as `fs.*` (workspace files
only); downloads land in `downloads/` in the workspace.

## D73. One Chromium per Ranger, closed with the run, profile kept

A Ranger's browser launches on first use with its own profile under the workspace and is
killed when the run ends; the profile directory stays, so a login done at a handoff
survives into the next run without any cookie handling in Maka. Keeping a Chromium per
idle Ranger would eat the machine's memory for nothing (16 GB with a local model).

## D74. The handoff is detected from the page, parks the action, and is never re-raised for the same page

Detection is pure heuristics on what the page says about itself (fields, widgets, URL,
text); the tool call blocks until the Superintendent hands the page back or the run ends
(abandoned). A page handed back unchanged is not raised again in that session: the human
has seen it and chose to return it, and the Ranger gets the note. `browser.read` never
raises, so a Ranger can always look at where it is. The sandbox flag is passed only when
the sidecar runs as root (containers, CI); on the owner's Mac Chromium keeps its sandbox.

## D75. Connector credentials: the environment connects, the park asks the Gate

A platform key set in the environment (STRIPE_API_KEY, say) connects at boot without a
Gate item, exactly like the model providers' keys: the owner put it there. A key typed
in the park, an OAuth sign-in, and a disconnect are Entrance Gate items in
account_settings for the Superintendent, so the keystore changes only on an explicit
approval and the evidence log (D59) records it. The key itself never appears in the item,
only its last four characters.

## D76. One OAuth sign-in per approval, tokens as one keystore entry, refresh before use

Approving the connect item starts the PKCE flow and shows the authorize URL at the Peak;
the local callback on 127.0.0.1 (a fixed port, registered with the platform) exchanges the
code and stores `{ accessToken, refreshToken, expiresAt, scope }` as one JSON string under
the connector's keystore name. An expired token is refreshed before any call and the entry
rewritten; a token that cannot be refreshed asks for a new sign-in rather than failing
silently inside a sync.

## D77. Syncs are the only source of platform figures, and they keep their history

Each connected platform has a scheduler job (15 minutes by default) and a manual sync;
the sync writes what the platform answered into `connectors/<kind>.json` and emits the
counts. Disconnecting removes the credential and the job but keeps the synced data: it is
real history, and the park shows it as such ("not connected, last synced …").

## D78. Stripe reads come from the store; a refund is the one write and it carries its amount

The tools never call Stripe for a read: they answer from the last sync (with its time) and
`fresh: true` syncs first, so a Ranger's loop cannot hammer the API and the park and the
Ranger see the same numbers. `stripe.refund` is money_out; the gate asks the tool for the
amount with the tool context, so an unspecified amount is the charge's remaining amount
from the store, never 0, and the daily cap and the ledger see it. The refund carries a
`maka:<agent>` metadata tag at Stripe so the owner can see in the dashboard which Ranger
did it. Validation (unknown charge, over the remaining amount) runs when the tool runs,
after the Gate at Draft: the Gate sees every attempt, as it does for every other domain.

## D79. The Fee booth is the payments fixture

The kickoff fixture table says Park Store = commerce (Shopify / Stripe), Fee booth =
payments. Stripe is payments, so its tools hang on the Fee booth and the Park Store keeps
the storefront connectors (step 16); both also grant the framework's own `connector.*`
reads. A camp without the fixture has no Stripe tools, whatever the leash says.

## D80. Storefront writes are listings (publishing) and prices (money_in); there is no supplier purchase

The brief maps listing create / update to publishing, a price change to money_in and a
supplier or dropship order to money_out. Shopify's Admin API and Etsy's Open API create
and edit listings and prices but buy nothing from suppliers, so the first two mappings
are tools and the third is not: a tool that pretended to order from a supplier would be a
fake action, and Maka shows nothing it cannot do. A supplier connector, if one is ever
wired, is money_out from the start. A new Etsy listing is created as a draft and goes
live only through `etsy.update_listing` with `state: active`: two publishing decisions,
the second with the finished listing in front of the Superintendent.

## D81. One store, one Shopify shop and one Etsy shop, keyed by the owner's own apps

Shopify connects with a custom app's Admin API access token and the shop domain from
config (no public-app OAuth, which needs a hosted app URL Maka does not have). Etsy has
no token-only path, so it signs in through the framework's PKCE flow with the owner's app
keystring (`ETSY_CLIENT_ID`) and the registered local redirect on 127.0.0.1. Both tokens
live in the keystore like every other secret; the keystring is not a secret but lives
there too so the park never asks for it twice.

## D82. Connected platforms sync at boot

A connected connector whose local store is empty syncs as soon as the sidecar boots (and
then on its schedule). Without this the camps would show nothing for up to fifteen
minutes after every restart, and a Ranger's first read would be empty. Boot waits for
nothing: the syncs run in the background and `booted` settles when they are done.

## D83. The Notice board is the ads fixture, and ad money is the daily budget

The kickoff fixture table has no ads fixture; its Notice board (social / publishing) is
the Marketing camp's fixture, so it carries the ad tools too. The brief says budget
changes and new campaigns are money_out with the daily cap: the amount the Gate and the
ledger see is the daily budget (the new one for a change, the campaign's own for an
activation, 0 for a pause). A campaign is always created paused: spending starts only
with a separate activation the Superintendent sees as its own money_out item. Ad sets,
ad groups and creatives are not managed in this build; the connectors read results and
steer budgets, which is what the leash model is about.

## D84. Meta by token, Google by sign-in with the owner's own OAuth client

Meta's Marketing API works with a long-lived system-user or user token, so Meta Ads is an
api_key connector (`META_ACCESS_TOKEN`) with the ad account in config. Google Ads has no
token-only path: it signs in through the framework's flow with the owner's OAuth client
id and secret (a desktop client, so the secret is not secret in Google's own terms but
still lives only in the keystore), asks for offline access so a refresh token comes
back, and sends the developer token with every call. The secret travels both as HTTP
Basic and in the token request body because Google reads the body and others the header.

## D85. Search is research whichever way it runs, and says which way it ran

`web.search` uses the Brave Search API when `BRAVE_SEARCH_API_KEY` exists and the
Ranger's browser on DuckDuckGo's HTML results otherwise; both are read-only lookups of
public pages, so both are research. The browser path still runs through the browser
control (one trace line with a screenshot, handoffs honoured), and every result set
names its source so the Ranger and the Superintendent know an unkeyed search came from a
results page, not an API. With neither key nor browser the tool refuses and names what to
set rather than inventing results.

## D86. Trend signals come from official keyless APIs only

Google Trends has no official API, so it is not a source: scraping it would break
product law 7. Wikipedia's pageviews (Wikimedia REST) and Hacker News (Algolia's search
API) are official, public and keyless, and each answer carries the URL it came from so
it can be cited as evidence. A source that fails is reported as failed inside the answer;
only both failing fails the tool.

## D87. The brief is reviewed inside the tool and decided by the Chief

`brief.submit` has no leash domain: it writes to the Ranger's own outbox. Its review is
the judge's, called from the tool with the rendered brief (same model, caps, cost events
and `judge.verdict` as a turn review), and the verdict is written into the brief and told
to the Ranger with what to do (fix and resubmit, or stop). The brief recommends; the
Chief decides go / no-go within the mission budget when the work item finishes, which is
the Chief's follow-up turn. A judge at its cap or not wired is said so in the brief, and
the Chief reads it as unreviewed.

## D88. The shell is a host, not a second frontend

The Tauri window loads the park from the sidecar over loopback HTTP, exactly as a browser
does in development; the shell's own page is a splash that says "starting" or shows the
error. No Tauri command is exposed to the park (the capability grants `core:default`
only), so the frontend has one API to talk to, the sidecar's, and the sidecar stays the
only owner of state. What macOS needs natively (the menu bar item, the login item, the
Keychain, the updater) lives in Rust and talks to the same `/api/*` routes the park uses.

## D89. Node is bundled as a stock binary, not a single-executable build

The sidecar runs on the official Node binary for the target architecture, copied by the
release script into `src-tauri/binaries/node-<triple>` (Tauri's `externalBin`, verified
against nodejs.org's SHASUMS256.txt) and never committed. A single-executable build would
need the repo's ES modules bundled into one CommonJS blob and a re-signed Node; the stock
binary runs `sidecar/index.js` unchanged with `frontend/` and `shared/` beside it, so what
the app runs is what the tests ran.

## D90. The tray polls `/api/state` every five seconds

The menu bar item could subscribe to the SSE stream, but it shows two numbers (pending
Gate items, the Away flag) that change rarely, and a poll over loopback costs nothing
measurable. The poll also doubles as the liveness check: when the sidecar is not
answering the title says "offline" rather than keeping a stale count.

## D91. Closing the window hides it; Quit is in the menu bar

Maka is meant to run around the clock (the Rangers work while the owner is away), so the
red button hides the park and the process keeps going; the Dock icon and the tray's "Open
the park" bring it back. Quitting is an explicit tray action and stops the sidecar with
SIGTERM so it flushes its stores.

## D92. The updater is registered only when the build carries its config

`tauri.conf.json` has no updater block; `tauri.release.conf.json` adds the endpoint and
the public key at release time. The shell registers the updater plugin only when the
config it was built with names one, and a dev build's tray says "Updates: not configured
in this build" instead of pretending to check.

## D93. The sidecar gets a broker, not the Keychain

The brief says `credentials.rs` owns all secrets and hands the sidecar a session-scoped
handle. The handle is a Unix socket in a 0700 per-session directory and a random token,
both passed in the sidecar's environment; the sidecar asks `GET name` and gets the value
back for that one request. Alternatives weighed: injecting every secret as an environment
variable at launch (simple, but a key pasted at first run would need a sidecar restart,
and every secret would sit in the process environment for its whole life), or a Node
native module (forbidden: core modules only). The socket keeps `keys.js` core-only, lets
a key stored during the session be used at once, and keeps the Keychain behind one Rust
module. The protocol is one line per request with base64 values so a newline in a token
cannot break the framing, and the token is checked before any store access.

## D94. With a broker, the keystore file is not a fallback

When the shell configured a broker, `keys.js` never reads `keystore.json`: a broker that
refuses (bad token, locked Keychain) or is gone (the session ended) answers "no key" with
the reason in the sidecar's log and `/api/state.keystore.problem`. Falling back to a file
would make the app's behaviour depend on whether a dev file happened to exist in the
app-data directory, and would hide a Keychain problem behind a stale key. Without the
shell (development, tests) the file works exactly as before.

## D95. The Keychain's "list" is an index item

`SecItemCopyMatching` can enumerate generic passwords by service, but
`security-framework`'s simple password API is get / set / delete by (service, account).
Rather than widen the Rust surface, the store keeps one more item, `maka.index`, with
the names it holds, updated on every set and delete. The sidecar uses the list only for
diagnostics (which names exist), never for values, so a stale index costs nothing.

## D96. A changed workspace root restarts the sidecar in-process

Every module takes the workspace root at boot (runs, trails, the mail store, the browser
profiles, the evidence log), so moving it at runtime would mean threading a mutable root
through all of them. Instead the first-run flow writes `config.json` and asks the entry
point to close and boot again in the same process on the same port: the shell's
credential broker handle, the port and the environment survive, the page's SSE client
reconnects and re-reads the snapshot. A root pinned by `MAKA_WORKSPACE` is written but
not applied, and the answer says so, because the variable wins at boot.

## D97. The judge key is verified with a free request, and an invalid key is refused

Pasting a key is the one moment Maka can tell the owner it is wrong. `GET /v1/models`
(Anthropic) and `GET /api/v1/auth/key` (OpenRouter) cost nothing: 200 stores the key as
verified, 401 / 403 refuses it, and anything else (offline, a 5xx) stores it as "not
verified" with the reason, so a first run without network still completes and the Peak
says what happened. There is no "sign in" for Anthropic API keys; the card says so
instead of offering a button that would lead nowhere.

## D98. The worker model is sized by total memory, half of it

`os.freemem()` on macOS is small by design (the kernel keeps file caches) and would
recommend a toy model on a quiet 16 GB machine, so the recommendation uses total memory
with the kickoff brief's rule: half the machine for the model, the rest for the app, the
browser and the OS. Free memory is shown next to it as a diagnostic, never as the basis.
The candidates are tool-capable qwen2.5 sizes with approximate download sizes from
Ollama's library; the pull shows the exact bytes as they arrive.

## D99. The first-run card is a card, not a wizard

One scrolling card with four steps the Superintendent can take in any order, each
showing its live state (done is derived from what exists: a configured key, a pulled
model, a mission), with Done and Later at the bottom. A step-by-step wizard would hide
the park and block on steps the owner may want to skip (no key yet, Ollama later); the
card sits over the park and everything on it is also on the Peak card, so skipping
loses nothing.

## D100. Degrading honestly means the same refusal with a better message

Step 4 asks for a router that "degrades honestly when the worker is unavailable". D19
and D71 already decide the behaviour: no silent fallback to a paid provider, the hosted
worker only by a written opt-in. So step 4 changes no routing. It makes the refusal
useful: `OLLAMA_UNREACHABLE` and `NO_MODEL` name the Peak's Start and Pull buttons and
`ollama serve` / `ollama pull`, the Peak shows the worker line the sidecar computed
("ready: model", "no model pulled", "not reachable"), and the first-run card and the
Peak share one module so the two never disagree.

## D101. Memory headroom is an estimate and is labelled one

A model's resident footprint is not something the sidecar can measure before it runs
(Ollama loads lazily and the context size varies), so the Peak shows 1.3 × the file
size as "about … resident" with the factor printed, and the headroom against half the
machine's memory. Total and free memory are the OS's own figures. Nothing in the line is
a measurement dressed up as one.

## D102. The backup is a sealed tarball, not per-file objects

One snapshot = one object: a ustar tar of the files, gzipped, then AES-256-GCM with the
`MAKA1` header as associated data. Per-file objects would leak the file names and sizes
of the mail store and the deliverables to the bucket's listing, and would need hundreds
of signed requests a night; one sealed object leaks only its size, and the index beside
it (`latest.json`) carries the paths so a restore can be checked before it runs. The
snapshot stays under 512 MB; past that the run fails naming the file, rather than
quietly uploading a transcript archive.

## D103. The snapshot key is made once, shown once, kept in the Keychain

Enabling backups with no key makes 32 random bytes, stores them as `backupKey` through
`keys.js` (the Keychain in the app, the 0600 keystore in development) and returns the
hex once with the instruction to write it down. Deriving the key from a passphrase would
be weaker and would ask the owner to invent one; storing it in R2 next to the snapshot
would make the encryption decorative. A restore on another machine needs the key typed
in (`MAKA_BACKUP_KEY`), which is the point.

## D104. Restore goes into a fresh directory, and is not a Gate item

A restore writes under `workspace/_restore/<stamp>/` (or an empty directory the owner
names) and refuses a non-empty target, so it can never overwrite live data; moving files
into place is the owner's deliberate step. Because nothing it does is destructive or
outward-facing, it is not parked at the Gate: the Gate is for actions with outside
effect (D62), and the restore button is already the Superintendent's own click.

## D105. What a snapshot holds, and what it leaves out

In: `_peak/` (the evidence log and digests), `_mail/` (threads, messages, attachments,
suppression), every Ranger's `outbox/` (the deliverables), and the home's ledgers and
records (spend, leash ledger, leash, layout, Gate and work items, mission, plan, away,
mail addresses, scheduler state, setup, reflections, connector syncs). Out: run
transcripts (large, and the ledgers carry what the reflection and SPEND need), browser
profiles (cookies and sessions belong on the machine that was logged in), and the
keystore (secrets never leave the machine; the Keychain is the store in the app).

## D106. Tauri's bundler does the code signing; the scripts add the .dmg's ticket and the checks

The bundler already knows how to sign a bundle with the Developer ID (every Mach-O
inside, hardened runtime, the entitlements file), submit the `.app` to the notary
service, staple it, build the `.dmg` and sign the updater artifact, driven by the
documented `APPLE_*` and `TAURI_SIGNING_*` variables. Re-implementing that with
`codesign` by hand would only add places to get it wrong. What the scripts add is what
the bundler leaves out: a notary ticket stapled to the `.dmg` itself (Gatekeeper checks
the disk image too), `spctl` and `codesign --verify --deep --strict` as proof, and the
artifacts under stable release names.

## D107. A dry run prints the plan instead of pretending to run it

`--dry-run` makes the runner print and record every command and write `plan.sh`; the
manifests it writes say `dryRun: true` with placeholder hashes and no artifact is
invented. That is what the Linux test proves: the exact sequence, in order, with no
secret value in it. A dry run that produced a fake `.dmg` or a plausible signature would
be a lie the download page could end up serving.

## D108. The download page is version-free and reads a manifest

`website/index.html` never changes at release time; it reads `releases/download.json`
and renders what is there (version, date, the `.dmg` link, its size and SHA-256), says
"no release is published yet" when the file is missing, and labels a dry-run manifest.
Publishing a release is therefore uploading new files under `releases/`, nothing else,
and the updater's `latest.json` lives beside them on the same origin as the brief asks.
