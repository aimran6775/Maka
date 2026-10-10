# Maka — notes for AI coding agents

Read `README.md`, `CODE_MAP.md` and `docs/BRAIN.md` before changing anything.
`docs/KICKOFF_BRIEF.md` is the phase 1 spec; `docs/DECISIONS.md` records choices made
where the brief was ambiguous.

## Hard rules

- **Sidecar:** Node core modules only (`node:*` and globals such as `fetch`). No runtime
  dependencies, ever. `package.json` `dependencies` stays `{}`.
- **Frontend:** vanilla JS ES modules served as static files. No build step, no bundler,
  no framework. It may import from `/shared/` only.
- **Shared contract:** `shared/events.js` is frozen and additive-only. Never rename or
  remove an event type or a required field. New fields are optional; new events are new
  entries.
- **Truthful telemetry:** the UI shows only what an event proved. No simulated progress,
  no fake spend, no placeholder activity. A feature that is not wired shows a plain
  "not wired" state.
- **Secrets:** never in the frontend, never in git. Keys come from `ANTHROPIC_API_KEY` /
  `OPENROUTER_API_KEY` or the 0600 keystore file (see `sidecar/providers/keys.js`).
- **Tests:** `node --test`. `npm run test:fast` runs `test/fast.list` and must be green
  before every push.
- **Docs:** keep `CODE_MAP.md` and `docs/BRAIN.md` true to what exists. Stubs are
  labelled as stubs in both the doc and the UI.
- **Provenance:** do not copy StarNet source wholesale. An adapted snippet is recorded in
  `NOTICE.md` with its origin.

## Layout of the repo

See `CODE_MAP.md`. Short version: `sidecar/` is the one Node process, `shared/` is the
event contract, `frontend/` is the canvas UI, `test/` holds the `node --test` suites.

## Conventions

- ES modules everywhere (`"type": "module"`); `.js` extension in every import.
- Pure core, injected edges: the loop, the capability gate and the store take their
  provider / clock / fetch / fs as arguments so tests use fakes.
- Every state transition in a run is an event validated against `shared/events.js`
  before it is emitted and again when the frontend receives it.
- Atomic persistence: write to a temp file, `fsync`, rename, `fsync` the directory.
