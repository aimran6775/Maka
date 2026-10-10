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

## D7. Raw `fetch`, not the official SDKs

The brief requires zero runtime dependencies in the sidecar, so both providers are small
hand-written HTTP adapters over the documented streaming endpoints. The surface they use
is deliberately minimal (one POST, SSE parsing, tool blocks). If the dependency rule is
ever relaxed, swapping in `@anthropic-ai/sdk` is confined to `providers/anthropic.js`.

## D8. Default Anthropic model is `claude-opus-5-5`; `thinking` is left to the model default

Opus 5.5 runs adaptive thinking by default and rejects explicit disable/budget settings,
so the adapter sends no `thinking` parameter. Thinking blocks come back with empty text and
a signature; they are stored verbatim in the transcript and replayed, as the API requires.

## D9. OpenRouter cost is taken from the provider, not a local table

OpenRouter returns `usage.cost` for each request when asked. That number is the
provider's own figure, so the adapter forwards it and the loop marks the turn reconciled.
The OpenRouter default model (`anthropic/claude-sonnet-4.5`) is a placeholder that was not
verified against the live catalog in this environment; the UI lets the user set the model.

## D10. A `refusal` stop reason ends the run as `completed`

The run-end reason enum is frozen at four values. A safety refusal from the provider is an
HTTP 200 with no tool calls, so the loop ends the run normally with whatever text came
back. The stop reason is not surfaced as a distinct state in phase 1.

## D11. Permission prompts are per-call confirmation for side-effecting tools

The brief lists `permission.prompt` / `permission.response` without saying what triggers
them. Placement is the grant (layout is the org); the prompt is a second, per-call check
for tools that change the world. In phase 1 only `fs.write` has `confirm: true`. `fs.read`
and `web.fetch` run without a prompt once granted. A prompt with no answer is a denial.

## D12. Workshop object kinds: bookshelf, workbench, window

One kind per tool so the grant is legible on the canvas: bookshelf → `fs.read`,
workbench → `fs.write`, window → `web.fetch`. The mapping is data in `shared/world.js`;
sprites are theme data in the frontend.

## D13. `web.fetch` allows any http(s) host

Maka is local-first and the user is the only principal, so there is no SSRF boundary to
defend in phase 1. Non-http schemes are refused, the method is GET only, and responses are
capped and timed out.

## D14. The run record is the event list

`runs/<runId>.json` stores the run's metadata, every event with its `seq`, and the final
messages array. There is no separate transcript format: what the UI showed is what is on
disk. Token events are flushed on a short debounce; everything else flushes immediately.

## D15. The sidecar binds to 127.0.0.1 and has no authentication

Phase 1 is a local tool for one user. `HOST` can widen the bind, but nothing on the API
is protected, so it should not be. Auth is a prerequisite for channels (not phase 1).

## D16 (pending). World theme changes from workshop to park

An owner decision relayed mid-session: the world is a park. A room is a park zone (lawn,
greenhouse, shed, kiosk, pond, bandstand), a hallway is a path, a placed object is a park
fixture granting a capability (notice board → web fetch, toolshed → filesystem, kiosk →
outbox), the hero agent is a groundskeeper. Internal event and module names do not change;
this is copy plus the default prop/tile data set. Not yet applied: work was halted before
the change could be made, pending the owner's answers to scoping questions.

## 2026-10-10 — owner scoping decisions
- Platform: macOS app, local-first, Tauri 2 shell over the Node sidecar. Apple Silicon first.
- Theme: NATIONAL PARK. User = Superintendent, agents = Rangers, zones/trails/fixtures as in
  docs/KICKOFF_BRIEF.md. Theme data stays swappable.
- Mission: autonomous operation of online businesses. Revenue and spend shown only from real
  connected sources; no projections; no income promises in copy.
- Autonomy: per-domain leash levels (Observe / Draft for review / Act with cap / Act freely),
  earned loosening, hard daily cap on money out, away mode with a full evidence log.
- First vertical (assumed, to confirm): e-commerce store ops with Shopify + Stripe.
