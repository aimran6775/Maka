# Maka

A local-first macOS app where a crew of real AI agents, your Rangers, run an online business
for you. You supervise from a living national park whose layout is the org chart and the
permission model.

Maka is modeled on the concept and architecture of
[StarNet](https://github.com/androoAGI/starnet) (MIT, Andrew Sims) and built from scratch.

Product laws:

1. **Truthful telemetry.** The UI never asserts state the harness cannot prove.
2. **Layout is the org.** A room is a capability-scoped team; a placed object is a real tool grant.
3. **Secrets stay in the sidecar.** Never in the frontend.
4. **Ask, don't guess.** Agents turn ambiguity into one concrete question.
5. **Finished work has a front door.** Deliverables land as real files in an outbox.
6. **No outcome promises.** Maka shows what the agents did and what it cost, never what they will earn.
7. **Platform-compliant by construction.** Connector actions go through official APIs under each platform's terms.
8. **Replicate strategies, not property.** Rangers build original listings, copy and creative.
9. **Money out passes the Entrance Gate.** Always, under the leash model, with a hard daily cap.

Status: pre-alpha. See [docs/KICKOFF_BRIEF.md](docs/KICKOFF_BRIEF.md) for the plan.

## Run the park

Requires Node 22+ and a browser with WebGL2 (Safari, Chrome, or the Tauri webview later).
No npm dependencies. Three.js and the CC0 model kits are vendored by a script that verifies
each archive's SHA-256 (see `NOTICE.md` and `frontend/assets/manifest.json`); they are
committed, so the step below is only needed after a clean checkout without them or to
reproduce them.

```bash
npm run assets                        # fetch + verify Three.js and the kits (network)
ollama serve                          # local worker models (any tool-capable model pulled)
export ANTHROPIC_API_KEY=sk-ant-...   # the judge; or OPENROUTER_API_KEY; or the keystore below
npm start                             # node sidecar/index.js
```

Then open <http://127.0.0.1:8790>. Orbit with the mouse, scroll to zoom, switch to fly or
follow with the buttons at the bottom, re-roll the terrain seed there too. Click the Ranger,
a zone, a fixture, the Entrance Gate or the Mountain Peak to inspect it. Routine turns run on the local worker model (Ollama at
`OLLAMA_HOST`, default `http://127.0.0.1:11434`, model `OLLAMA_MODEL` or the first installed).
Claude via the Anthropic API is the judge tier; the judge step itself lands in phase 2.
Without Ollama running, a default run answers `400 OLLAMA_UNREACHABLE`; without a key, an
explicit Anthropic or OpenRouter run answers `400 NO_KEY`. The UI shows each provider as
wired, not wired, reachable or not reachable. Nothing is simulated.

Local models are smaller than Claude and must support tool calling (`ollama show <model>`
lists it). The judge pattern catches errors; it does not make a weak worker strong.

Environment: `PORT` (8790), `HOST` (127.0.0.1), `MAKA_HOME` (`./.maka`, data and keystore),
`MAKA_WORKSPACE` (default `~/Maka/workspace`, or `workspaceRoot` in `$MAKA_HOME/config.json`;
one directory per Ranger, deliverables land in `outbox/`). The workspace root may live on an
external drive: when it is unmounted Maka pauses runs and shows "workspace offline", and
never writes anywhere else.

Keystore alternative to env vars: `$MAKA_HOME/keystore.json` containing
`{ "anthropic": "sk-ant-...", "openrouter": "..." }` with file mode `0600`. The sidecar
refuses to read a keystore with looser permissions.

## What you can do in phase 1

The park has one zone (the Ranger Station), the Entrance Gate, a trail between them and one
Ranger. In BUILD, pick a Supply cache (grants `fs.read` and `fs.write` in the Ranger's own
workspace) or a Trailhead sign (grants `web.fetch`) and click inside the station clearing to
place it. In COMMS, write a brief and run it; tokens stream in, tool calls show their input
and result, and each turn says which model ran it and what it cost. A file write stops at
the Entrance Gate card until you allow or deny it; the Ranger walks to the Gate and waits
there. Deliverables land in `workspace/<ranger>/outbox/`. SPEND shows reconciled cost only.
Every animation state maps to a real event; the sun follows your clock and encodes nothing.

## Phase 2 so far

Step 1, leash enforcement: every tool with a leash domain is checked against the leash
(per Ranger, per zone, or the park default; edit `$MAKA_HOME/leash.json` or `PUT /api/leash`).
At "Observe" the call is refused; at "Draft for review" it waits as a card at the Entrance
Gate until you approve, revise or reject it, and the Ranger stands at the Gate meanwhile;
at "Act with cap" it runs while the day's USD and action caps hold; at "Act freely" it
runs and is counted. Five approvals in a row raise a proposal card to loosen that Ranger
one level. Phase 1 tools fall under `research` (reads and fetches) or none (`fs.write`,
still confirmed per call); the money, mail and connector tools arrive in later steps.
The rest of phase 2 (`docs/PHASE2_BRIEF.md`) and phase 3 (macOS app) are not in this build.

```bash
npm run test:fast   # the merge gate
npm test            # everything under test/
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
