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
