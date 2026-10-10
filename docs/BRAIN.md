# BRAIN — orientation

Start here if you are new to the codebase. This page says how Maka is shaped and where to
read next. It describes only what is on disk; `CODE_MAP.md` is the authoritative file list.

## The shape

```
browser (frontend/, vanilla JS, canvas)
   │  HTTP + SSE, JSON events validated against shared/events.js
   ▼
sidecar (one Node process, no dependencies)
   ├─ chief       mission → plan (schema-checked) → hire → delegate; follow-ups on work.done
   ├─ reflect     daily and on budget breach: actuals per venture → document + briefings
   ├─ mail        Resend in and out, routed to stations by address rules, stored locally
   ├─ runs        N runs at once, one per Ranger, queued past the cap
   ├─ trails      work items between zones: handoff → receiver run → done
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
   object that grants it (or the agent's role grants it, for crew tools). The user builds
   the org by placing things; the layout's agents ARE the agent records.
3. **Pure core, injected edges.** Loop, gate and store are plain functions over injected
   provider / clock / signal / fs so they are tested with fakes and the real HTTP paths
   stay small.

## Current state

Phase 2 step 10 done: the mail system's store and transport. Station addresses exist as
routing rules the moment the park boots (peak@, rangers@, visitors@, the camps, gate@ for
the Superintendent, unsubscribe@), Ranger aliases are rules too, and unknown recipients
land in visitors@ for triage. With `RESEND_API_KEY` wired the sidecar polls Resend's
receiving API every minute after a persisted cursor (and takes the `email.received`
webhook when `RESEND_WEBHOOK_SECRET` is set), downloads attachments, threads messages
and stores them under `<root>/_mail/`; delivery webhooks mark sent copies and a hard
bounce or a complaint suppresses the address; a reply to unsubscribe@ suppresses the
sender. `send()` is the mechanics only (suppression, thread headers, campaign footer);
step 11 decides who may send what.

Phase 2 step 9 done: the mail domain's DNS. With `RESEND_API_KEY` and
`CLOUDFLARE_API_TOKEN` wired, "Plan DNS" on the Peak (or `POST /api/mail/dns/plan`) asks
Resend for makapark.com's records, adds DMARC, diffs them against the Cloudflare zone and
shows what would change; "Apply DNS" parks the write at the Entrance Gate as an
`account_settings` item with the diff as evidence, and only an approval registers the
domain at Resend if needed, writes the records and asks Resend to verify. Tested against
fake Cloudflare and Resend servers; `docs/LIVE_TEST.md` will carry the live sequence.

Phase 2 step 8 done: away mode. "I'm away" on the Peak card (or `POST /api/away`) turns
on the evidence log: every Gate decision and the other notable events are appended to
`<root>/_peak/away-log.ndjson`, Gate items are stamped `away`, and the Peak shows "Away
since …, N actions, M waiting". "I'm back" writes a digest (counts by status, domain and
Ranger, what still waits, work done, spend, notable events) next to the log, emits
`away.digest`, and will mail gate@ once the mail system exists. Part A of phase 2 is done.

Phase 2 step 7 done: the park shows the crew. Department camps, the Visitor Center (made
at boot) and a trailhead per venture (made when the Chief submits a plan) are rooms in the
layout, drawn as clearings dressed per kind; trails run hub-and-spoke through the Ranger
Station plus trailhead ↔ the camps serving that venture, and a walk between any two zones
is one or two legs. Every agent has a body cloned from the rigged template with its role's
tint and size (the Chief gold on the Peak, Juniors small), a name and a state badge; the
receiver walks the route after a `work.handoff`, and walks its deliverable to the Visitor
Center after a `work.done` with files. Panels: Ranger (brief / pause / reassign, spend vs
budget, work items), zone (roster, budget burn, editable leash defaults, queue), trail
(items in transit), Gate (approve / revise / reject), Peak (portfolio). The headless check
is `scripts/park-check.mjs`.

Phase 2 step 6 done: the reflection cycle. A persisted cron-like scheduler runs the
reflection daily (`reflectAt`, 07:00 by default) and a budget watcher runs it when a
venture or the mission crosses 100 % of its model-spend budget (80 % and 100 % are
`budget.threshold` events). The reflection gathers only recorded facts per venture, asks
the Chief's model for a JSON document, grounds every morale note in a number, stores the
document, writes it to the Chief's outbox and a briefing to each department's notes
store, emits `reflection.posted`, and hands the Chief a follow-up to revise the plan. At
the judge cap it is recorded as skipped with the reason.

Phase 2 step 5 done: Chief Ranger planning. `POST /api/mission` (or the form on the
Peak card) gives the Chief a mission with a budget and horizon; the Chief runs on the
judge tier's planning model and must call `plan.submit` with a schema-checked plan
(ventures, roles, tasks, budgets, risks, what needs the owner), then `crew.hire` to staff
department camps (created on demand) and `delegate` to start tasks. Every version is
stored and written to the Chief's outbox; `plan.updated` keeps the Peak current; a
finished delegated item brings the Chief back for a bounded follow-up. The judge daily
cap and a per-mission follow-up cap pause the mission rather than spend past them.

Phase 2 step 4 done: concurrency and handoffs. The run manager runs several Rangers at
once (one run per Ranger, a global cap from `config.json`), queues the rest in arrival
order and announces a queued run with `agent.run.queued`. `sidecar/trails.js` turns a
delegation (the `delegate` tool, or `POST /api/work` from the Superintendent) into a
persisted work item, a `work.handoff` along the trail between the two zones, and a run
for the receiver briefed from the item; when that run ends, `work.done` names the files
that appeared in the receiver's outbox. `work.check` lets the delegator read the result.

Phase 2 step 3 done: agents and the hierarchy. `sidecar/agents.js` owns agent records
(the layout's agent entries, now with venture, specialty, persona, per-agent worker
policy and budget), the Chief Ranger singleton at a `mountain_peak` room created at boot,
the parent rules (Rangers under the Chief, Juniors one hop under a Ranger), per-agent
leash overrides, and `/api/agents` CRUD. Rangers get the `crew.spawn_junior` tool by
role. Runs carry the agent's persona in the system prompt. Only one run at a time still
(step 4), and the park still draws one body (step 7).

Phase 2 step 2 done: the judge step. `sidecar/judge.js` supplies the loop's review hook:
before a worker's tool calls in a non-research domain at Act with cap / Act freely, and
before every run ends, Claude (`claude-sonnet-5-5` by default) answers approve / revise /
reject with notes; revise and reject go back to the worker as its next turn (bounded).
Each judge call is a `judge.verdict` plus a `cost.estimate { tier: 'judge' }`, counted in
the ledger against a 10 USD daily cap; at the cap, without a key, or on a failed call the
verdict is `skipped` and the action falls back to the Gate as Draft for review.

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

### The judge (`sidecar/judge.js`)

A second model never rewrites the first. The judge sees the brief, what the worker said,
and the tool calls with their leash levels, and returns one JSON verdict. The loop turns a
revise / reject into error tool results (for actions) or a new user turn (for the closing
answer). The judge's cost is a reconciled cost event like any other, with `tier: 'judge'`,
so SPEND and the Peak show it; when the judge cannot run, the event says so.

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
4. `sidecar/router.js`, `sidecar/judge.js` and `sidecar/providers/` — which model runs and what it costs.
5. `sidecar/index.js` — how it is served and persisted.
6. `frontend/app.js` — how it is shown.
