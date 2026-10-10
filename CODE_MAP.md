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
| `shared/events.js` | The frozen, additive-only event contract. `EVENT_TYPES`, `PAYLOAD_SCHEMAS`, `ENVELOPE_SCHEMA`, `validateEvent`, `assertEvent`, `makeEvent`. Eleven events: `agent.run.start`, `agent.token`, `agent.tool_call`, `agent.tool_result`, `agent.run.end`, `agent.run.error`, `cost.estimate`, `permission.prompt`, `permission.response`, `object.place`, `object.reclaim`. |

## `sidecar/` — the one Node process

| Path | What it is |
| --- | --- |
| `sidecar/loop.js` | The agentic loop, `runLoop(options)`. Messages-array while-loop; guards (cancelled / max turns / budget) before every paid call; content blocks accumulated by index; one `agent.tool_result` per `agent.tool_call`; provider failure emits `agent.run.error` and no `agent.run.end`. Pure given injected `provider`, `tools`, `emit`, `clock`, `signal`, `ids`. Also exports `costOf(usage, price)`. |

**Planned (steps 4 to 6):** `providers/` (interface, Anthropic, OpenRouter, keys),
`capability/` (layout → tool allowlist, three tools), `index.js` and the store (HTTP + SSE,
atomic persistence).

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
| `test/helpers/fake-provider.js` | Scripted provider, fake clock, event recorder, fake tool set. Test-only. |

## Not in phase 1 (no code, no UI)

Tauri shell (`src-tauri/`), channels (Telegram/Discord), MCP, cron, voice, concurrent
crews, auto-updater, release signing. None of these have stubs in the UI; when they arrive
they get a row here first.
