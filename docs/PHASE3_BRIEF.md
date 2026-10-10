# Maka — Phase 3 brief: the macOS app

Prerequisite: phase 2 on main and green. Read the same docs first.

1. Tauri 2 shell in `src-tauri/`: bundles Node (or uses a sidecar binary built with Node's
   single-executable-application support) and the repo's `sidecar/` + `frontend/`; opens
   one window on the park; menu bar item with the Gate queue count and Away toggle; login
   item option so Maka starts at boot and runs 24/7.
2. Keychain: Rust `credentials.rs` owns all secrets (ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
   FASTMAIL_API_TOKEN, RESEND_API_KEY, CLOUDFLARE_*, R2_*, connector tokens) and hands the
   sidecar a session-scoped handle; the 0600 keystore file becomes a dev-only fallback.
3. First run: pick the workspace root (default the LaCie if mounted), paste or sign in for
   the judge key, detect Ollama and offer to pull a model sized to free memory, the Chief
   Ranger is already at the Peak, ask for the mission. Ten minutes to a working crew.
4. Ollama management: detect, install prompt, model pull with progress, memory headroom
   diagnostics; the router degrades honestly when the worker is unavailable.
5. Offsite backup: scheduled encrypted snapshots of `<root>/_peak`, ledgers, mail store and
   deliverables to Cloudflare R2, under the Superintendent's control; restore path tested.
6. Signing and notarization with the owner's Apple Developer ID (Developer ID Application
   certificate; `notarytool`); universal or arm64 .dmg; release script produces the .dmg,
   `latest.json` for the Tauri updater, and a download page for makapark.com (static
   files under `website/`). Secrets for signing come from the environment, never the repo.
7. Release gates: test:fast, the phase 2 demo, a smoke launch of the built app under a
   clean user account, a checked `docs/RELEASE_RUNBOOK.md`.
When done, send the parent session a summary.
