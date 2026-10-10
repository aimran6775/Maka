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
   ├─ capability  world layout → tool allowlist; a placed object is a tool grant
   ├─ providers   Anthropic, OpenRouter; streaming + tool use
   └─ store       atomic on-disk persistence (runs, transcripts, spend, layout)
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

Phase 1, step 1: repo skeleton only. There is no runnable sidecar yet. The README's run
instructions are marked not yet implemented and will be unmarked when `sidecar/index.js`
lands (step 6).

## Reading order once code exists

1. `shared/events.js` — the vocabulary.
2. `sidecar/loop.js` — the behaviour.
3. `sidecar/capability/` — the permission model.
4. `sidecar/index.js` — how it is served and persisted.
5. `frontend/app.js` — how it is shown.
