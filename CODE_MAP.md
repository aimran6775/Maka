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
| `shared/world.js` | Theme-agnostic world data: `OBJECT_KINDS` (bookshelf → `fs.read`, workbench → `fs.write`, window → `web.fetch`), `LAYOUT_SCHEMA`, `defaultLayout()` (one room "Atelier", one agent "hero"), `grantsFor(layout, agentId)`. |
| `shared/events.js` | The frozen, additive-only event contract. `EVENT_TYPES`, `PAYLOAD_SCHEMAS`, `ENVELOPE_SCHEMA`, `validateEvent`, `assertEvent`, `makeEvent`. Eleven events: `agent.run.start`, `agent.token`, `agent.tool_call`, `agent.tool_result`, `agent.run.end`, `agent.run.error`, `cost.estimate`, `permission.prompt`, `permission.response`, `object.place`, `object.reclaim`. |

## `sidecar/` — the one Node process

| Path | What it is |
| --- | --- |
| `sidecar/index.js` | Entry point. `boot({ env, port, host, log })` wires store, bus, layout state, run manager and server; prints where data lives and which providers are wired. Exports `REPO_ROOT`. |
| `sidecar/server.js` | HTTP routes (`/api/state`, `/api/events` SSE, `/api/run`, `/api/cancel`, `/api/layout` GET/PUT, `/api/layout/place`, `/api/layout/reclaim`, `/api/permission`, `/api/runs`, `/api/runs/:id`), static `frontend/` and `/shared/`. `createLayoutState` applies placement rules (kind exists, tile in room, tile free) and emits validated `object.place` / `object.reclaim`. |
| `sidecar/runs.js` | Run manager: one run at a time; builds the gate for the agent's workspace; implements `ask` as a `permission.prompt` → `permission.response` round trip with a timeout (denial); records every event of the run and reconciled spend; persists through the store with debounced flushes. |
| `sidecar/bus.js` | Event bus: validates, assigns `seq`, keeps a 2000-event buffer, fans out to listeners and SSE clients, replays after `Last-Event-ID`. |
| `sidecar/store.js` | `writeJsonAtomic` (temp → fsync → rename → fsync dir) and the store: `layout.json`, `spend.json`, `runs/<runId>.json`. |
| `sidecar/loop.js` | The agentic loop, `runLoop(options)`. Messages-array while-loop; guards (cancelled / max turns / budget) before every paid call; content blocks accumulated by index; one `agent.tool_result` per `agent.tool_call`; provider failure emits `agent.run.error` and no `agent.run.end`. Pure given injected `provider`, `tools`, `emit`, `clock`, `signal`, `ids`. Also exports `costOf(usage, price)`. |

| `sidecar/providers/provider.js` | The provider contract (normalized stream chunks) and registry: `createProvider(name, opts)` resolves a key and a price, `providerStatus()` reports which providers have keys without revealing them. |
| `sidecar/providers/anthropic.js` | Anthropic Messages API over raw `fetch`, streaming, tool use. Keeps `thinking` blocks verbatim and replays them. Default model `claude-opus-5-5`. |
| `sidecar/providers/openrouter.js` | OpenRouter chat-completions over raw `fetch`, streaming, tool calls. Translates to/from the internal block format; forwards OpenRouter's reported `usage.cost` as reconciled spend. |
| `sidecar/providers/sse.js` | `text/event-stream` parser and HTTP error helper shared by both adapters. |
| `sidecar/providers/keys.js` | Key resolution: env var first, then `.maka/keystore.json` which must be mode 0600 (refused otherwise). `setKey` writes it 0600. Keys never leave this module except into a request header. |
| `sidecar/providers/pricing.js` | List prices per million tokens for known Anthropic models. Unknown model → `null` → unreconciled cost. |

| `sidecar/capability/tools.js` | The three phase 1 tools. `fs.read` and `fs.write` are sandboxed to the agent workspace via real-path checks (no `..`, no symlink escapes), with size caps and visible truncation notes. `web.fetch` is GET-only http(s) with a timeout, size cap and HTML-to-text. `fs.write` is marked `confirm: true`. |
| `sidecar/capability/gate.js` | `createToolGate(...)` turns the current layout into the `tools` object the loop uses: `definitions()` lists only granted tools; `execute()` re-checks the grant at call time, validates input, asks the user for confirmation when the tool needs it, and runs it. |


## `frontend/`

| Path | What it is |
| --- | --- |
| `frontend/index.html` | Placeholder page stating that the canvas UI is not wired yet. **Step 7 replaces it.** |

## `test/`

| Path | What it is |
| --- | --- |
| `test/fast.list` | The suites that gate a push, one path per line. |
| `test/run-fast.js` | Runs `node --test` over `fast.list`; fails on a missing or empty list. |
| `test/schema.test.js` | Validator behaviour. |
| `test/events.test.js` | Every event type validates, round-trips JSON, rejects bad shapes; contract is frozen. |
| `test/loop.test.js` | Loop invariants against the fake provider: tool pairing, index accumulation, bad JSON, guards, cancellation at three points, provider failure. |
| `test/providers.test.js` | SSE parser, both adapters against recorded streams (request shape, chunk normalization, errors, abort), both adapters driving the real loop, keystore permissions, pricing, registry. |
| `test/store.test.js` | Atomic write ordering (open, write, fsync, close, rename, dir fsync), no temp files left, store round-trips, bus numbering/replay/listener isolation. |
| `test/server.test.js` | Full stack over real HTTP on an ephemeral port: state, placement rules, SSE replay, static serving and traversal guards, run lifecycle with persistence and spend, cancel, permission round trip with timeout, provider failure, `NO_KEY`, and `boot()` itself. |
| `test/helpers/test-server.js` | Boots the full sidecar stack in a temp dir with an injectable provider factory; SSE client for tests. |
| `test/capability.test.js` | Layout → grants, sandbox escapes (dotdot, absolute, symlinks), read/write/fetch behaviour, gate refusal and confirmation flow, gate driving the real loop. |
| `test/helpers/fake-provider.js` | Scripted provider, fake clock, event recorder, fake tool set. Test-only. |
| `test/helpers/fake-fetch.js` | `fetch` stand-in that streams SSE text in small chunks. Test-only. |

## Not in phase 1 (no code, no UI)

Tauri shell (`src-tauri/`), channels (Telegram/Discord), MCP, cron, voice, concurrent
crews, auto-updater, release signing. None of these have stubs in the UI; when they arrive
they get a row here first.
