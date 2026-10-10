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
