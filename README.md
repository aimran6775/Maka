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

## Run from source

Requires Node 22+. No dependencies to install.

```bash
ollama serve                          # local worker models (any tool-capable model pulled)
export ANTHROPIC_API_KEY=sk-ant-...   # the judge; or OPENROUTER_API_KEY; or the keystore below
npm start                             # node sidecar/index.js
```

Then open <http://127.0.0.1:8790>. Routine turns run on the local worker model (Ollama at
`OLLAMA_HOST`, default `http://127.0.0.1:11434`, model `OLLAMA_MODEL` or the first installed).
Claude via the Anthropic API is the judge tier; the judge step itself lands in phase 2.
Without Ollama running, a default run answers `400 OLLAMA_UNREACHABLE`; without a key, an
explicit Anthropic or OpenRouter run answers `400 NO_KEY`. The UI shows each provider as
wired, not wired, reachable or not reachable. Nothing is simulated.

Local models are smaller than Claude and must support tool calling (`ollama show <model>`
lists it). The judge pattern catches errors; it does not make a weak worker strong.

Environment: `PORT` (8790), `HOST` (127.0.0.1), `MAKA_HOME` (`./.maka`, data and keystore),
`MAKA_WORKSPACE` (`./workspace`, one directory per agent; deliverables land in `outbox/`).

Keystore alternative to env vars: `$MAKA_HOME/keystore.json` containing
`{ "anthropic": "sk-ant-...", "openrouter": "..." }` with file mode `0600`. The sidecar
refuses to read a keystore with looser permissions.

## What you can do in phase 1

The park has one zone (the Ranger Station) and one Ranger. In BUILD, place a Supply cache
(grants `fs.read` and `fs.write` in the Ranger's own workspace) or a Trailhead sign (grants
`web.fetch`). In COMMS, write a brief and run it; tokens stream in, tool calls show their
input and result, and each turn says which model ran it and what it cost. A file write stops
at the Entrance Gate card until you allow or deny it; the Ranger waits with a raised hand.
Deliverables land in `workspace/<ranger>/outbox/`. SPEND shows reconciled cost only.

Phase 2 (business crew, connectors, leash enforcement, judge step, Lookout Tower) and
phase 3 (macOS app) are described in the brief and are not in this build.

```bash
npm run test:fast   # the merge gate
npm test            # everything under test/
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
