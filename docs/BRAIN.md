# BRAIN — orientation

Start here if you are new to the codebase. This page says how Maka is shaped and where to
read next. It describes only what is on disk; `CODE_MAP.md` is the authoritative file list.

## The shape

```
browser (frontend/, vanilla JS, canvas)
   │  HTTP + SSE, JSON events validated against shared/events.js
   ▼
sidecar (one Node process, no dependencies)
   ├─ loop        the agentic while-loop; every transition is an event
   ├─ capability  world layout → tool allowlist; a placed object is a tool grant;
   │              the leash decides whether a granted action runs, waits at the Gate,
   │              or is refused
   ├─ gate-queue  the Entrance Gate: items waiting on the Superintendent, decisions,
   │              loosening proposals; leash-ledger counts the day's actions and money
   ├─ providers   Anthropic, OpenRouter, Ollama; streaming + tool use
   └─ store       atomic on-disk persistence (runs, transcripts, spend, layout, leash,
                  ledger, gate items)
```

Three ideas carry everything:

1. **Events are the only truth.** The loop emits events; the store persists them; the
   frontend renders them. Nothing in the UI changes without an event, and every event is
   schema-checked by both sender and receiver.
2. **Layout is permission.** A tool is callable only when the agent's room contains the
   object that grants it. The user builds the org by placing things.
3. **Pure core, injected edges.** Loop, gate and store are plain functions over injected
   provider / clock / signal / fs so they are tested with fakes and the real HTTP paths
   stay small.

## Current state

Phase 2 step 1 done: leash enforcement. Every tool with a leash domain now goes through
`resolveLeash` (agent override → zone default → park default) in the capability gate:
Observe refuses, Draft for review parks the call as a `gate.item` until the Superintendent
approves / revises / rejects it at the Gate (`POST /api/gate/:id`), Act with cap runs
while the ledger's daily USD and action caps hold, Act freely runs and is counted. Five
approvals in a row raise a proposal to loosen that Ranger one level; approving it writes
an agent override into `leash.json`. The park shows the queue as cards and on the Gate,
Ranger and Peak inspector panels, and a Ranger whose run is parked stands at the Gate.

Phase 1 (done): the first slice of the 3D park. `npm run assets` vendors Three.js
and the CC0 kits (hash-verified), `npm start` serves the park: seeded terrain with a river,
sky and sun from the real clock, instanced forest, the Ranger Station clearing with its
building, the Entrance Gate clearing with its gate, a trail between them, one animated
Ranger whose clip and place follow real run state, the Mountain Peak as a raised control
centre with a phase 1 panel, orbit / fly / follow cameras, click to inspect, build mode by
clicking inside a clearing, and the DOM panels (COMMS, SPEND, BUILD, INSPECT, Gate cards).
The workspace root is configurable and may vanish (external drive): the sidecar then
pauses runs and the page says "workspace offline". Everything shown comes from sidecar
events and GET endpoints.

### The event contract (`shared/events.js`)

An event is `{ v, id, type, ts, seq?, payload }`. Payload schemas are strict
(`additionalProperties: false`) so a typo is a validation failure, not silent data loss.
`cost.estimate.reconciled` is the single flag the spend readout trusts: a cost event is
reconciled only when the token counts came from the provider's own usage report and the
model has a known price.

### The leash (`shared/leash.js`, `sidecar/capability/gate.js`, `sidecar/gate-queue.js`)

A tool declares a domain (`tool.domain` or `TOOL_DOMAINS`). The gate resolves the agent's
level for it and either runs the tool, refuses it, or submits a Gate item and awaits the
decision with the tool call parked (no provider call is in flight, so waiting is free).
The ledger (`sidecar/leash-ledger.js`) is the only counter of "what ran today" per domain,
and the only source for the daily caps. Everything the Gate decides is a `gate.item` event
with the same `itemId` across its status changes.

### The loop (`sidecar/loop.js`)

One turn = one provider call + the tool calls it asked for. Before every provider call the
loop checks, in order: cancelled, max turns reached, spend at or over budget. The provider
streams normalized chunks (`text_delta`, `tool_use_start`, `tool_input_delta`,
`message_end`); the loop accumulates them by content-block index, then answers every
`tool_use` block with exactly one `tool_result`, even for a thrown tool, unparsable input
JSON, or a cancel that lands between two tool calls. Spend only counts reconciled cost, so
an unpriced model cannot be budget-capped (the UI shows its tokens as unreconciled).

## Reading order once code exists

1. `shared/events.js` — the vocabulary.
2. `sidecar/loop.js` — the behaviour.
3. `sidecar/capability/`, `shared/leash.js`, `sidecar/gate-queue.js`, `sidecar/leash-ledger.js` — the permission model.
4. `sidecar/router.js` and `sidecar/providers/` — which model runs and what it costs.
5. `sidecar/index.js` — how it is served and persisted.
6. `frontend/app.js` — how it is shown.
