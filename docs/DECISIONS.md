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

## D26 (pending). The 2D pixel-art park is superseded by a 3D direction

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
  offsite backup only. Secret names: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DNS_TOKEN,
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, FASTMAIL_API_TOKEN.
- Domain: makapark.com (Cloudflare). Ranger mail is <role>-<venture>@makapark.com; the .dmg
  download page and update manifest are served from makapark.com in phase 3.
