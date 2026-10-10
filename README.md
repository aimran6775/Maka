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

Requires Node 22+. No dependencies to install.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENROUTER_API_KEY; or use the keystore below
npm start                             # node sidecar/index.js
```

Then open <http://127.0.0.1:8790>. Without a key the sidecar still runs and the UI shows the
provider as "not wired"; a run request answers `400 NO_KEY`.

Environment: `PORT` (8790), `HOST` (127.0.0.1), `MAKA_HOME` (`./.maka`, data and keystore),
`MAKA_WORKSPACE` (`./workspace`, one directory per agent; deliverables land in `outbox/`).

Keystore alternative to env vars: `$MAKA_HOME/keystore.json` containing
`{ "anthropic": "sk-ant-...", "openrouter": "..." }` with file mode `0600`. The sidecar
refuses to read a keystore with looser permissions.

```bash
npm run test:fast   # the merge gate
npm test            # everything under test/
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
