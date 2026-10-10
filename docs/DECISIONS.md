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
