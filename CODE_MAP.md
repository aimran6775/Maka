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
| `sidecar/loop.js` | The agentic loop, `runLoop(options)`. Messages-array while-loop; guards (cancelled / max turns / budget) before every paid call; content blocks accumulated by index; one `agent.tool_result` per `agent.tool_call`; provider failure emits `agent.run.error` and no `agent.run.end`. Pure given injected `provider`, `tools`, `emit`, `clock`, `signal`, `ids`. Also exports `costOf(usage, price)`. |

| `sidecar/providers/provider.js` | The provider contract (normalized stream chunks) and registry: `createProvider(name, opts)` resolves a key and a price, `providerStatus()` reports which providers have keys without revealing them. |
| `sidecar/providers/anthropic.js` | Anthropic Messages API over raw `fetch`, streaming, tool use. Keeps `thinking` blocks verbatim and replays them. Default model `claude-opus-5-5`. |
| `sidecar/providers/openrouter.js` | OpenRouter chat-completions over raw `fetch`, streaming, tool calls. Translates to/from the internal block format; forwards OpenRouter's reported `usage.cost` as reconciled spend. |
| `sidecar/providers/sse.js` | `text/event-stream` parser and HTTP error helper shared by both adapters. |
| `sidecar/providers/keys.js` | Key resolution: env var first, then `.maka/keystore.json` which must be mode 0600 (refused otherwise). `setKey` writes it 0600. Keys never leave this module except into a request header. |
| `sidecar/providers/pricing.js` | List prices per million tokens for known Anthropic models. Unknown model → `null` → unreconciled cost. |

| `sidecar/capability/tools.js` | The three phase 1 tools. `fs.read` and `fs.write` are sandboxed to the agent workspace via real-path checks (no `..`, no symlink escapes), with size caps and visible truncation notes. `web.fetch` is GET-only http(s) with a timeout, size cap and HTML-to-text. `fs.write` is marked `confirm: true`. |
| `sidecar/capability/gate.js` | `createToolGate(...)` turns the current layout into the `tools` object the loop uses: `definitions()` lists only granted tools; `execute()` re-checks the grant at call time, validates input, asks the user for confirmation when the tool needs it, and runs it. |

**Planned (step 6):** `index.js` and the store (HTTP + SSE, atomic persistence).

## `frontend/` — **planned (step 7)**

Static vanilla JS canvas world and windowed UI, served by the sidecar.

## `test/`

| Path | What it is |
| --- | --- |
| `test/fast.list` | The suites that gate a push, one path per line. |
| `test/run-fast.js` | Runs `node --test` over `fast.list`; fails on a missing or empty list. |
| `test/schema.test.js` | Validator behaviour. |
| `test/events.test.js` | Every event type validates, round-trips JSON, rejects bad shapes; contract is frozen. |
| `test/loop.test.js` | Loop invariants against the fake provider: tool pairing, index accumulation, bad JSON, guards, cancellation at three points, provider failure. |
| `test/providers.test.js` | SSE parser, both adapters against recorded streams (request shape, chunk normalization, errors, abort), both adapters driving the real loop, keystore permissions, pricing, registry. |
| `test/capability.test.js` | Layout → grants, sandbox escapes (dotdot, absolute, symlinks), read/write/fetch behaviour, gate refusal and confirmation flow, gate driving the real loop. |
| `test/helpers/fake-provider.js` | Scripted provider, fake clock, event recorder, fake tool set. Test-only. |
| `test/helpers/fake-fetch.js` | `fetch` stand-in that streams SSE text in small chunks. Test-only. |

## Not in phase 1 (no code, no UI)

Tauri shell (`src-tauri/`), channels (Telegram/Discord), MCP, cron, voice, concurrent
crews, auto-updater, release signing. None of these have stubs in the UI; when they arrive
they get a row here first.
