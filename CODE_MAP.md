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

## `shared/` — **planned (step 2)**

Frozen event contract (`events.js`) and a tiny schema validator (`schema.js`). Loaded by
both the sidecar and the frontend as ES modules.

## `sidecar/` — **planned (steps 3 to 6)**

The one Node process. Loop (`loop.js`), providers (`providers/`), capability gate
(`capability/`), HTTP + SSE server and persistence (`index.js` and friends).

## `frontend/` — **planned (step 7)**

Static vanilla JS canvas world and windowed UI, served by the sidecar.

## `test/` — **planned (step 8, files added from step 2 on)**

`node --test` suites. `test/fast.list` names the suites that gate a push.

## Not in phase 1 (no code, no UI)

Tauri shell (`src-tauri/`), channels (Telegram/Discord), MCP, cron, voice, concurrent
crews, auto-updater, release signing. None of these have stubs in the UI; when they arrive
they get a row here first.
