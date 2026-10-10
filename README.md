# Maka

A local-first desktop harness where you create real AI agents, arrange them in a living
visual world, and watch them do real work with real models and tools.

Maka is modeled on the concept and architecture of
[StarNet](https://github.com/androoAGI/starnet) (MIT, Andrew Sims) and built from scratch.

Product laws:

1. **Truthful telemetry.** The UI never asserts state the harness cannot prove.
2. **Layout is the org.** A room is a capability-scoped team; a placed object is a real tool grant.
3. **Secrets stay in the sidecar.** Never in the frontend.
4. **Ask, don't guess.** Agents turn ambiguity into one concrete question.
5. **Finished work has a front door.** Deliverables land as real files in an outbox.

Status: pre-alpha. See [docs/KICKOFF_BRIEF.md](docs/KICKOFF_BRIEF.md) for the phase 1 plan.

## Run from source

```bash
node sidecar/index.js
```

Then open <http://localhost:8790>. (Not yet implemented.)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
