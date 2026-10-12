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

Superseded in phase 4 step 15 (D146): the WebGPU build is vendored and loaded on demand.

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

Superseded in phase 4 step 15 (D146): distance LOD for foliage and crew, measured by `park:bench`.

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
wired, is money_out from the start. Phase 4 step 17 (D148) adds the purchase through the
Ranger's browser, money_out from the request, the payment itself always the Superintendent's. A new Etsy listing is created as a draft and goes
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

## D109. The smoke launch is scripted; the clean-account launch is observed by hand

`release-smoke.mjs` runs the built bundle under the owner's own session with a fresh
`MAKA_HOME` and checks what a process can check: the shell announces the park, the
sidecar answers from the bundle with the contract, the first-run flag, the Keychain
broker, the vendored renderer, and a clean stop. A launch under a freshly created macOS
user cannot be scripted from another user's shell (the Keychain and the window server
need that user's GUI session), so the runbook makes it a manual step with the exact
commands and the exact things to observe, and a failed observation blocks the publish.

## D110. The runbook is tested for drift

A runbook that names a script that was renamed, or forgets a variable the scripts read,
is worse than none. `test/release.test.js` reads `docs/RELEASE_RUNBOOK.md` and fails
when a `scripts/release*.mjs`, a `SIGNING_ENV` variable, a gate command or the bundled
Node version is missing from it, so the document and the scripts move together.

## D111. Rangers reach the public internet only, decided after DNS (safety H1)

A Ranger's `web.fetch`, `web.read`, `browser.open` and `browser.download`, and every
page its browser lands on, are checked by one guard (`sidecar/netguard.js`): the name
must not mean "this machine" or "this network" (`localhost`, `*.local`, `*.internal`,
`*.home.arpa`, a bare name), and after resolution every address must be public: no
loopback, link-local, RFC 1918, CGNAT, unspecified, multicast or documentation range,
in any IPv6 disguise (mapped, NAT64, 6to4), and none of this machine's own interface
addresses on any port. Resolution happens before the request because a public name may
resolve to 127.0.0.1; redirects are followed by hand so a public page cannot bounce the
fetch onto the sidecar. A name that does not resolve is refused: nothing proves it is
public. The browser is checked after every action, not only at open, because a click on
a public page could land on Maka's own UI, which would fetch the frontend's token and
work the Gate. The guard has one switch, `allowLocal`, for the test server, the suites,
the demo and the park check, whose fakes listen on 127.0.0.1; the sidecar never sets it
and a tool whose context names no guard falls back to the strict one.

## D112. A money_out amount is proven or it is the Gate's (safety H2)

`budgetOf` answered 0 for a campaign with no campaign-level daily budget, and 0 passes
every cap: at Act with cap and a $0 cap the activation ran and spent the ad sets' real
budgets. Now a money_out tool's `amountUsd` is a proof or nothing: a finite number ≥ 0
is the amount (0 meaning "proven to move nothing", which is what pausing is), and null,
NaN, a negative, a throw or no `amountUsd` at all is "unknown". An unknown amount goes to
the Entrance Gate whatever the leash level, with no amount on the item and the reason
spelled out, because no cap can be checked against a number nobody has. Approved, the
action is counted in the ledger as an action and not as money, so the ledger never
carries an invented figure. The ad tools prove the amount from the store: the
campaign-level daily budget, else a lifetime budget in full (all of it can be spent),
else nothing, and `set_status` refuses to activate a campaign with no campaign-level
budget even after an approval, since the figure it would commit lives on ad sets the park
does not manage. The review's "unknown or zero" is met this way rather than by sending
every zero to the Gate: a pause is a reversible, spend-stopping action a Ranger must be
able to take at 3 a.m. with the owner away, and the zero it reports is proven, not
defaulted. money_in tools (price changes) keep no amount; the rule is about money leaving.

## D113. The cap is reserved before the action, in one synchronous step (safety M1)

The gate checked the cap, awaited the connector's HTTP call, then recorded the spend;
four Rangers checking a $50 cap in the same tick each saw $0 used and all four spent
$40. `ledger.reserve()` now checks and reserves in one synchronous step (Node runs one
tick at a time, so nothing interleaves between the check and the reservation), the
action runs holding its reservation, and success commits it as recorded spend while
failure, a throw or a Gate detour releases it. Reservations stay in memory: a crash
releases what was in flight, which is the right default because an action that never
answered may not have happened, and the next sync of the connector is the truth about
what did. Nothing is written to the day until an action succeeds, as before.

## D114. Money caps are inherited, never earned away, and keyed to their scope (safety M2)

Three gaps let a money cap vanish: an agent or zone entry `{ level: 'act_capped' }`
without a cap replaced the whole park entry and its cap; five approvals in a row could
propose Act freely in money_out, where no cap was checked; and an agent's own cap was
compared with the park-wide spend. Now `resolveLeash` takes the level from the winning
layer and the caps from the first layer, going outward, that names them (an entry that
sets its own cap keeps it); no streak proposal goes past Act with cap in money_out or
money_in, so a Ranger can earn its way to the cap and no further, and the hard cap
stays the Superintendent's to raise (product law 9); and a cap in a money domain is
reserved and enforced at Act freely as well, whether the level came from a proposal or
from the Superintendent's hand, because "act freely" was never meant to read "spend
freely". An agent-scoped cap (the agent's own leash entry names it) is checked against
that agent's own ledger rows; a zone or park cap against the park's total, the stricter
of the two readings for a shared cap. The ledger therefore records every action under
its agent as well as under its domain.

## D115. The run route is a whitelist (safety M3)

`POST /api/run` handed its whole JSON body to `runs.start()`, whose `review: false`,
`step`, `system` and `workItemId` options exist for the Chief's planning runs and the
trails. A request could switch the judge off for any Ranger. The route now copies the
six documented fields and nothing else; the internal options stay reachable only from
the sidecar's own modules. A whitelist rather than a blacklist, so the next internal
option is private by default.

## D116. A per-boot token, a same-origin Origin and JSON for every change (safety M4)

The sidecar listens on loopback, and loopback is not a trust boundary: any page open in
any browser on the machine could POST to it, a "simple" cross-origin form or text/plain
request needs no preflight, and the routes parsed JSON whatever the content type said.
Three checks now guard every non-GET `/api` request, in this order: the per-boot token
in `x-maka-token` (made at boot, handed out only in `GET /api/state`, which a foreign
origin cannot read because the sidecar sends no CORS headers; compared timing-safe), the
`Origin` header when a browser sends one (its host must be the request's `Host`), and
`application/json`. The token is per boot and never on disk, so a restart invalidates
it; the park page reads it again when its event stream reconnects and retries one 403
on its own. The shell's menu bar item keeps the token from its own `/api/state` poll.
The Resend webhook is the one exempt route: it comes from outside, carries no token and
is checked by its svix signature. Test fakes get the token from the app, as the page
does; nothing in the sidecar turns the checks off.

## D117. The mail kind is derived, and a first contact is a campaign (safety M5)

The kind of a message decided its leash domain, its hourly ceilings and whether the
unsubscribe footer went on, and the kind was whatever the sender declared: a
"notification" to 5,000 addresses went out under outbound_messages with no footer. One
policy function now decides the kind from facts the park holds: more than one recipient
is a campaign; one recipient answering a message the park has (an In-Reply-To that
matches a stored, non-draft Message-ID, or a thread with real mail in it) is a reply;
everything else is a campaign. A declared `campaign` is honoured because it only
tightens; a declared `reply` or `notification` is ignored. The review's rule is taken
literally, so a one-off first contact to a single address is a campaign too: publishing,
the footer, the campaign recipient ceiling, the Gate at the default leash. That is
stricter than calling it a "notification" and costs a transactional one-to-one message
an unsubscribe line it did not need; the alternative, trusting any word for "not a
campaign", is the hole the review found. The `notification` kind stays in the data model
for what was stored before and is not derived any more. The tool's `domain()` uses the
same function with a named draft loaded from the store's index (synchronously, which is
why the index now carries `inReplyTo`), so the Gate and the send agree; an unknown draft
is judged as a campaign and refused at send. A message names at most 50 recipients; a
larger audience is many messages, each under the ceilings.

## D118. A draft is not mail history (safety M6)

Drafts are stored outbound with `status: 'draft'`, and the policy read every outbound
record as an exchange: a Ranger could draft to a new address first and send to it
afterwards without the judge's "new external recipient" review. `isNewExternal`,
`sentLastHour`, `judgeAtDraft` and the known-thread check now ignore drafts. A draft is
the Ranger's own note; only mail that was received or sent is history.

## D119. The handoff check runs before an action too, and a payment page needs notes (safety L1)

The check ran after an action only, and a handed-back page was not raised again for
the same kind and URL, so a checkout page the Superintendent had returned let the next
"Place order" click run unchecked, and a page the Ranger reached through a read (no
check) or a page's own script was never checked at all. Every action but `open` (which
leaves the page) is now checked on the page it is about to act on and on the page it
lands on. A payment handoff is handed back only with notes, because "returned" alone
says nothing about whether the order may be placed; the notes are what the Ranger
continues on, and a payment page is not re-raised only when its last hand-back carried
them. Login, one-time-code and captcha pages keep the one-handoff rule: once handed
back, the same page is the Ranger's to act on, notes or not.

## D120. Refunds from the park are USD refunds (safety L2)

The ledger and the daily caps count USD, and a refund's amount was the charge's amount
whatever its currency, so a 100 EUR refund counted as $100 and a 10,000 JPY one as
$10,000 (or, converted the other way, far less than it was). Converting would need a
rate the park cannot prove at the moment of the action. A refund from the park is
therefore a USD charge's refund: another currency has no provable amount (the Gate),
and the tool refuses it even when approved, naming the currency and the dashboard as
the place to do it by hand. Stripe's own reads and the Finance card keep showing every
currency as the platform reports it.

## D121. A domain the tool cannot name is not "no domain" (safety L3)

A `domain()` that threw yielded null, and null is what domain-free tools like
`fs.write` return, so the call ran under the no-domain path with nothing but the
per-call confirmation. The gate now tells the two apart: a throw falls back to the
tool's entry in `TOOL_DOMAINS` (every leashed tool has one), and a tool with no entry
is refused `DOMAIN_UNKNOWN`. Refusing beats guessing a domain: a tool that cannot say
what it is about to do should not do it.

## D122. A delegated budget comes out of the delegator's own (safety L4)

`delegate` took any `budgetUsd`, so a Ranger with $1 could hand a Junior $50, and a
chain of delegations could multiply the mission budget. The pool a delegator draws on
is now explicit: the Superintendent has no bound (the owner is the principal); the
Chief draws on the mission budget less the budgets of the items it already delegated
for that mission (its own planning runs are judge-tier spend, counted separately, not
the task pool); a Ranger draws on its active run, the run's budget less what the run
has spent and less the items it delegated during the run. A larger ask is capped to
what is left and the item says so, since a smaller budget is still useful work; nothing
left is a refusal, and a delegator with no run or no mission has nothing to draw on and
is refused rather than guessed at. Per-agent budgets (`agent.budgetUsd`) stay what they
were, the reflection's threshold, and are not a second pool.

## D123. No connector fixture at the Mountain Peak (safety L5)

The Chief is unjudged by design (D51): a judge reviewing the judge is spend without a
decision. That holds only while the Chief has nothing to act on in a money domain. A
Park Store, Notice board or Fee booth placed at the Peak would have armed it with
money_in and money_out tools under its own leash and no review. The review offered
judging the Chief's money actions instead; refusing the fixtures is the smaller, surer
change: it keeps D51 whole and keeps money actions where Rangers, the judge and the
Gate stand. Placement and layout replacement refuse such a fixture at the Peak, and the
run manager withholds every tool a connector fixture would grant there (the generic
`connector.status` / `connector.sync` included: nothing a connector brings is the
Chief's), so a hand-edited `layout.json` changes nothing. The Chief reads the figures
through the Peak's cards and the reflection, as before.

## D124. Syncs of one connector queue; none is skipped

The review saw `npm run test:fast` fail once in three runs. The cause was not the
test: a connector write kicks off an `after-write` sync in the background, and a sync
requested while one was running answered `{ skipped: true }` with no counts, so a
manual sync that landed in that window (the test's, or a Sync now click in the park)
got a non-answer. Syncs of one kind now queue behind the running one and each caller
gets its own counts; a failing sync does not block the next. The scheduler's job and a
tool's after-write sync go through the same queue.
- 2026-10-11 owner: phase 4 "beyond StarNet" approved in full with full autonomy
  (docs/PHASE4_BRIEF.md): channels (Telegram, Discord, Slack) with owner pairing, MCP client
  and catalog, briefings into station mail, ad sets/creatives and creative generation,
  results engine, Scout and Ranger memory, recipes and skills, listing pipeline, voice,
  renderer LOD/WebGPU, Ledger Desk, supplier purchasing via browser with mandatory payment
  handoff, macOS computer control under a new computer_control leash defaulting to Observe,
  imports. Nothing may weaken a safety-review fix.

## D125. A chat acts only after pairing with a single-use code, and the code is strict

The phase 4 brief asks for an 8-character code shown at the Peak that the owner sends
from their chat. The stricter readings are taken: the code is made only by a click at the
Peak (a mutating route, so behind the per-boot token), lives ten minutes, pairs exactly
one chat and is spent by it, is replaced by the next code, and is revoked after five wrong
attempts from anyone, so a bot's public username cannot be brute-forced into the Gate.
An unpaired chat gets one "send the code" reminder an hour and nothing else; a button
press from it is refused, logged with the chat and user ids, and emitted as a
`channel.inbound { paired: false }` event. Unpairing is a click at the Peak; a disconnect
of the bot keeps the pairings (the token changes, the owner does not). The pairing state
is one atomic file (`channels.json`) and is part of the offsite backup.

## D126. Bot tokens are keys like any other, and the adapter sees them once

Tokens come from the environment or the keystore / Keychain through `keys.js`, go in
through a Gate item in `account_settings` like a connector key (D75), and are handed to
the adapter's `start()` only; they are never on a status row, in an event or in a log
line. The registry resolves them, so an adapter cannot read the keystore and a test can
hand a fake adapter a fake token.

## D127. "Ask the Peak" is a tool-less run of the Chief, counted as judge spend

A question from the phone could have been one model call outside the run manager. Running
it as a Chief run keeps the transcript, the cost events and the cap in the same places as
every other Chief decision (D51): the run uses the Chief's planning model, at most two
turns and $1, no judge review (as for every Chief run), and counts in the judge ledger so
the daily cap bounds it; at the cap the chat is told so and nothing runs. The run is
granted no tools at all (an internal `grants` option of `runs.start`, never reachable
from `/api/run`, safety M3): a chat message cannot plan, hire, delegate or spend, and
the answer is grounded in the data the prompt carries (mission, plan, the reflection's
gathered actuals, the crew) with the run id as the evidence link, since the park is
local and a chat cannot open it.

## D128. Channel messages are evidence while away

A Gate decision taken from the phone while away is exactly what the evidence log is for,
so `channel.inbound` joined the away log's event types. The decision itself is logged as
the `gate.item` it resolves, as before; the channel event says it came from a chat.

## D129. Telegram by long polling, plain text, every press answered

The Mac at home has no public endpoint (D64), so the Bot API is polled with a 25-second
long poll and the offset after the last handled update; a webhook would need a tunnel
for no gain. Messages go as plain text with no parse mode: a Ranger's summary or the
owner's notes can contain anything, and a Markdown parse error would turn a Gate card
into a failed delivery. Every inline button press is answered at once so the phone stops
spinning even when the registry refuses the press (unpaired, already decided). The token
rides in the Bot API's URL by that API's design; the adapter strips it from every error
it raises, and the registry never puts an error with a URL in an event.

## D130. Discord reads DMs only; Slack runs in Socket Mode; both reconnect, neither listens

Discord's gateway is identified with the DIRECT_MESSAGES intent and nothing else: the
owner's chat with the bot is a DM, no guild message is read, and the privileged message
content intent is not requested. Slack uses Socket Mode (an app-level token opens the
socket, the bot token signs the Web API) because the Mac at home has no public endpoint
(D64); the Events API over HTTP would need one. Both adapters open their sockets only
after the outbound guard passed the gateway URL (safety H1 holds for WebSockets too), both
acknowledge every press or envelope before the registry decides, and both reconnect with
backoff until stopped; a token that fails verification fails `start()` plainly. Cards
are plain text on every platform (Discord content, Slack `plain_text` blocks with
`mrkdwn` off) so a Ranger's words are never formatting or a mention.

## D131. The Peak tower's lamps show channel state and nothing else

A Radio tower is the mail fixture (D69); placed at the Peak it also carries one lamp per
registered channel, lit green by a `channel.connect { up }`, red by an error, dark when
not wired or down. The lamp is a reading of the registry's rows, not a signal of its own,
so nothing animates on a timer and a tower in a camp shows no lamps at all.

## D132. An MCP server is a Gate decision, its tools are sanitised, and only an Outpost grants them

Adding an MCP server starts a process on the owner's machine or opens a network path, so
it is a Gate item in `account_settings` like a connector key (D75), and so are its removal
and its sign-in; a plain connect / disconnect of an approved server is the owner's click.
Everything a server says about its tools is bounded before the model sees it: a name must
be a plain identifier, a description is clipped to 300 characters with control and
zero-width characters removed, a schema is rebuilt from the keywords Maka's validator
knows (so the gate validates every call's input), and the Superintendent sees those same
descriptions when placing the Outpost. The tools reach a Ranger only through an Outpost
placed in its zone for one named server (layout is permission), the Outpost is refused at
the Peak and grants the Chief nothing even in a hand-edited layout (D123 extended), and a
stopped or removed server's tools leave the registry at once.

## D133. MCP leash mapping: read-only is research, everything else is outbound, money needs a figure

A server's `readOnlyHint` is the one machine-readable statement of what a tool does, so a
tool that carries it is research and every other tool is `outbound_messages`, the
tightest default short of Observe that still lets a Ranger use a tool at Draft. The
Superintendent may move a tool to any domain; moving it to money_out or money_in needs an
explicit amount reading (which input field, usd or cents) or the mapping is refused,
because an unknown-amount money action is the Gate's at every level (D112) and a tool
that would always land there is better said so at configuration. A call whose configured
field cannot be read is unknown-amount all the same and waits at the Gate; nothing is
invented. Server-initiated requests (sampling, roots, elicitation) are declined: Maka's
models and files are not a server's to drive.

## D134. MCP secrets and tokens live in the keystore; stdio children get a built environment

A stdio server's secret variables (an API token for a GitHub server, say) are given once
when the server is added and stored under `mcp.<id>.<VAR>` through `keys.js` (the Keychain
in the app); the config file keeps the names only. The child gets exactly the variables
the config names plus PATH and HOME, never the sidecar's environment with every provider
key in it. OAuth tokens for HTTP servers are keystore entries too, with the token URL and
client id beside them so they refresh without a second discovery.

## D135. The catalog is data, proposes leashes but never money, and pins nothing by itself

The catalog is a JSON file of seven official servers (the MCP project's reference servers,
Notion's hosted server) with their source URL and licence, so a vetting is a line one can
check, not a claim. It proposes a leash domain per tool where the server's own hints are
missing or too loose (the reference servers carry no `readOnlyHint`, so their reads are
mapped to research by name; writes to publishing; a new repository to account_creation;
a file move to data_deletion) and never a money domain: a money mapping needs an amount
reading the owner decides (D133). Package versions default to `latest` because a pin the
catalog invented would be a version nobody here tested; the version is a parameter the
owner sets once a server has run. A secret that a server takes as an argument (the
Postgres URL) is written as `$SECRET:NAME` and filled from the keystore when the child
starts, so no secret value ever reaches `mcp-servers.json`. One click fills the config;
the Gate still approves it, like a server typed by hand.

## D136. A briefing is internal mail: stored into the station mailbox, never sent

The brief asks for briefings "sent to the department's station address from peak@ via the
mail system". Sending them through Resend would push an internal note out to the internet
and back (Resend receives for the domain) and store it twice. Instead the mail system has
one internal path: a message from a station address to station addresses is written
straight into each recipient's mailbox as received mail of kind `briefing`, with a
Message-ID on the domain and the reflection id in a header. Nothing leaves the machine,
so no footer, no ceiling, no leash and no classification apply, and none of the safety
fixes on outbound mail (M5, M6) are touched: the path refuses any recipient that is not a
station address of this park, including the system address and Ranger aliases, and
internal mail is not mail history for the policy. The notes file stays as the on-disk
copy the brief kept.

## D137. Below the campaign: what spends is money out, what shows is publishing, images come from the workspace

The brief maps creates to paused, activation and budget to money_out with the real
amount, copy to publishing. The amount of an activation is read from the store the way
D112 reads a campaign's: an ad set's own daily budget (or a lifetime budget in full), an
ad's set budget (an active ad spends its set's budget), a Google ad group's or ad's
campaign daily budget (the group has no budget of its own); nothing provable is the Gate
and a `NO_BUDGET` refusal after it. A Google ad group's creation is publishing, not money:
it is structure with a bid, it spends nothing paused, and the enabling that would spend
carries the figure. Pausing anything is a proven $0, as before; when the day's money_out
total already exceeds the cap even that $0 waits at the Gate, because the cap check is on
the day's total, not on the step. Creatives and image assets upload only files from the
Ranger's own workspace through the fs sandbox, PNG or JPEG under the platform's size, so
the images a Ranger publishes are ones it made or was given (product law 8), and a
responsive search ad is checked against Google's copy limits before any request leaves.
The Page a Meta creative posts as is the Superintendent's configuration, never a Ranger's
choice.

## D138. Creative: the worker writes, the judge reads the prompt, no judge means no image

The brief asks for copy variants by the worker with judge review and images with an
explicit no-faces / no-brand-logos check by the judge. Copy is therefore not a second
model call: the Ranger's own worker writes the variants and `creative.copy` is the
submission, like `brief.submit`, with the platform limits checked before the judge is
spent and the judge asked its own question (every claim against the product facts the
Ranger supplied) rather than the brief's. Copy without a judge still lands, marked
unreviewed, because the Gate reads it before any upload. Images are stricter: the judge
reviews the prompt exactly as the model receives it, with Maka's own policy suffix and
negative prompt appended, and only "approve" generates; no judge, a judge at its cap, a
failed call, or revise all refuse, because the brief calls the check explicit and a check
that did not happen cannot be explicit. The bytes themselves are not inspected (the judge
has no eyes here); `meta.json` records `policy.scope: 'prompt'` so nobody reads the verdict
as more than it is, and the upload still passes the Gate under publishing where the owner
sees the file. Metering follows the hosted worker: the call is refused at
`hostedWorkerCallsPerDay` and a success emits the same unpriced `cost.estimate` a hosted
turn does, counted by the run manager's one listener, so the cap is one number. Neither
tool has a leash domain: both write to the Ranger's outbox only, and the money and
publishing happen in the ads tools that already carry them. Only the Notice board grants
them: ad creative is the ads camp's work, and the listing pipeline (step 13) will grant
what it needs when it exists.

## D139. Results come from ledgers and syncs only; a venture owns a figure only through a Ranger's recorded write

The results engine reads what the park can prove: the cost events on the bus, the
connector stores the syncs wrote, the mail store, the trails and the Gate. Nothing is
projected and nothing is inferred: a figure no source holds is null and the Peak prints
"no data", never a zero that would read as "nothing happened"; a synced source that shows
nothing that day is a known 0. The hard case is attribution. No platform row says which
venture it belongs to, and guessing (the only venture in the plan, the camp a connector
sits in, a name in a campaign) would be a projection. So a connector figure belongs to a
venture only through an object a Ranger of that venture created with a Maka tool, recorded
by the engine from that tool's own result: the Meta or Google campaign (its daily spend),
the Shopify product's variants and the Etsy listing (the line items of orders that hold
them, so a venture's revenue excludes shipping and tax and the row says so), the Stripe
refund. Stripe charges are never attributed: nothing links a charge to a venture. The
park-level row carries everything, attributed or not. Revenue is the storefronts' order
totals when any storefront has synced, else Stripe's paid charges, never both (a Shopify
store paid through Stripe would count twice); Stripe's fee rides the charge row only when
the sync could expand the balance transaction, and Shopify's refund amounts are not synced,
each said in the row's notes. Ad spend by day comes from the platforms' own daily rows
(Meta `time_increment=1`, Google `segments.date`), kept across syncs so the window the
platform answers does not erase the history, because a 7-day total cannot be honestly
turned into days. Unit economics follow: contribution per order is computed from the known
components and names the unknown ones; payback is the first rolled-up day on which
recorded contribution covered recorded ad and model spend, a fact about the past, not a
date in the future.

## D140. The Chief rules are deterministic, a kill is pauses through the Gate, a scale is a proposal

The brief asks for scale / hold / kill proposals "with the numbers that drove them". A
model reading figures and deciding would make the numbers a suggestion; the rules are
therefore pure code with fixed thresholds (`RULES`): `no_data` when revenue and ad spend
are both unknown, `kill` after a week of spend with no order once half the venture budget
is gone or after a fortnight at a loss once three quarters is gone, `scale` only when
orders exist, every cost component is known, the net is positive and payback was reached,
`hold` otherwise, each verdict carrying its numbers. The reflection shows the Chief the
verdicts and asks it to answer them with numbers; it may disagree in its revisions. A
kill is executed, because waiting for the Chief to act on a loss is the loss continuing:
the engine lists the exact pauses (attributed campaigns still running, attributed
listings still live) and the reflection delegates them as work items to the venture's own
Ads and Storefront Rangers, so the pause runs as a tool call under the leash like any
other (a pause is a proven $0 money_out, a listing change is publishing) and waits at the
Gate under the park's defaults. Nothing is paused from the reflection directly, nothing
unattributed is touched, a venture with no kill item open gets one per Ranger and no
more while it is open, and a venture with nothing attributed gets a note. A scale is a
proposal only: a budget raise is money out and belongs to the Chief's plan and the Gate.

## D141. The Scout's memory scores declared estimates against recorded results, and only those

The brief asks for "a scored history (precision of the Scout's estimates, by niche and
channel)". A brief's revenue model is prose, so nothing in it can be scored honestly;
the venture brief therefore gains optional, checkable fields (the niche, the channel,
first-month estimates for revenue, orders, ad spend and contribution per order) and the
score is the distance between an estimate scaled to the days the venture has been
observed and the figure the results engine recorded (D139). Where the engine holds no
figure the estimate is unknown, not wrong; a brief no venture was launched from has no
outcome at all, because what did not happen cannot be measured. A recommendation is
judged only after 14 observed days and only from the venture's net: a go that pays is
"held", one that loses is "missed", and before that it is "too early". The Chief's
go / no-go is a tool call (`brief.decide`, Chief-only, no money) so it is recorded like
every other decision instead of read out of the Chief's prose, and it names the venture
the brief joins, which is what makes the join possible. The history reaches the next
Scout as plain lines in its system prompt and the judge as part of the question it is
asked about the next brief; neither gets a number the engine did not record, and when
nothing is recorded yet the paragraph says exactly that.

## D142. Memory is written only through redaction and the judge; recall is lexical and muted by a thumbs-down

The brief asks for memory items "proposed by the Ranger and accepted by the judge" with
"redaction of secrets and personal data before storage". Both are taken at their
strictest. Every proposed text and tag goes through pattern redaction before anything
else sees it, the judge included, so a key or an address a worker model pasted never
reaches the disk or a second model; the Ranger is told what was removed so it can
rephrase, and the record keeps the counts, never the values. The judge is then the one
accepting authority: without a judge key, at the judge's daily cap, after a failed call
or on any verdict but approve, nothing is stored and the refusal says why, because an
item "accepted by the judge" that no judge saw would be a memory the harness invented.
Recall is a plain lexical score over the items a Ranger may see (its own, its venture's,
its station's), with no embeddings: the sidecar stays dependency-free, the ranking is
explainable (the matched terms are returned), and the Superintendent's votes are the
only learning signal: a net thumbs-down mutes an item from every recall while leaving it
on the card, forget removes it. Juniors read their crew's memory and cannot write, since
a Junior's bounded subtask is not where durable knowledge should be minted.

## D143. A recipe plans before it runs, and its steps are the Superintendent's or the Chief's delegations

The brief asks for playbooks "granted to a role or a Ranger; run as a sequence of work
items along trails". Two things follow. First, a recipe is checked against the park before
anything moves: every step needs a Ranger of its specialty (the venture's own crew first),
the fixtures the step names in that Ranger's zone (layout is permission, so a recipe cannot
grant what the Superintendent did not place) and no needed leash at Observe; a missing
piece refuses the run and says what to place, hire or raise, and a leash stricter than the
recipe asks is a note, because waiting at the Gate is the leash doing its job. Second, who
delegates: the Superintendent's own runs are its delegations, unbounded as ever; a run a
Ranger or the Chief asked for through `recipe.run` is delegated by the Chief under the
mission budget, because a Ranger's budget lives in its active run (safety L4) and the
later steps run after that run has ended. A recipe therefore cannot multiply a Ranger's
budget, cannot reach past a camp's fixtures, and leaves every money or publishing action to
the tools' own leashes at the Gate; the recipe is sequence and briefs, not permission.
Juniors neither run recipes nor receive grants: their work is bounded by their Ranger.

## D144. Listing copy is the storefront's work; a price change is a proven $0

The listing pipeline needs copy from the Ranger that owns the listing, so the Park Store
grants `creative.copy` (the judge still reviews every claim against the product facts),
while `creative.image` stays with the Notice board: a product image is the Ads Ranger's
step, metered under the hosted cap, and the pipeline walks the trail to the Marketing camp
for it. The price proposal is `etsy.set_price` under money_in, as the brief says; the
Gate item carries a proven amount of 0 because a price moves no money, so the figure the
Superintendent sees is the summary ("set listing N's price to 25.00"), and the cap on
money_in counts an action, not a sum. The pipeline is a recipe and nothing more: every
platform write is the tool's own leash at the Gate, the listing is created as a draft and
activated only by a third, separate approval.

## D145. Voice: on-device in the app, a keyed relay outside it, a transcript confirmed before anything acts, no words in the record

The brief asks for push-to-talk through the shell with macOS Speech, the browser's
recorder with Hugging Face as the fallback, one station voice, "the sidecar only sees
text", and transcripts shown before they are sent. In the app the shell recognises on the
device and refuses to listen when the locale cannot be recognised on-device, so no audio
ever leaves the Mac from the app; the shell is reached through its own Tauri commands
(the capability allows the sidecar's loopback origin to call them and nothing else), not
through the sidecar. Outside the app the sidecar is the only place with the Hugging Face
key, so it relays the browser's recording to the recogniser; "sees text only" is kept in
the strict sense that nothing of the audio is written, logged or held past the request,
the relay is one guarded request counted as a hosted call under the same daily cap as an
image, and without `HF_TOKEN` the button says not wired rather than recording for nothing.
The transcript is never acted on by itself: it appears in an editable box, "Ask the Peak"
runs the Chief's tool-less question route, "Use as the mission text" fills the form the
Superintendent still submits by hand, and the record of what happened is a `voice.transcript`
event carrying where the words were recognised, how many characters and what they were
used for, never the words, which are the Superintendent's own. The station voice says only
sentences built from events (a Gate item, a reflection, a handoff, a finished recipe, an
answer): nothing it says is a claim the harness did not prove. The frameworks are reached
from Rust through the objc2 bindings rather than Swift so that the code is type-checked for
Apple Silicon from this Linux environment; the microphone and the recogniser themselves are
on the Mac's list in the runbook.

## D146. WebGPU only with a real adapter, WebGL2 otherwise and after a lost device; LOD that is measured, not claimed

The brief asks for the WebGPU renderer path "when `navigator.gpu` exists" with WebGL2
fallback, distance LOD with instancing kept, a frame-time overlay in dev and a bench.
`navigator.gpu` existing is not WebGPU working: headless Chromium here exposes it on the
loopback page and answers `requestAdapter()` with null, and Three.js's WebGPURenderer would
then quietly run its own WebGL2 backend under the WebGPU name. The stricter reading is taken:
the adapter is asked for first (no adapter, no 2.3 MB download), the renderer must report
`isWebGPUBackend`, otherwise the plain WebGLRenderer with its proven GLSL runs and the
status line carries the reason in parentheses. A device lost later (a GPU reset, a browser
that cannot present WebGPU to a canvas) stops the frame loop and app.js restarts the park on
WebGL2 saying "webgl2 (WebGPU device lost)", instead of a frozen canvas. Three.js 0.186
writes the identity `swizzle: 'rgba'` into every texture view descriptor and a browser that
exposes the final spec's dictionary member throws on the string; render.js drops that one
identity field in its own `createView` wrapper rather than patching the vendored build, and
the wrapper goes with the next Three.js bump. The water is written twice, GLSL and TSL, with
the same waves, because a shader is the one place the two builds do not share code; the
TSL version lets the renderer apply the scene fog itself. LOD keeps the instancing: two
InstancedMeshes per kit mesh over the same items, the far one a vertex-clustered copy made
at build time from the kit's own positions (no third-party simplifier), flat shaded and
without shadow, and nothing drawn past the fog; the crew keeps one body each and only its
animation rate, label, badge and shadow change with distance, never its place. Thresholds are
constants in lod.js, chosen for a 240-unit park with fog ending at 320. Frame numbers are
measured and shown as such: the overlay says "no data" until frames exist, the bench always
runs LOD on against LOD off at the same density and prints both, and headless Chromium's
SwiftShader numbers are labelled relative. This Chromium cannot present WebGPU to a canvas
headless (the device is lost at the first `getCurrentTexture`, in the headless shell too), so
`park-check --webgpu` verifies the path up to the first present and the fallback after it,
and a WebGPU frame with draw calls is on the Mac's list in the runbook, as the voice is.

## D147. Reddit under its rules, Etsy's score as the trend it offers, the books read from the engine

The brief asks for "Reddit's public JSON listings under its rules and Etsy's own trending
endpoints where the API offers them", and a Ledger desk that grants `ledger.read` for Books.
Reddit's rules for its public JSON are a unique, descriptive User-Agent in the
platform:app:version (contact) form, a rate of about one unauthenticated request a second,
and no scraping of the HTML; the trends module keeps to one search request per lookup, sends
that User-Agent, spaces Reddit requests at least 1.1 s apart in the process, reports a 429 as
rate limited inside the answer and never retries in a loop. Etsy's Open API offers no
"trending" list; the closest thing it offers is its active listings for keywords sorted by
its own relevancy score, which needs the app keystring (`ETSY_CLIENT_ID`, already the Etsy
connector's) as an API key and no OAuth, so that is what the Etsy row is, labelled as such
("sortedBy"), and without the keystring the row says not wired rather than guessing. The
answer fails only when all four sources fail; each failed source names its error in its row
so the Scout cites what answered. The Ledger desk computes nothing: `ledger.read` returns
the results engine's rows and economics (the same function the Peak's table uses) and the
leash ledger's summary, with the components no source holds named under `noData`, because
the Books Ranger's persona forbids estimates and the tool should make the honest sentence
the easy one. It is a read, so it belongs to the research domain and may stand at the Peak,
unlike the connector fixtures (L5). The starter recipe for the monthly close is bumped to a
second version that needs the desk; the starter library copies in once, so an install that
already holds the first version keeps it, as the recipe design says (D143).

## D148. A purchase is money out from the request, held until the receipt, and never paid by a Ranger

The brief asks for a `purchase.request` work item that is money_out with the amount declared
and reserved, driven by the Ranger's browser up to the payment page which always hands off,
the receipt captured and the ledger reconciled against the connector's charge. Four choices
follow. The request is the leashed action: the tool proves its amount, so Observe refuses it,
Draft sends it to the Gate with the amount on the card, and Act with cap checks the cap; but
the request moves no money, so the gate records it at $0 (`settlesLater`) and the amount
becomes a hold in the leash ledger instead of a day's reservation, because the Superintendent
may pay hours or days later and a restart must not forget it; a hold counts against the
money_out cap until the receipt settles it at what was actually paid, on that day, or a
cancel or a run that ends without a receipt releases it. The payment page is the
Superintendent's in a stricter sense than the L1 rule: on a purchase run the browser refuses
every click, type and upload on a page the handoff check calls a payment page, before and
after the hand-back and whatever the notes say, so the only way money moves is the
Superintendent's own hands in the window; the Ranger's part ends at reading the
confirmation and filing the receipt, which the module accepts only from the Ranger driving
that purchase and only after a payment page was handed back with notes for its run. The
executor is never the requester (the one who asks is not the one who drives) and never the
Chief (unjudged, D51); the Superintendent's own request from the Peak needs no Gate, since it
is the approval, but holds the amount like any other. Reconciliation is honest about its
sources: a connector that holds the owner's outgoing charges exposes `outgoingCharges`, the
matcher takes one charge of the paid amount within a week and refuses to choose between
two, and since none of the wired connectors (Stripe, Shopify, Etsy, the ad networks) carries
the owner's card charges, a paid purchase reads "no charge source" with the receipt as the
record, rather than a match nothing proved.

## D149. Computer control: Observe until raised, the socket not a port, the shell's own locks, hand off rather than drive

The brief asks for computer control on macOS with the strictest defaults, over the existing
broker socket and never as raw HTTP, traced with screenshots, with a banner, a halt hotkey,
sensitive apps always handed off, judge review on every action at Act with cap, and no
autonomous use until the Superintendent raises the leash at the Gate. Read strictly: the
new domain starts at Observe in `defaultLeash`, so an existing park gets it at Observe on
upgrade and a Ranger's call is refused before the shell is asked; even a screenshot is a
computer_control action rather than research, because the screen shows whatever is on it.
The socket is the credential broker's, with one more op, because that socket already has
the per-session token, the 0700 directory and a one-request-per-connection discipline, and
a port would be reachable by anything on the machine. The shell checks the frontmost app
against the same sensitive list the sidecar holds and refuses before any capture or input,
so a sidecar bug or an out-of-date list on one side cannot drive a terminal or a password
manager; a sensitive app hands off rather than waits for a "returned with notes" and then
proceeds, because there is no note that makes typing into a bank acceptable: the
Superintendent does the thing, the Ranger's action is refused with the notes and a second
try in the same app is refused without a new handoff. The halt is two-sided for the same
reason: the hotkey halts in the shell before the sidecar hears of it, and the sidecar keeps
its own halted flag even if the shell forgot, until the Superintendent resumes. The judge
already reviews every non-research call the leash lets through at Act; the computer tools
also ask for it at Draft (`judgeAtDraft`), so a Gate card for a click arrives with the
judge's reading. The Control desk is refused at the Peak like the connector fixtures (L5):
the Chief is unjudged and never drives the Mac. What this environment cannot run (the
frameworks, the permission dialogs, the banner, the hotkey) is type-checked for Apple
Silicon from here and listed for the Mac in the runbook, as the voice is.

## D150. An import moves words, never keys, and nothing into memory that the judge did not accept

The brief asks for an import from OpenClaw and Hermes homes mapping persona, instructions,
memory and model to a Ranger, keys never transferred. The homes' own documentation names
the files: OpenClaw keeps config, credentials and sessions in `~/.openclaw/openclaw.json`
and a workspace with SOUL.md, AGENTS.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md and
daily logs under memory/ (docs.openclaw.ai, "agent workspace"); Hermes keeps config.yaml,
`.env` for secrets, `auth.json` for OAuth, SOUL.md and memories/MEMORY.md and USER.md
(hermes-agent.nousresearch.com, "configuration"). "Keys never transferred" is read as
never opened: the files that hold them are on a never-read list whatever the home, the
config is parsed for its model alone with nothing under a key-shaped name looked at, and
every text that is kept passes the memory redactor first; a memory line that carried a key
or a token is dropped whole, because no sentence about a secret is worth a Ranger
remembering. The owner's profile is personal data and stays out of memory (D142), so
USER.md is listed as skipped rather than imported. The model maps only to a provider the
park has, else the Ranger takes the park's default worker and the report says so; a Hermes
model id under an explicit provider is kept whole, because OpenRouter's carry a vendor
prefix. Memory items enter through `memory.write` and so through the judge; a park without
a judge gets them as a file in the Ranger's import folder, never in memory. The import is
the Superintendent's action at the Peak, so it needs no Gate, and `import.home` records it
as counts, never text.

## D151. The phase 4 demo is a release gate, and it proves the chain with the fakes the tests use

Step 20 asks for `scripts/demo-phase4.mjs` and for test:fast, park:check and release:dry
to stay green; it does not say whether the release should run the new demo. The stricter
reading is taken: `npm run demo:phase4` is gate 2b in `scripts/release.mjs`, beside the
phase 2 demo, so a release cannot ship with the brief, the listing pipeline, the ad set at
the Gate, the Telegram approval, the results rollup or the briefing mail broken. The demo
reuses the fakes under `test/helpers/` and nothing else: the same fake Etsy, Hugging Face,
Meta Ads, research endpoints and Bot API the suites use, so what it proves is what the
tests prove, chained. Two choices inside the demo follow the brief's rules rather than
convenience: the listing pipeline's own Gate items (publishing and a $0 price change) are
approved from the Peak so the chain moves, but the ad set's money out is left for the
phone, because that is the approval the brief names; and the results checks assert the
known zeros as known zeros (Etsy and Meta synced, no order, the set paused) and the hold
verdict's reason, never a figure the engine did not compute.

## D152. A channel pairs a user in a private chat, never a chat

The second safety review (`docs/SECURITY_REVIEW_2026-10-11.md`, H1) found pairing trusted
the chat: in a paired Telegram group or Slack channel any member could press Approve on a
money_out card, and the event named the owner. The brief says the code is sent "from the
owner's chat", which is read strictly as the owner's private chat with the bot and the
owner's own id. So pairing needs the adapter to say the chat is private (Telegram
`chat.type === 'private'`, Slack `channel_type === 'im'`, Discord a message with no
`guild_id`), a chat of unknown type cannot pair either (the adapter must say, not the
registry assume), and a right code seen anywhere else is revoked rather than spent,
because a code shown to a group is exposed. From then on the registry compares the sender
to the user who paired on every path (a press, a slash command, revise notes, a question):
anyone else is refused, the bot says only the paired user may act, and `channel.inbound`
carries the real sender with `paired: false`, since the sender is not paired even if the
chat is. A paired chat that later reports a non-private type is refused the same way.
Revise notes are bound to the chat and now, by the same check, to the user, so a bystander
cannot supply them. No event field was added: the existing `userId` was already meant to
be the sender and now always is. The Peak's unpair stays the only way to drop a pairing.

## D153. A Ranger never drives Maka, a browser, or a window on a loopback host

The second safety review (H2) found neither sensitive list named Maka: at Act with cap a
Ranger could focus Maka, locate "Approve" and click its own Gate items. Maka's bundle id
and name now lead both lists (`sidecar/computer/policy.js`, `src-tauri/src/computer_policy.rs`),
so the app in front being Maka hands off like a bank would, and a second action in it is
refused outright. Two wider choices were made with the review's fix. First, browsers are
sensitive to computer control always, not only on purchase runs: the web is reachable
through the browser tools, which carry the outbound guard (safety 2026-10-10 H1), the
payment-page handoff (L1, D148) and the purchase rules, and a browser driven by clicks and
keys would carry none of them, Maka's own park page included; the stricter reading costs a
Ranger nothing it cannot do the safe way. Second, the window rule is loopback-wide rather
than "the sidecar's host:port" alone: the shell reads the focused window's `AXTitle` and
`AXDocument` and both sides refuse a title or URL naming 127.x, localhost, ::1, 0.0.0.0, a
`.local` name, or one of the sidecar's own addresses (the shell learns its launch port,
the sidecar its own host and port), because any local web UI driven by clicks is a
privilege the leash model never granted. The window check is a handoff, not a plain
refusal, so the Superintendent sees the attempt the same way as any sensitive app. The
fake desktop in the tests moved from Safari to Notes as its ordinary app, and a test with
a shell that does not know Maka proves the sidecar's list alone stops it, as the shell's
own list alone would (host-tested in Rust).

## D154. A purchase run's browser stops at the cart, and a buy-shaped click never happens

The second safety review (H3) showed the payment handoff keyed on card fields and "pay
now / place order" words: a logged-in supplier with a saved card places the order on "Buy
now", "Confirm order" or "Buy with Shop Pay" with no card field shown, and a Ranger on a
purchase run could click it. Three rules were added, each stricter than the review asked
where there was a choice. A page offering a one-click or saved-payment order is a payment
page by its words alone (no "card" word needed), and so is any URL whose path has a
checkout, cart, basket, order, payment, purchase, billing or buy segment, whatever the page
says: a cart page is where a one-click order can be placed, so the Ranger's part of a
purchase now ends at "Add to cart" and the Superintendent takes the cart, the checkout and
the payment (the brief's "up to the payment page" is read as up to the first page where
money can move). The password-first rule from the earlier review is kept: a checkout page
asking for a password is a login handoff first, re-checked as a checkout before the next
action. On a purchase run a click is read before it happens, by its target text and, when
the page can locate it, by the element's own text, and refused when it reads like buy /
confirm / submit / complete / place order / pay / checkout / purchase or an express wallet,
wherever the page is; "confirm" and "submit" alone are refused too, a false refusal on a
purchase run costing a Ranger nothing the Superintendent cannot do in the window. Runs
that are not purchases keep their clicks (their own leash and judge apply) but still hand
off at every checkout URL, so no checkout proceeds unseen anywhere. The page-side card
check learned express-checkout markup, and the purchase brief tells the Ranger plainly
what the browser will refuse.

## D155. An MCP server's tools are accepted once, as a snapshot; its later word waits at the Gate

The second safety review (M1) noted that `readOnlyHint` is the server's own claim and put
a tool straight into research (act_free, unjudged), and that a `@latest` server re-lists
its tools on every connect with nothing asked. The brief's "descriptions shown to the
Superintendent at placement" is read as an acceptance: the list the server shows on the
connect right after the owner approved it (the first successful list: an HTTP server's sign-in may come between)
is what the owner approved, kept as fingerprints
of each tool's name, annotations, description and schema (as sanitised, so a cosmetic
re-encoding is no change). Every later connect is compared with it. The review proposed
that new or changed tools "default to outbound_messages / Draft until accepted"; Draft is
made unconditional rather than left to the leash, because an owner who raised
outbound_messages to Act freely for a Ranger did not thereby accept tools that did not
exist then: an unaccepted tool holds itself at the Gate at every level through a new
tool hook (`holdAtGate`), and its domain is outbound_messages whatever its hint or an old
override said. The acceptance is one Gate item per connect naming each tool with its
annotations; approving it records the fingerprints, rejecting it records them as refused,
and a refused tool is not registered or granted at all (stricter than Draft, and it
avoids a card on every reconnect) until it changes again, when it is asked about afresh.
A server stored before this decision has no snapshot, so all its tools are pending until
accepted once. Read-only counts only when the tool does not also call itself destructive.

## D156. A purchase settles at what the Superintendent paid, and a Ranger's figure never lowers it

The second safety review (M2) found the hold settled at the total the Ranger reported, so
a $900 order reported as $1 reopened $899 of cap room, and that the receipt's evidence was
whatever page the Ranger last read, anywhere. The amount paid is now the Superintendent's
to state: the payment hand-back takes it (the Peak's card asks for it, the route and the
browser control carry it, the `browser.handoff` event shows it), and the receipt settles
the hold at that figure, high or low, because the Superintendent saw the page. Without a
stated amount the hold settles at the larger of the declared and the reported totals,
following the review; the reported total is kept on the receipt and the `.md` says which
rule settled. The evidence must be the latest read or screenshot and a page on the host
the payment was handed off on; a page elsewhere, or none, is no receipt (the review asked
for the host; requiring a page at all is the stricter reading, since "none captured" was a
receipt with no proof). While writing the test it showed that the earlier rule "a returned
payment page is not re-raised" (L1) was keyed on the browser session, so a second purchase
by the same Ranger on the same supplier within one session would not have handed off at
the cart; the suppression now counts for the run the hand-back was given in only.

## D157. Work belongs to the venture it was done for, and a recipe never borrows another venture's Ranger

The second safety review (M3) found recipe steps falling back to any Ranger of the
specialty when the venture had none, while results attributed by the Ranger's own venture:
a recipe for venture B run by A's Ranger scored A with B's listing, and a kill of B never
paused it. Two things changed. A recipe step for a named venture now goes only to that
venture's Ranger of the specialty, and the plan says `NO_RANGER` with the venture to hire
into; the review's alternative, hiring into B as the Chief does, was not taken, because a
plan is a read and a hire is a Chief decision with a budget behind it, so the plan reports
and the owner or the Chief hires. Without a venture a recipe still takes any Ranger of the
specialty, since there is no venture to misattribute. Second, a work item carries the
venture it is for (recipes, purchases and the reflection's kill items name theirs; a
delegation with none takes the receiver's own), and the results engine attributes what a
run makes to its item's venture before the Ranger's, so a cross-venture delegation by the
Superintendent or the Chief still lands where it belongs. A kill plan then reaches objects
a venture has no Ranger of the specialty for through the Ranger that made them, who holds
the grants that made them; model spend stays per Ranger, as the brief asks, and rolls up
through the crew.

## D158. An import reads what the owner can see, and its instructions are a skill the owner turns on

The second safety review (M4) found three ways a home could put words or files into the
park the owner never read: `readText` followed symbolic links (a SOUL.md linked to a
private key would land in layout.json), the OpenClaw workspace could point anywhere, and
the Peak's preview showed 600 characters of a persona that also carried AGENTS.md, so a
hidden instruction rode into the system prompt. A symbolic link is now never followed
(the link itself is looked at with `lstat`, and an injected fs without `lstat` reads
nothing, the stricter reading), the workspace must sit inside the home or `workspace/` is
used with a warning, and the preview is the whole persona and the whole instructions.
The brief's "persona, instructions, memory and model mapped to a Ranger" is kept, but the
instructions map to a skill, not to the persona: a skill is a text the owner reads at the
Peak and enables on a card, so the hidden line is seen before it reaches a prompt, and the
import attaches it to nobody. The alternative, keeping the instructions in the persona
behind a full preview, was rejected because a preview is read once and a persona runs on
every turn; D150 stands for everything else.

## D159. A credential travels to the host it was given for, and to no other

The second safety review (L1) found `guardedFetch` re-sending the whole request, headers
included, on every redirect hop, so an MCP server or a Bot API host redirecting to another
host handed that host the bearer and the session id. Fetch's own behaviour on cross-origin
redirects (dropping Authorization) is the model, applied by name rather than by trust in
the runtime: a fixed list of credential headers is dropped for any hop whose host is not
the one the request was made to, and comes back for a hop that returns there. The list
rather than "drop everything but content negotiation" keeps a server's own non-secret
headers working across its redirects; the list is exported so a reviewer can read it.

## D160. An MCP header value is a secret until proven otherwise

The second safety review (L2) found `validateServerSpec` refusing only Authorization and
Cookie, so an `x-api-key` header sat in plaintext in `mcp-servers.json`, against D134. A
header on an MCP server is an API key in nearly every real case, and a rule that lists the
secret-looking names would always be one name short, so every header value must now be a
`$SECRET:NAME` naming a declared `secretEnv` entry, as a `$SECRET:` arg already does; the
value goes to the keystore on the add's approval and is filled in when the server
connects, and the Gate card shows the header name and the secret's name only. A plain
non-secret header, should one exist, costs the owner a keystore entry; the file stays clean.

## D161. A stdio server's environment is shown whole, and the loader knobs are not the owner's to set

The second safety review (L3) noted the Gate card for a stdio MCP server listed its env
names only, so a `PATH` or `NODE_OPTIONS` entry could send `npx` to another binary with
nothing visible. The review offered showing the values or refusing those names; both are
done. The card now shows every plain env entry with its value (secrets by name only, as
before), and a fixed list of names that change what a runtime loads before the server's
own code runs (PATH, NODE_OPTIONS, NODE_PATH, the npm config family, DYLD_*, LD_*, the
Python, Perl and Ruby load paths, BASH_ENV, HOME and a few more) is refused as an env
name and as a secret name, because a value shown on a card is not the whole truth when
it rewrites the loader: the sidecar passes its own PATH and HOME to the child and nothing
else of its environment, as D134 already had it.

## D162. The hosted cap is a reservation, like the money cap

The second safety review (L4) found the hosted-worker cap checked synchronously and
counted later, when the `cost.estimate` arrived, so N concurrent image or voice calls at
cap−1 all passed. The money cap had the same shape and the same fix in the earlier review
(M1, D-numbered there as reserve → execute → commit), so the ledger now reserves a hosted
call in one synchronous step (`reserveHosted`), the image tool and the voice relay take the
reservation before anything else and release it once the call has been counted or has
failed, and the run manager's check counts what is in flight. The count itself still comes
from the `cost.estimate` event, as before, so nothing is counted twice and a call that
failed before the event counts nothing; reservations live in memory, as the money ones do.

## D163. Unknown orders decide nothing

The second safety review (L5) found the kill rule reading `(w.orders || 0) === 0`, so a
window whose order count was unknown counted as zero orders and could kill a venture that
had sold. The results engine's own law (D139: absent data shows "no data", never zero) now
holds in the rule as well: a kill needs orders known to be zero, a scale needs a known
count, and unknown orders leave the verdict at hold with "orders unknown" in the reasons.

## D164. A question reads; only a reflection writes the day

The second safety review (L6) noted that every Peak question called `reflect.gather()`,
which rolls the day up (persists the rows, emits `results.rollup`) as a side effect, so
a chatty owner changed the ledger of days and fired events the park reacts to. The
gather now takes `rollup: false`: the same document from the same engine, computed in
memory, with nothing written and nothing emitted; the ask route and the owner channels use
it. A reflection keeps the rollup, because its document is the one the Peak's table must
match and the rows it writes are the record of that day.
- 2026-10-11 owner: the remaining work (Mac build, live tests, connectors) moves to a local
  Claude Code session on the owner's Mac; docs/MAC_HANDOFF.md is its brief and
  scripts/mac-bootstrap.sh prepares the machine with everything on the LaCie (APFS/HFS+
  required for the 0600 keystore).

## D165. The data home may sit inside a git checkout; the repo ignores it

The owner kept the LaCie ExFAT (`mac-bootstrap.sh --keep-exfat`), so `MAKA_HOME` is
`~/Maka/home` on the internal disk — and the owner's internal-disk clone of this repo is
`~/Maka` itself, which puts the keystore inside a checkout. `.gitignore` now ignores
`/home/` at the repo root so a stray `git add .` there can never stage the keystore or the
ledgers. The sidecar's own 0600 check still guards the file itself.

## D166. The park looks real: a pinned Poly Haven pack, tiled detail, foliage cards

The owner judged the Kenney-kit park a toy ("the 3d model is fake. it needs to be really
realistic"). Four things had to change, and each one cost a wrong turn worth recording.

**The assets.** Poly Haven's photoscanned trees are 0.5–1 GB of geometry each — a browser
park cannot load one, let alone four hundred — so only the small scans came in: Boulder 01
for rocks and Grass Medium 02 for ground cover, with Leafy Grass, Forest Leaves 04, Rock
Face, Sandy Gravel and Pine Bark as PBR textures, plus three.js's own water normal map.
All CC0/MIT, every file pinned by its own SHA-256 (`kind: 'files'` in
scripts/fetch-assets.mjs — Poly Haven serves loose files, with no archive to pin). The
vendored-asset bound rises 25 → 32 MB for this pack (25.06 MB used): still a guard against
bloat, deliberately spent on look. The Kenney kits stay for the built pieces and the crew.

**The ground: tiled detail times a macro colour, not a bake.** The first attempt baked a
2048² splat of the four layers over the whole 240-unit park. It is blurry at every camera
a person actually uses (one texture tile per nine world units) and no bake resolution
fixes that. What works is the standard pair: a small greyscale detail map — one layer's
diffuse divided by its own mean, so it carries light and shade and no colour — tiled every
two units, multiplied by a macro colour held on the terrain's vertices (`splatWeights`
blended into the layers' mean colours, in linear space, divided back out by the detail
map's own mean so the product lands on the real albedo). One stock material, so WebGL2 and
WebGPU draw the same ground. The terrain carries one vertex per world unit to hold it.

**The trees are cards, and they are ours.** A tree built as cones is a cone whatever its
texture. Each variant is now a bent, flared bark trunk under whorls of alpha-cutout
foliage cards (`surface.js foliageCard` draws the needle and leaf sprays as pixels), which
is how real-time forests have always been built: the silhouette is needles and gaps.
`alphaTest`, never transparency — no sorting, and three carries the same test into the
shadow pass, so the shadows are needle-shaped too. The geometry is original Maka work, so
there is nothing to attribute.

**The sky lights the scene, but not the sky mesh.** Prefiltering the Sky shader into a
PMREM floods every material to white: its radiance is real sky radiance, and the sun disk
runs into the thousands. The environment is a bounded gradient built from the same clock
sun's zenith, horizon and ground-bounce colours, rebuilt only when the sun moves a visible
step.

Cost, measured on the owner's Mac: 60 fps at 16.7 ms with 4.8 M triangles and 70 draw
calls, and the LOD gain the bench reports rose from ×1.4 to ×12.8, because there is now
something for it to cull. Two timing assumptions in `scripts/park-check.mjs` broke under
the heavier park and became condition polls, which is what they should always have been.

## D167. The park is navigable: a dock, a Jump to menu, and the keys written down

The owner: "i dont like the layout or the game sturcture. could be much btter and how do
u move wghere too? there should be a key map legend too and a jump to manu too."

Three faults, and the third explains the first two. **There was no way to learn the park.**
The only way to move was to drag the mouse, nothing said so, and nothing said where the
zones were — so the park read as a picture rather than a place, and no arrangement of
panels was going to fix that.

- **Moving.** `frontend/park/controls.js` is the keyboard as data: `KEY_MAP` (the legend),
  `MOVE_CODES`, and `movementFromKeys(pressed)` returning a camera-relative vector with
  diagonals normalised. render.js reads it every frame and walks both the camera and what
  it looks at, so WASD, the arrows and Q/E feel like walking the park rather than dragging
  a model. Keys are tracked down and up, never tapped; a blurred window clears them, or
  the view drifts off on its own; and `isTyping` means a brief never moves the camera.
- **Going somewhere.** `placesFor(model)` lists the landmarks, then the zones, then the
  crew; the Jump to menu (J) offers them and `park.focus(place)` eases the view over in
  about a second. P, G and H are the Peak, the Gate and home.
- **The legend.** The UI renders `KEY_MAP` itself (the `?` key), so the keys a person is
  shown are the keys render.js listens to: there is no second list to drift out of date.
- **The layout.** Panels docked into two rails — the work you are doing on the left, what
  the park is telling you on the right — instead of floating windows at fixed pixel
  coordinates that overlapped each other and covered the view. A nav bar carries where you
  are, Jump to, the camera modes and the keys. BUILD listed every tool a fixture grants,
  up to thirty identifiers each, which buried the fixtures; it now says "Park Store · 15
  tools" with the names one click away.

`scripts/park-check.mjs` proves all of it headlessly: a held key moves the camera, the
same key typed into a brief does not, and a jump lands on the Peak. Those assertions poll
for the camera to arrive rather than sleeping, because software GL draws about a frame a
second and every fixed timeout here was wrong at that rate.

## D168. Zones reach the page, keep their distance, and the Superintendent can move them

Found while making the park arrangeable: **the page never learned about a new zone.** It
knew only the zones the snapshot it booted with carried, so every camp the Chief hired
into was invisible — its Rangers stood on open grass with no clearing under them — until
somebody reloaded. `layout.room` (additive: created / moved / removed) fixes that, emitted
from one place, `layoutState.replace`, which diffs the zones it is given; every path that
changes one (the Chief hiring, a move, a hand-written layout) therefore reports itself.

Two more things fell out of it:

- **Zones keep a tile between them** (`roomsOverlap`, `overlappingPairs`, the gap
  `freeZoneRect` already left). Two clearings that touch merge into one shapeless opening
  and the org chart stops reading as an org chart. Only an overlap a change *introduces*
  is refused: a park saved before the rule existed may already hold one, and refusing the
  whole layout for it would freeze that park for good — no camp hired, nothing moved.
- **The Mountain Peak was placed on top of the Ranger Station.** `ensurePeak` put it
  north-west of the lowest corner and clamped at zero, which on the default layout is the
  station's own tiles. It was invisible because the park derives the Peak's world position
  from the first zone rather than from these tiles, but the layout said something false.
  It now takes a free rectangle like every other zone.

Moving: `moveRoom(layout, roomId, { x, y })` is pure and carries the zone's fixtures and
crew with it (a zone is a team, not an empty rectangle); `POST /api/layout/move` validates
through the same `replace`, so an overlap or an off-grid move is refused for the same
reason from anywhere. The page applies the very same `moveRoom` to its own copy rather
than restating the shift and drifting from it.

## D169. Tool names on the wire: the park keeps its dots, the API gets what it accepts

The first real call to Anthropic with tools came back `HTTP 400: tools.0.custom.name:
String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`. Every Maka tool is dotted —
`fs.write`, `plan.submit`, `mcp.files.read_file` — because the dot says which kit a tool
belongs to, and the leash, the Gate, the registry and every event key off that exact
name. OpenAI-shaped APIs refuse the dot as well, within 64 characters, so OpenRouter was
broken in the same way. **No run carrying tools had ever reached a real provider.** The
fakes under `test/helpers/` accept any name and the suite asserted the broken shape back
to itself, so 373 green tests said nothing about it.

The park keeps its names; the wire gets safe ones. `sidecar/providers/tool-names.js` maps
each way for one request (dots and anything else outside the set become underscores,
collisions take a numbered suffix, unknown names coming back pass through untouched so an
invented tool surfaces as "unknown tool" at the gate rather than silently becoming
another one). Both adapters use it, and in three places, not one: the tool list, the
`tool_use` blocks replayed from earlier turns (the API checks those names against the
same list), and the names coming back, which are mapped to Maka's before anything else
sees them.

`test/tool-names.test.js` checks the names actually put on the wire against the two APIs'
own patterns, which is the assertion that was missing: the old provider tests pinned
`name: 'fs.read'` as the expected request body and so encoded the bug.

## D170. The owner channel is iMessage, on the owner's own Mac

The owner: "i dont want to use telegaram. i want to use imessage for anything." Right for
this park — it is local and personal (no distribution, D-note on the handoff), and an
owner channel that needs a bot registered with a third party, a token that can leak, and
somebody else's servers holding every Gate card is the wrong shape for that.

`sidecar/channels/imessage.js` is an adapter like the others, so the registry still owns
pairing, authorisation and every event; only the transport changes:

- **sending** is `osascript` telling Messages to send over the iMessage service. Every
  argument goes through `execFile` as an array and every string through `osaQuote`, so a
  Ranger's words land inside one AppleScript literal and can never become script.
- **receiving** polls `~/Library/Messages/chat.db` read-only through the `sqlite3` macOS
  ships, for rows after the one that was newest when the adapter started — so a restart
  never replays the owner's message history into the Gate.
- **no buttons**: iMessage has none, so a card goes as the text the registry renders for
  button-less channels, with the slash commands that do what the buttons would.
- **pairing** still needs a one-to-one chat: `chat.style` 43 is private, 45 is a group,
  anything else unknown, and the registry refuses to pair with the last two (safety
  2026-10-11 H1).

`imessageHandle` is the only key, and unlike a bot token it is not a secret — it is the
owner's own address, and it says who the park may talk to. It lives with the other keys
so one place answers "is this channel configured".

Two macOS permissions decide whether it works, and the adapter names the missing one
rather than looking wired and going quiet: **Full Disk Access** for whatever runs the
sidecar (without it chat.db cannot be opened and nothing is ever received) and
**Automation → Messages** (the first send raises the prompt; until it is answered the
send fails with AppleEvent timed out, which is what happened on the first real try).

Telegram, Discord and Slack stay in the tree, unwired: the registry takes any adapter and
there is no reason to delete working code the owner may want later.

## D171. The approval that matters most now reaches the phone

The owner: "so i want the maka chief to msg me on this imgs and get the approvals or
anything i want to talk to as well. its a chatbot for me." Most of that was already the
registry's job — a paired chat gets Gate cards, `/gate`, `/status`, `/away`, `/back`, and
anything else typed is a question the Chief answers from recorded data. One thing was
missing, and it was the commonest approval there is.

A tool with a leash domain raises a **Gate item**, which the channels forward. A tool that
asks per call — `fs.write`, the thing a Ranger does every time it writes a deliverable —
raises a **permission.prompt** instead, and the registry only ever listened for
`gate.item`. So the prompt reached the park page and nowhere else: away from the screen,
the Superintendent could not let a Ranger write a file, and the prompt timed out as a
denial five minutes later. That is exactly what happened on the first real run here — the
Ranger wrote its product sheet, was denied twice by nobody answering, and said so.

The registry now forwards `permission.prompt` as a card and takes `/allow <prompt>` and
`/deny <prompt>` back, answering through a `permissions` handle (the run manager's own
`answer`) passed in at boot. `permission.response` closes the card in every chat that
holds it, whoever answered and wherever. A prompt that already timed out says so rather
than pretending. `channel.delivery.kind` gained `permission_card` and `permission_update`
— an enum widening, which is additive and safe for a frozen contract.

Five minutes is enough to answer from a phone, which is why this is worth doing rather
than lengthening the timeout.

## D172. No pairing code on iMessage, and the park stops answering itself

Two faults the first real conversation exposed, both from the same root: the Mac is
signed in as the owner and the park writes to the owner, so the owner is on both ends.

**The echo.** Messages files every outgoing message twice — once as sent, and once as
*received* on the same Apple ID, carrying the owner's own handle. The adapter would have
read the park's own Gate cards back as the owner's replies and handed them to the Chief
as questions. `sendText` now remembers what it just said (text and time, a bounded ring)
and the poll drops an inbound line that matches one, consuming it once so the owner
saying the same thing twice still counts twice.

**The code.** The owner: "no need of code". They are right for this channel and only this
channel. A pairing code exists because anyone at all can message a Telegram bot, so the
code proves which chat belongs to the owner. The iMessage adapter already refuses to send
to, or accept from, any handle but the ones in the keystore, and only in a one-to-one
chat — the handle *is* the credential, checked on every message in both directions, so
asking for a code is asking the owner to prove they are themselves. An adapter may now
declare `trusted: true`, and the registry pairs its first private message on sight and
acts on that very message. Every other channel is untouched and still pairs by code; the
test asserts both halves, because this is the one place where loosening the rule is
correct and it must not leak to the others.

## D173. The park signs its messages, and can speak as itself

The owner asked which number the park messages from. The honest answer was: as them. The
only Apple ID in Messages on this Mac is the owner's, so the park writes to the owner from
the owner — a thread the owner shares with themselves, which is why it reads as a muddle
and why the echo of D172 existed at all.

Two parts, one of them needing a human.

**The signature** costs nothing and happens now: every message the adapter sends is
prefixed `Maka · ` (added once, never stacked). Whoever the account is, the owner can see
which lines are the park's.

**The separate identity** is what the owner actually asked for:
`communications@makapark.com` as an Apple ID of its own, signed into Messages beside
theirs, so the park's messages arrive from the park. The adapter is ready for it —
`imessageFrom` (optional; `MAKA_IMESSAGE_FROM`) selects the sending account, which
Messages files as `E:<apple id>` — but the account cannot be made from here: an Apple ID
needs its verification mail received at that address (so makapark.com needs MX records,
which needs the Cloudflare DNS token that is still missing), a password and a second
factor, and Apple's terms accepted by the person they bind. The adapter falls back to the
first iMessage account and says in its status line which identity it is using, so the
park never pretends to be something it is not.

Adapters may now declare `optionalKeys`: a key the channel can do without is not "not
wired", it is simply unset.

## D174 — how many people are in the chat, not what Apple labels it

`chat.style` is documented as 43 for a one-to-one chat and 45 for a group, and the
iMessage adapter trusted it: anything not 43 was discarded before the registry saw it,
so the park could not be addressed from a group the owner happens to be in (D172).

On a Mac signed in as the owner, Messages files the owner's own thread with themselves
as **style 45 with one participant**. Every command the owner typed was therefore thrown
away as "a group", silently — the park never answered and nothing was logged, because
dropping a non-private chat is the normal, expected path.

The inbound query now also counts the chat's members
(`SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = c.ROWID`) and `chatTypeOf`
prefers that count: exactly one participant is private, more than one is a group, and
the style flag is only consulted when no count is available. This is strictly tighter
than reading the flag — a real group cannot become private by being mislabelled, because
its member count gives it away — so it does not loosen D172's "the owner and nobody else".

Proven live: `/status` from the owner's phone paired the chat and the park replied with
the Gate, mission, spend and attendance, delivered.

## D175 — a turn that produced nothing is not a sendable turn

The first venture stalled at market research. The Chief reported, truthfully, that its
scout "could not open web pages because of a network issue" and refused to go further
rather than invent prices — but the network was fine. `example.com`, DuckDuckGo's HTML
endpoint, BLS, Amazon and real candle-wax suppliers all answer the park's honest
`Maka/0.1 (+local agent harness)` user agent with HTTP 200.

The real failure was in the provider adapters. The worker (`qwen2.5:7b`) spent a turn and
emitted nothing usable, leaving an assistant message with **no content blocks**. On the
next turn, after the judge asked for a revision, that history went back out:

- the OpenAI shape sent `{ role: 'assistant', content: null }` with no `tool_calls`, and
  Ollama refused the whole request with `HTTP 400: invalid message content type: <nil>`;
- Anthropic refuses the same turn for its own reason — content may not be empty, and a
  text block may not be blank.

So any run where the worker produced an empty turn could never be revised: the retry died
on a 400 before reaching the model. The scout's "network issue" was the model's own guess
at why its run had died.

`content: null` is now sent only alongside `tool_calls`, which is the one shape that
allows it; otherwise an assistant turn carries the empty string. On the Anthropic side,
blank text blocks are dropped, a turn left with no content is omitted, and the turns on
either side of an omitted one are joined so two messages never arrive sharing a role. A
`tool_use` turn carries no text and is not an empty turn — it still goes out.

Proven against the live worker: the old shape returns the exact 400 above, the new one
returns 200. This is the same class of bug as D169 — the fakes accepted a shape no real
API does.

Note for later, not a code change: a 7B local worker that spends a turn to say nothing is
what exposed this. The loop now survives it, but the thrash it causes (four rejected scout
attempts) is a routing question, not a bug.

## D176 — the Chief could hire but not retire, and submit a plan but not read one

Two live refusals from the Chief, both correct, both pointing at a missing tool.

Asked to revise the ember-wick plan to v3, it answered: "Submitting a plan replaces the
whole thing, and I can't retrieve the v2 contents (other tasks, budgets, the other
ventures). A v3 built from what I remember would overwrite v2 with guesses." It was right.
`plan.submit` replaces the plan outright, and nothing could read one back — the follow-up
prompt carried only `plan.summary.slice(0, 800)`. A replacing write with no matching read
makes every revision destructive, so the only safe move was not to revise.

Asked to retire eight surplus Rangers it had itself identified, it answered: "I have no
tool in this run that retires or removes an agent." Also right. `crew.hire` only ever grew
the crew, which is how twelve Rangers and three scouts accumulated on a $2.50 candle
venture that had produced nothing.

Added, both granted to `chief_ranger` only:

- **`plan.read`** returns the stored plan exactly as it is — every venture with its roles,
  tasks and budgets, plus the mission ceiling a revision must stay under and the version
  history. It returns the shape `plan.submit` accepts, so a revision is an edit of what
  came back. It refuses when there is no mission and when no plan exists yet, rather than
  answering with an empty skeleton that could be mistaken for a real plan.
- **`crew.retire`** is `agents.remove` for the Chief. The existing guards already refuse an
  agent with reports or with a run in progress and keep at least one Ranger in the park;
  this adds the one the registry cannot know, that the Chief may not retire itself (checked
  against both `CHIEF_ID` and the calling `agentId`). Finished work and deliverables stay;
  only the Ranger goes, recorded as `crew.agent { change: 'removed' }`.

The Chief's working-order instruction and its follow-up prompt both now say to call
`plan.read` before revising and that `plan.submit` replaces, so anything left out is lost.

## D177 — a zone is born with its own kit

The root cause of the first venture's four failed scout attempts, found after D175 ruled
out the network and the adapter.

`ensureZone` created a bare room. The Chief's `crew.hire` opens a department camp on demand
and puts the new Ranger in it, so every Ranger it hired held role grants and nothing else:
`delegate`, `work.check`, `memory.*`, `recipe.run`, `crew.spawn_junior`. The research kit —
`web.fetch`, `web.search`, `web.read`, `web.trends`, `brief.submit` — is a fixture grant
(`trailhead_sign`), and no fixture was ever placed. **No agent in the park could reach the
web at all.** The five `supply_cache` fixtures that did exist had been placed by hand.

The task was impossible, and the two models failed at it differently: `qwen2.5:7b` invented
a fetch result (`"https://www.bls.gov/, 200 OK"`) and wrote a brief of made-up price bands,
and `claude-haiku-4-5` correctly reported that `web.fetch` was not in its function list and
stopped. Both writes were refused — the `fs.write` permission card (D11) went to the owner's
phone and nobody approved a fabrication — so the gate held and nothing false was ever
stored. But the loop could not progress, and the Chief's honest report that its scout "could
not open web pages" read as a network fault when it was a missing grant.

`ZONE_FIXTURES` in `shared/world.js` now says which kit each zone kind is born with, and
`ensureZone` places it, emitting `object.place` per fixture so the park shows only what
happened. `test/research.test.js` and `scripts/demo-phase4.mjs` already put the sign in the
Research Camp, which is where `SPECIALTIES.scout` sends its Rangers; that is now what the
live park does too.

The kit holds only fixtures whose tools need no leash or are read-only: `trailhead_sign`
(research), `ledger_desk` (`ledger.read`), and `supply_cache` everywhere, because a Ranger
that cannot write a file cannot deliver anything and each write still asks at the Gate.
The connector and machine fixtures — `radio_tower`, `park_store`, `notice_board`,
`fee_booth`, `field_office`, `outpost`, `control_desk` — send mail, publish, move money or
drive the Mac, and they stay the Superintendent's deliberate placement; the connectors are
wired one at a time.

A zone that already exists is returned untouched. A camp the owner has curated is not
quietly refitted, and nothing is added behind their back — so this park's existing bare
zones were fitted out explicitly through `POST /api/layout/place`, which is an owner
action and is on the record as five `object.place` events.

## D178 — the park replicates a company: ten departments, heads, and requests that go through them

The owner: "we need to replicate corporate to our park. Need to sales, marketing,
business, finance, hr etc to manage these business autonomously. If any problems or need
anything, it goes through the departments." Asked to choose, they picked the full set plus
IT, head triage, and team folders that are read-shared and write-own.

**The departments.** Five teams were added to the six that existed, and Sales Camp — a
zone kind that had been defined with nobody homed in it — finally got one:

| Team | Camp | Owns |
| --- | --- | --- |
| Sales Ranger | Sales Camp | the pipeline: qualify, reach out, report what closed |
| People Ranger | People Camp | who the park needs; asks the Chief to hire or retire |
| Business Ranger | Business Camp | strategy and pricing from the books and the briefs |
| Legal Ranger | Legal Camp | platform terms, labelling, privacy, what may be claimed |
| Infrastructure Ranger | Infrastructure Camp | the browser, the connectors' health, the Mac |

`DEPARTMENT_KINDS` is **derived** from `SPECIALTIES` rather than kept as a second list, so
a department and the team that lives in it cannot drift apart. A zone kind nothing homes in
— the Ranger Station, the Peak, the Entrance Gate, a trailhead — is not a department and
never appears. Ten departments, eleven teams: the Marketing Camp houses both Ads and
Marketing, which the directory shows rather than hides.

Business and Legal are born with a Trailhead sign, because reading the public web is how
either does its work at all — platform terms, consumer rules, competitor pricing. People
and Infrastructure get only a supply cache: People asks the Chief to hire or retire rather
than holding those tools itself, and Infrastructure's browser and Mac fixtures are leashed,
so both stay the Superintendent's to place (D177).

**Heads.** A department has one head, an optional `head` flag on the agent record. Only a
Ranger standing in a department camp may hold it: a Junior's parent must be a Ranger, so a
Junior head would leave a team reporting to someone who cannot hold its work. Appointing a
head stands the previous one down, announced like any other crew change, so a camp never
has two. `crew.hire` takes `head: true` so the Chief can open and staff a department in one
call.

**Requests go through the departments.** `delegate` names one agent and always did, which
meant a Ranger had to already know who could help. Two tools were added:

- **`dept.directory`** — what each department is for, whether its camp exists, who heads
  it, who is on its team, and its folder. A camp that was never built reads "not built
  yet" rather than as an empty one, because the two call for different answers.
- **`dept.request`** — ask a department, not a person. It lands with the head, whose brief
  says it is the head and may assign the work on with `delegate`. A department with no camp
  is told to ask the Chief to open it; one with Rangers but no head is told to ask for a
  head; a head asking its own department is told to handle it rather than looping to itself.

Both go to `chief_ranger` and `ranger`. A Junior gets neither: its work comes from its own
Ranger, who holds both, and letting the narrowest role open work items across the park is
how a one-hop tree turns into unbounded fan-out. A request is still delegated from the
caller's own run budget, so safety L4 bounds it exactly as `delegate` is bounded — outside a
run the tool refuses rather than opening unfunded work.

**Team folders.** `<workspace>/_teams/<department>/`, addressed by that explicit prefix
rather than by `../`, so reaching another team's files reads as the deliberate act it is
and every other path behaves exactly as before. Read shared, write own: any team may read
any team's folder, so a Scout's brief is available to Finance without a round trip, and a
team may write only its own, so a mistake stays with whoever made it.

The containment is unchanged, which is the point: `resolveForAgent` only chooses which root
a path belongs to and then hands it to `resolveInWorkspace`, the same symlink- and
`..`-proof check the per-agent sandbox has always used, with the department's own folder as
the root. A team path therefore can no more escape into another team than an agent path can
escape its workspace. Only real department names resolve, so the prefix cannot be used to
make an arbitrary directory under the workspace root, and an agent in no department may
read a team folder but write to none.
