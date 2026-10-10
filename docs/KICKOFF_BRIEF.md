# Maka — kickoff brief for the first cloud session

## What Maka is
A local-first desktop harness where a user creates real AI agents, arranges them in a living
visual world, and watches them do real work with real models and tools. Modeled on StarNet
(github.com/androoAGI/starnet, MIT, by Andrew Sims) in concept and architecture, but built
from scratch under the name Maka. Do not copy StarNet source files wholesale; if a snippet is
borrowed, keep the MIT notice and say so in NOTICE.md.

## Product laws (carry these from StarNet, they are the point)
1. Truthful telemetry: the UI never asserts state the harness cannot prove. No simulated
   activity, spend, or progress.
2. Layout is the org: a room is a capability-scoped team, a placed object is a real tool grant.
   The world the user draws IS the workflow agents run.
3. Secrets live in the sidecar / OS keychain, never in the frontend.
4. Agents ask one concrete question instead of guessing silently.
5. Finished work lands as real files in an outbox, not chat scrollback.

## Stack (match StarNet so the model is proven)
- ONE Node process: `node sidecar/index.js` serves HTTP + SSE on a local port and the
  static frontend. Node core modules only in the sidecar; zero runtime deps.
- `frontend/`: vanilla JS, no build step, canvas-rendered world + windowed UI, dark-first.
- `shared/`: frozen event contract (`events.js`) + tiny schema validator. Additive-only.
- `src-tauri/`: Tauri 2 desktop shell, added in a later phase, not phase 1.
- Tests: `node --test`, a fast list that is the merge gate.

## Phase 1 scope (this session, in order; commit after each step)
1. Repo skeleton: README (concept + run from source), LICENSE (MIT), .gitignore, package.json
   with `start`, `test:fast`, CODE_MAP.md, docs/BRAIN.md orientation page, CLAUDE.md.
2. `shared/events.js` + `shared/schema.js`: agent.run.start / agent.token / agent.tool_call /
   agent.tool_result / agent.run.end / agent.run.error / cost.estimate / permission.prompt /
   permission.response / object.place / object.reclaim. Schema-validated both directions.
3. `sidecar/loop.js`: the agentic loop. Messages-array while-loop, tool calls accumulated by
   index, every tool_call paired with exactly one tool_result, guards before every paid call
   (cancelled / max turns / budget). Pure given injected provider, emit, clock, signal.
   Unit-tested with a fake provider.
4. `sidecar/providers/`: `provider.js` interface + `anthropic.js` + `openrouter.js`
   (streaming, tool use). Keys from env or a local keystore file with 0600 perms for now;
   keychain comes with Tauri.
5. `sidecar/capability/`: world layout → tool allowlist. Start with three tools: `fs.read`,
   `fs.write` (sandboxed to the agent workspace), `web.fetch`. A tool runs only if the
   agent's room has the matching object placed.
6. `sidecar/index.js`: routes `/api/run`, `/api/cancel`, `/api/layout`, `/api/events` (SSE),
   static frontend. Persist runs, transcripts, spend, layout to disk with
   fsync-before-rename atomic writes.
7. `frontend/`: canvas world with one room, one hero agent body that visibly changes state
   on real events (idle / thinking / tool-running / done / error), a build mode to place
   objects, a COMMS window with streaming output, a spend readout fed only by reconciled
   cost events, and a permission prompt card.
8. `test/fast.list` + runner; `npm run test:fast` green before every push.

## Not in phase 1
Tauri shell, channels (Telegram/Discord), MCP, cron, voice, multiple concurrent crew,
auto-updater, release signing. Leave stubs and TODO notes in CODE_MAP.md, not fake UI.

## Open decisions (defaults chosen; owner may override)
- World theme: StarNet uses a space station. Maka default: a workshop / atelier. Keep the
  renderer theme-agnostic (tile + prop definitions in data) so this can change.
- Default provider: Anthropic via API key, OpenRouter second.
- Port: 8790.

## Working rules
- Small reviewable commits on the designated branch, push after each milestone.
- Never commit keys; `.env*`, `*.key`, `secrets/` in .gitignore from commit 1.
- Keep CODE_MAP.md and docs/BRAIN.md true to what exists, nothing aspirational.
