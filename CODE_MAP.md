# CODE_MAP

What exists in this repository right now, file by file. Anything not listed here does not
exist. Items marked **planned** are the next phase 1 steps and are not on disk yet.

## Root

| Path | What it is |
| --- | --- |
| `README.md` | Concept, product laws, how to run from source. |
| `LICENSE` | MIT. |
| `NOTICE.md` | Provenance. Lists any snippet adapted from StarNet (none so far). |
| `CLAUDE.md` | Rules for AI coding agents working in this repo. |
| `CODE_MAP.md` | This file. |
| `package.json` | `npm start`, `npm test`, `npm run test:fast`. Zero dependencies. ESM. |
| `.gitignore` | Ignores `.env*`, `*.key`, `secrets/`, `.maka/`, `workspace/`, `node_modules/`. |

## `docs/`

| Path | What it is |
| --- | --- |
| `docs/KICKOFF_BRIEF.md` | The phase 1 specification. |
| `docs/BRAIN.md` | Orientation: how the pieces fit, where to start reading. |
| `docs/DECISIONS.md` | Decisions taken where the brief was ambiguous. |

## `shared/` — loaded by both the sidecar and the frontend as ES modules

| Path | What it is |
| --- | --- |
| `shared/schema.js` | Tiny JSON-schema-like validator: `validate`, `assertValid`, `deepFreeze`. Supports type, properties/required/additionalProperties, items, enum, const, min/max for strings, numbers and arrays, anyOf. Nothing else. |
| `shared/world.js` | Theme-agnostic world data: `OBJECT_KINDS` (fixtures: trailhead_sign → `web.fetch`; supply_cache → `fs.read` + `fs.write`), `LAYOUT_SCHEMA`, `defaultLayout()` (one zone "Ranger Station", one agent "Ranger"), `grantsFor(layout, agentId)`. Zones are `rooms` and fixtures are `objects` on the wire; those names are frozen. Fixtures for phase 2 connectors (radio tower, park store, notice board, fee booth, ledger desk) are not listed because their tools do not exist. |
| `shared/leash.js` | Leash model as data: `LEASH_LEVELS` (observe → draft → act_capped → act_free), `DOMAINS`, `TOOL_DOMAINS` (phase 1 tools → research / workspace), `LEASH_SCHEMA`, `defaultLeash()` (draft everywhere, research act_free, money_out capped at $0), `leashFor(leash, tool)`. Phase 1 only reports the level on permission prompts; enforcement in the gate is phase 2. |
| `shared/events.js` | The frozen, additive-only event contract. `EVENT_TYPES`, `PAYLOAD_SCHEMAS`, `ENVELOPE_SCHEMA`, `validateEvent`, `assertEvent`, `makeEvent`. Eleven events: `agent.run.start`, `agent.token`, `agent.tool_call`, `agent.tool_result`, `agent.run.end`, `agent.run.error`, `cost.estimate`, `permission.prompt`, `permission.response`, `object.place`, `object.reclaim`. |

## `sidecar/` — the one Node process

| Path | What it is |
| --- | --- |
| `sidecar/index.js` | Entry point. `boot({ env, port, host, log })` wires store, bus, layout state, optional `policy.json` / `leash.json` from `MAKA_HOME` (invalid files are reported and ignored), run manager and server; prints where data lives, which providers are wired and the worker/judge routing. Exports `REPO_ROOT`. |
| `sidecar/server.js` | HTTP routes (`/api/state`, `/api/events` SSE, `/api/run`, `/api/cancel`, `/api/layout` GET/PUT, `/api/layout/place`, `/api/layout/reclaim`, `/api/permission`, `/api/runs`, `/api/runs/:id`), static `frontend/` and `/shared/`. `createLayoutState` applies placement rules (kind exists, tile in room, tile free) and emits validated `object.place` / `object.reclaim`. |
| `sidecar/runs.js` | Run manager: one run at a time; picks the model through the router (explicit provider/model in the request wins, otherwise the worker tier) and records the tier on the run; builds the gate for the agent's workspace with the leash policy; implements `ask` as a `permission.prompt` → `permission.response` round trip with a timeout (denial); records every event of the run and reconciled spend; persists through the store with debounced flushes. |
| `sidecar/router.js` | `createRouter(policy).route({ kind })` → `{ tier, provider, model }`. Policy is validated data (`POLICY_SCHEMA`, `defaultPolicy()`: worker = ollama, judge = anthropic; `turn` → worker, `plan`/`review`/`ambiguity`/`gate_action` → judge; judge-call caps as data). Phase 1 uses only `turn`. Loaded from `$MAKA_HOME/policy.json` when present. |
| `sidecar/bus.js` | Event bus: validates, assigns `seq`, keeps a 2000-event buffer, fans out to listeners and SSE clients, replays after `Last-Event-ID`. |
| `sidecar/store.js` | `writeJsonAtomic` (temp → fsync → rename → fsync dir) and the store: `layout.json`, `spend.json`, `runs/<runId>.json`. |
| `sidecar/loop.js` | The agentic loop, `runLoop(options)`. Messages-array while-loop; guards (cancelled / max turns / budget) before every paid call; content blocks accumulated by index; one `agent.tool_result` per `agent.tool_call`; provider failure emits `agent.run.error` and no `agent.run.end`. `tier` is stamped on each `cost.estimate`. `review` is the pre-Gate hook point for the phase 2 judge: revise/reject answers the turn's tool calls with the notes instead of running them. Pure given injected `provider`, `tools`, `emit`, `clock`, `signal`, `ids`. Also exports `costOf(usage, price)`. |

| `sidecar/providers/provider.js` | The provider contract (normalized stream chunks) and registry for `anthropic`, `openrouter`, `ollama`: `createProvider(name, opts)` resolves a key (or, for ollama, a model) and a price; `providerStatus()` reports keyed providers as configured or not and ollama as reachable or not with its installed models, never revealing a key. |
| `sidecar/providers/anthropic.js` | Anthropic Messages API over raw `fetch`, streaming, tool use. Keeps `thinking` blocks verbatim and replays them. Default model `claude-opus-5-5`. |
| `sidecar/providers/openai-compat.js` | Shared adapter for OpenAI-compatible chat-completions endpoints: message/tool translation both ways, streamed tool calls accumulated by index, `cost(usage)` hook. |
| `sidecar/providers/openrouter.js` | OpenRouter on top of `openai-compat.js`; forwards OpenRouter's reported `usage.cost` as reconciled spend. |
| `sidecar/providers/ollama.js` | Ollama (local worker models) on top of `openai-compat.js` at `OLLAMA_HOST` (default `http://127.0.0.1:11434`). No key. Every turn costs a reconciled $0. `listModels()` / `probe()` ask the server what is installed; the registry picks `OLLAMA_MODEL` or the first installed model and fails with `NO_MODEL` / `OLLAMA_UNREACHABLE` otherwise. |
| `sidecar/providers/sse.js` | `text/event-stream` parser and HTTP error helper shared by both adapters. |
| `sidecar/providers/keys.js` | Key resolution: env var first, then `.maka/keystore.json` which must be mode 0600 (refused otherwise). `setKey` writes it 0600. Keys never leave this module except into a request header. |
| `sidecar/providers/pricing.js` | List prices per million tokens for known Anthropic models. Unknown model → `null` → unreconciled cost. |

| `sidecar/capability/tools.js` | The three phase 1 tools. `fs.read` and `fs.write` are sandboxed to the agent workspace via real-path checks (no `..`, no symlink escapes), with size caps and visible truncation notes. `web.fetch` is GET-only http(s) with a timeout, size cap and HTML-to-text. `fs.write` is marked `confirm: true`. |
| `sidecar/capability/gate.js` | `createToolGate(...)` turns the current layout into the `tools` object the loop uses: `definitions()` lists only granted tools; `execute()` re-checks the grant at call time, validates input, asks the user for confirmation when the tool needs it, and runs it. |


## `frontend/` — static vanilla JS, served by the sidecar, imports only from `/shared/`

**Status: the 2D pixel-art park below works end to end but is SUPERSEDED.** On 2026-10-10
the owner changed the visual direction to 3D; work stopped on an owner hold and the
replacement step 7 spec is pending. Everything in this section is committed as work in
progress so nothing is lost; it is not the final park.

| Path | What it is |
| --- | --- |
| `frontend/index.html` | The page: full-bleed canvas, window layer, flash line, status bar. Loads `app.js` as an ES module. |
| `frontend/style.css` | Dark-first styles for the windows, transcript, Entrance Gate card and status bar. |
| `frontend/app.js` | Entry: loads `/api/state`, subscribes to `/api/events`, owns the state object, renders world + windows on each change, resyncs the snapshot after a reconnect. |
| `frontend/state.js` | Pure reducer (tested under Node): snapshot + validated events → layout, per-Ranger state (idle / thinking / tool-running / waiting / done / error), run transcripts with per-turn cost lines, pending prompts, reconciled spend (never double-counted across snapshot and replay). Invalid events are counted and ignored. |
| `frontend/events.js` | SSE client with reconnect and Last-Event-ID resume. |
| `frontend/world.js` | Canvas renderer: ground and trees over the view, zones with path rings, station, Entrance Gate (a waiting Ranger stands there), fixtures, Ranger bodies, build-mode ghost, pan/zoom camera, click targets (Ranger / fixture / Gate / zone) reported to the inspector; theme-agnostic. |
| `frontend/theme/park.js` | National park theme built from the vendored CC0 sheets (Tiny Town tiles, Puny Characters Ranger): ground, path ring, station building, Entrance Gate, fixture tiles, Ranger frames per harness state. Primitive drawings stand in until the sheets load; the status bar shows `art: loading / ready / missing`. |
| `frontend/assets/` | Vendored sheets (`tiny-town.png`, `ranger.png`) plus `manifest.json` with source, license, archive hash and per-file hash. Produced by `scripts/fetch-assets.mjs`; checked by `test/assets.test.js`. |
| `frontend/ui/inspect.js` | INSPECT window: the card for a clicked Ranger (state, run, model per turn, spend, leash levels), zone (roster, fixtures, grants), fixture (grants, tool calls through it this session) or the Entrance Gate (what is waiting). Only session data, nothing projected. |
| `frontend/ui/windows.js` | Draggable window helper and tiny DOM builder. |
| `frontend/ui/comms.js` | COMMS window: "route by policy" (worker tier) or an explicit provider, each labelled wired / not wired / reachable / not reachable; brief, run, cancel; streaming transcript with tool calls, Gate decisions and per-turn model + cost lines. |
| `frontend/ui/spend.js` | SPEND window fed only by reconciled cost; unpriced turns are counted, never estimated. |
| `frontend/ui/build.js` | BUILD window: fixture palette from the sidecar's `objectKinds`, click a tile to place, click a fixture to reclaim; lists what is placed and what it grants. |
| `frontend/ui/permission.js` | Entrance Gate cards for pending prompts with the tool, its input, and the leash domain and level; Allow / Deny post `permission.response` and the card leaves only when the sidecar echoes the answer. |

Verified end to end in headless Chromium against a test sidecar with a scripted provider
(place by clicking, run from COMMS, Gate card with leash level, Ranger standing at the
Gate, inspector, allow, run end, spend; no console errors); the script lives outside the
repo for now, so this check is manual, not part of `test:fast`.

## `scripts/`

| Path | What it is |
| --- | --- |
| `scripts/fetch-assets.mjs` | Downloads the pinned art archives, verifies SHA-256, extracts only the listed sheets into `frontend/assets/`, writes the manifest. `--check` verifies the vendored files against the manifest. Core-only zip reader inside. |

## `test/`

| Path | What it is |
| --- | --- |
| `test/fast.list` | The suites that gate a push, one path per line. |
| `test/run-fast.js` | Runs `node --test` over `fast.list`; fails on a missing or empty list. |
| `test/schema.test.js` | Validator behaviour. |
| `test/events.test.js` | Every event type validates, round-trips JSON, rejects bad shapes; contract is frozen. |
| `test/loop.test.js` | Loop invariants against the fake provider: tool pairing, index accumulation, bad JSON, guards, cancellation at three points, provider failure. |
| `test/providers.test.js` | SSE parser, all three adapters against recorded streams (request shape, chunk normalization, errors, abort), adapters driving the real loop, Ollama model discovery, keystore permissions, pricing, registry. |
| `test/store.test.js` | Atomic write ordering (open, write, fsync, close, rename, dir fsync), no temp files left, store round-trips, bus numbering/replay/listener isolation. |
| `test/server.test.js` | Full stack over real HTTP on an ephemeral port: state, placement rules, SSE replay, static serving and traversal guards, run lifecycle with persistence and spend, cancel, permission round trip with timeout and leash info, provider failure, `NO_KEY` / `OLLAMA_UNREACHABLE`, worker-tier routing, and `boot()` itself. |
| `test/helpers/test-server.js` | Boots the full sidecar stack in a temp dir with an injectable provider factory; SSE client for tests. |
| `test/router.test.js` | Policy validation and routing; tier stamped on cost events; the loop's review hook (approve / revise / reject / throw / unknown verdict). |
| `test/leash.test.js` | Leash levels, defaults, tool → domain coverage, validation; contract enum agrees with the model. |
| `test/assets.test.js` | Zip reader (stored and deflated), vendored files match the manifest, every source is CC0/CC-BY with evidence, hash mismatch refuses to extract. |
| `test/frontend-state.test.js` | The frontend reducer: state transitions through a run, waiting at the Gate, errors, spend double-count guard, layout events, invalid events. |
| `test/capability.test.js` | Layout → grants, sandbox escapes (dotdot, absolute, symlinks), read/write/fetch behaviour, gate refusal and confirmation flow, gate driving the real loop. |
| `test/helpers/fake-provider.js` | Scripted provider, fake clock, event recorder, fake tool set. Test-only. |
| `test/helpers/fake-fetch.js` | `fetch` stand-in that streams SSE text in small chunks. Test-only. |

## Not in phase 1 (no code, no UI)

Judge step in the loop (hook point exists, nothing calls it), leash enforcement in the gate
(data exists, nothing enforces it), connectors and their fixtures (radio tower, park store,
notice board, fee booth, ledger desk), trails as handoff queues, concurrent Rangers, Lookout
Tower ledgers, away mode, Tauri shell (`src-tauri/`), Keychain, MCP, channels. None of these
have stubs in the UI; when they arrive they get a row here first.
