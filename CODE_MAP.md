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
| `shared/world.js` | World data: `OBJECT_KINDS` (fixtures: trailhead_sign → `web.fetch`; supply_cache → `fs.read` + `fs.write`), `AGENT_ROLES` (superintendent, chief_ranger, ranger, junior_ranger), `LAYOUT_SCHEMA` (rooms, objects, agents with optional `role` and `parentAgentId`, park `seed`), `defaultLayout()` (one zone "Ranger Station", one Ranger), `grantsFor(layout, agentId)`. Zones are `rooms` and fixtures are `objects` on the wire; those names are frozen. Fixtures for phase 2 connectors (radio tower, park store, notice board, fee booth, ledger desk) are not listed because their tools do not exist. |
| `shared/leash.js` | Leash model as data: `LEASH_LEVELS` (observe → draft → act_capped → act_free), the brief's final nine `DOMAINS`, `TOOL_DOMAINS` (`fs.read` and `web.fetch` → research; `fs.write` → none, it is workspace-only and confirmed per call), `LEASH_SCHEMA`, `defaultLeash()` (draft everywhere, research act_free, money_out capped at $0), `leashFor(leash, tool)`. Phase 1 only reports the level on permission prompts; enforcement in the gate is phase 2. |
| `shared/events.js` | The frozen, additive-only event contract. `EVENT_TYPES`, `PAYLOAD_SCHEMAS`, `ENVELOPE_SCHEMA`, `validateEvent`, `assertEvent`, `makeEvent`. Thirteen events: `agent.run.start`, `agent.token`, `agent.tool_call`, `agent.tool_result`, `agent.run.end`, `agent.run.error`, `cost.estimate` (optional `tier`), `permission.prompt` (optional `leash`), `permission.response`, `object.place`, `object.reclaim`, `work.handoff` (phase 2 emits it), `layout.seed`. |

## `sidecar/` — the one Node process

| Path | What it is |
| --- | --- |
| `sidecar/index.js` | Entry point. `boot({ env, port, host, log })` wires store, bus, layout state, optional `policy.json` / `leash.json` from `MAKA_HOME` (invalid files are reported and ignored), run manager and server; prints where data lives, which providers are wired and the worker/judge routing. Exports `REPO_ROOT`. |
| `sidecar/server.js` | HTTP routes (`/api/state`, `/api/events` SSE, `/api/run`, `/api/cancel`, `/api/layout` GET/PUT, `/api/layout/place`, `/api/layout/reclaim`, `/api/layout/reroll`, `/api/permission`, `/api/runs`, `/api/runs/:id`), static `frontend/` (including `/vendor/` and `/assets/`) and `/shared/`. `createLayoutState` applies placement rules (kind exists, tile in room, tile free) and emits validated `object.place` / `object.reclaim`. |
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


## `frontend/` — static vanilla JS, served by the sidecar; imports from `/shared/` and the vendored Three.js only

| Path | What it is |
| --- | --- |
| `frontend/index.html` | The page: the park container, the window layer, flash line, status bar, and the import map that resolves `three` and `three/addons/` to `frontend/vendor/three/`. |
| `frontend/style.css` | Dark-first styles for the windows, transcript, Entrance Gate card, camera bar and status bar. |
| `frontend/app.js` | Entry: loads `/api/state`, subscribes to `/api/events`, owns the one state object, imports the park renderer dynamically (a missing vendor build shows "renderer not vendored: run `npm run assets`"), wires clicks to the inspector and build mode, camera bar, re-roll. |
| `frontend/state.js` | Pure reducer (tested under Node): snapshot + validated events → layout (incl. seed), per-Ranger state (idle / thinking / tool-running / waiting / done / error), run transcripts with per-turn cost lines, pending prompts, latest `work.handoff` per agent, reconciled spend. |
| `frontend/events.js` | SSE client with reconnect and Last-Event-ID resume. |
| `frontend/park/random.js` | Seeded PRNG and hash. |
| `frontend/park/terrain.js` | Seeded heightmap: value-noise fBm, ridgelines at the edges, a river valley, flattening inside clearings; `heightAt`, `isWater`. |
| `frontend/park/spline.js` | Catmull-Rom splines with arc-length tables for constant-speed travel; `trailBetween`. |
| `frontend/park/placement.js` | Layout → park model: zones become clearings, the Entrance Gate clearing sits south of the first zone, trails join them, trees and rocks scatter from the seed off clearings, trails and water; fixtures and Ranger homes map from tiles. |
| `frontend/park/clips.js` | Harness state → clip and standing place: the only table that decides what the Ranger's body does; handoff walks interpolate from a real event's timestamp. |
| `frontend/park/sun.js` | Sun direction, light and fog colours from the real clock (cosmetic). |
| `frontend/park/render.js` | The only Three.js module: WebGL2 renderer, Sky, directional sun with shadows, fog, vertex-coloured terrain mesh, GLSL water, trail ribbons, clearings with Survival Kit buildings and the gate, instanced Nature Kit foliage, the FBX Ranger with idle/run clips and a state badge, orbit / fly / follow cameras, raycast picking → inspector. Reads state every frame; owns none. |
| `frontend/park/` tests | `test/park.test.js` covers everything above except `render.js`. |
| `frontend/vendor/three/` | Three.js 0.186.1 module build and addons, vendored by the asset script (see NOTICE.md). |
| `frontend/assets/` | Vendored GLB/FBX/texture files per pack plus `manifest.json` (source, license, archive hash, per-file hash). Produced by `scripts/fetch-assets.mjs`; checked by `test/assets.test.js`. |
| `frontend/ui/windows.js` | Draggable window helper and tiny DOM builder. |
| `frontend/ui/comms.js` | COMMS window: "route by policy" (worker tier) or an explicit provider; brief, run, cancel; streaming transcript with tool calls, Gate decisions and per-turn model + cost lines. |
| `frontend/ui/spend.js` | SPEND window fed only by reconciled cost. |
| `frontend/ui/build.js` | BUILD window: fixture palette; with a kind selected, a click inside a zone clearing places it at the nearest free tile and a click on a fixture reclaims it. |
| `frontend/ui/permission.js` | Entrance Gate cards for pending prompts with tool, input and leash level; the card leaves only when the sidecar echoes the answer. |
| `frontend/ui/inspect.js` | INSPECT window for a clicked Ranger (state, run, model per turn, spend, leash levels), zone (roster, fixtures, grants), fixture (grants, tool calls through it), or the Gate (what is waiting). Session data only. |

**Verified** in headless Chromium (SwiftShader WebGL2) against a test sidecar with a
scripted provider: renderer boots, kit models and the FBX Ranger with clips load, a run
from COMMS raises the Gate card with the leash level, the Ranger badge follows the run,
allow completes the run, camera modes switch, re-roll changes the seed, no page errors. The
driver script lives outside the repo; it is a manual check, not part of `test:fast`.

**Not verified / not implemented:** the 60 fps on Apple Silicon target (SwiftShader here
renders at a few fps, which says nothing about a GPU); distance LOD for foliage (instancing
and frustum culling only); the WebGPU renderer path (WebGL2 only, see DECISIONS D27);
walking on handoffs is implemented but exercised only by the reducer test, since phase 1
emits no `work.handoff`.

## `scripts/`

| Path | What it is |
| --- | --- |
| `scripts/fetch-assets.mjs` | Downloads the pinned Three.js tarball and the CC0 kit archives, verifies SHA-256, extracts only the listed files into `frontend/vendor/three/` and `frontend/assets/<pack>/`, writes the manifest (with the unpinned Quaternius fallback listed as not fetched). `--check` verifies the vendored files against the manifest and the 25 MB cap. Core-only zip and tar.gz readers inside. |

## `test/`

| Path | What it is |
| --- | --- |
| `test/fast.list` | The suites that gate a push, one path per line. |
| `test/run-fast.js` | Runs `node --test` over `fast.list`; fails on a missing or empty list, and on any `test/*.test.js` the list does not name. |
| `test/schema.test.js` | Validator behaviour. |
| `test/events.test.js` | Every event type validates, round-trips JSON, rejects bad shapes; contract is frozen. |
| `test/loop.test.js` | Loop invariants against the fake provider: tool pairing, index accumulation, bad JSON, guards, cancellation at three points, provider failure. |
| `test/providers.test.js` | SSE parser, all three adapters against recorded streams (request shape, chunk normalization, errors, abort), adapters driving the real loop, Ollama model discovery, keystore permissions, pricing, registry. |
| `test/store.test.js` | Atomic write ordering (open, write, fsync, close, rename, dir fsync), no temp files left, store round-trips, bus numbering/replay/listener isolation. |
| `test/server.test.js` | Full stack over real HTTP on an ephemeral port: state, placement rules, SSE replay, static serving and traversal guards, run lifecycle with persistence and spend, cancel, permission round trip with timeout and leash info, provider failure, `NO_KEY` / `OLLAMA_UNREACHABLE`, worker-tier routing, and `boot()` itself. |
| `test/helpers/test-server.js` | Boots the full sidecar stack in a temp dir with an injectable provider factory; SSE client for tests. |
| `test/router.test.js` | Policy validation and routing; tier stamped on cost events; the loop's review hook (approve / revise / reject / throw / unknown verdict). |
| `test/leash.test.js` | Leash levels, defaults, tool → domain coverage, validation; contract enum agrees with the model. |
| `test/assets.test.js` | Zip and tar.gz readers, vendored files match the manifest, every source is CC0/CC-BY/MIT with evidence, hash mismatch refuses to extract. |
| `test/park.test.js` | Pure park math: seeded randomness, terrain properties (determinism, bounds, clearing flattening, river, ridgelines), splines, placement from the default layout, state → clip and place, sun by hour. |
| `test/frontend-state.test.js` | The frontend reducer: state transitions through a run, waiting at the Gate, errors, spend double-count guard, layout events, invalid events. |
| `test/capability.test.js` | Layout → grants, sandbox escapes (dotdot, absolute, symlinks), read/write/fetch behaviour, gate refusal and confirmation flow, gate driving the real loop. |
| `test/helpers/fake-provider.js` | Scripted provider, fake clock, event recorder, fake tool set. Test-only. |
| `test/helpers/fake-fetch.js` | `fetch` stand-in that streams SSE text in small chunks. Test-only. |

## Not in phase 1 (no code, no UI)

Judge step in the loop (hook point exists, nothing calls it), leash enforcement in the gate
(data exists, nothing enforces it), connectors and their fixtures (radio tower, park store,
notice board, fee booth, ledger desk), the mail system (Cloudflare DNS, Fastmail JMAP,
Resend; station mailboxes), browser control over CDP, the Mountain Peak control centre and
department zones, trails as real handoff queues (the park can animate a `work.handoff`,
nothing emits one), the Chief Ranger and Junior Rangers (roles exist as data only),
concurrent Rangers, away mode and the evidence log, distance LOD, the WebGPU renderer
path, Tauri shell (`src-tauri/`), Keychain, MCP, channels, the makapark.com download and
update pages. None of these have stubs in the UI; when they arrive they get a row here first.
