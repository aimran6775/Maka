# Mac handoff: what the local Claude Code session takes over (2026-10-11)

You are a Claude Code session running on the owner's Mac inside this repository. The cloud
sessions that built Maka are finished; everything from here needs this machine. The owner
has granted full autonomy to build, test and fix; the only things they do themselves are
the human steps (approve at the Gate, log in to a site, press a Telegram button, type a
password). Decisions go in docs/DECISIONS.md; the stricter option wins on ambiguity; never
weaken a fix from docs/SECURITY_REVIEW_2026-10-10.md or docs/SECURITY_REVIEW_2026-10-11.md.

## State of the build
- main @ 3d98c21 or later. Phases 1-4 complete; two safety reviews, 26 rows, all fixed with
  regression tests. test:fast 356/356; demo, demo:phase4, park:check, release:dry green on
  Linux. Nothing in the tree is simulated; every "not wired" / "no data" state is real.
- Read first, in this order: CLAUDE.md, README.md ("Run the park"), CODE_MAP.md (the "Not
  built yet" list is exactly what is left), docs/BRAIN.md, docs/LIVE_TEST.md,
  docs/RELEASE_RUNBOOK.md, and the two security reviews.

## The owner's machine and decisions
- Apple Silicon Mac, 16 GB. Worker model: one ~7-8B at 4-bit (qwen3:8b suggested). Claude
  via the Anthropic API is the judge (claude-sonnet-5-5 review, claude-opus-5-5 Chief).
- Everything lives on the LaCie external drive: the repo, MAKA_HOME, MAKA_WORKSPACE, the
  Ollama models, browser profiles and backups. Suggested layout (adjust to the real mount):
    /Volumes/LaCie/Maka/repo        this checkout
    /Volumes/LaCie/Maka/home        MAKA_HOME (keystore, layout, ledgers, policy, config)
    /Volumes/LaCie/Maka/workspace   MAKA_WORKSPACE (one dir per Ranger, outboxes, mail store)
    /Volumes/LaCie/Maka/ollama      OLLAMA_MODELS
  The drive MUST be APFS or Mac OS Extended: the 0600 keystore is refused on exFAT/NTFS
  (no POSIX permissions). Check with `diskutil info /Volumes/LaCie | grep "File System"`.
  If it is exFAT and the owner chose to keep it (`--keep-exfat`), MAKA_HOME is on the
  internal disk at ~/Maka/home and the repo/workspace/models on the drive; build the Tauri
  app from a checkout on the internal disk (code signing needs xattrs that ExFAT handles
  badly): `git clone /Volumes/LaCie/Maka/repo ~/Maka/build` and release from there.
- Domain makapark.com on Cloudflare; mail on Resend only (receive + send). Applying mail
  DNS moves ALL mail for the domain to Resend: confirm with the owner that nothing else
  uses that domain's mail before applying.
- Secrets exist for: Anthropic, Hugging Face, Resend, Cloudflare (account token), R2. The
  owner pasted some into a chat earlier; treat those as exposed and offer to rotate. Keys
  go into the environment for the dev loop and into Keychain through the app's first-run
  card; never into files in the repo, never into chat.
- Caps: judge $10/day, money-out $0/day until raised at the Gate. Leashes start at Draft
  for everything except research; computer_control at Observe.

## Do this, in order
1. Environment: `node --version` (22+), Ollama installed and `ollama pull qwen3:8b` with
   OLLAMA_MODELS on the LaCie, a Chromium (Chrome is fine), `npm run assets:check`,
   `npm run test:fast`, `npm run demo`, `npm run demo:phase4`, `node scripts/park-check.mjs`.
   Fix anything that differs from Linux (paths, Chromium discovery, case-insensitive FS)
   with a test, commit, push.
2. The park in a browser from this checkout with MAKA_HOME and MAKA_WORKSPACE on the LaCie:
   README "Run the park". Confirm the renderer line (WebGPU on Safari/Chrome), the Peak's
   provider rows, and the LaCie offline/online pause by unmounting the drive.
3. docs/LIVE_TEST.md sections 1-3 against real Claude + Ollama (mission → plan → crew →
   a Ranger run with the judge → Gate → outbox → spend equals the priced events).
4. Section 16 (Telegram) so the owner can approve from their phone, including the
   negative checks (second user refused, group pairing refused).
5. Sections 4-6 (mail) after the domain confirmation above.
6. docs/RELEASE_RUNBOOK.md 0 → 1 → 2 → 3 → 4: Rust, Tauri CLI, the owner's Developer ID
   certificate (they type passwords), the signed and notarized .dmg, the clean-account
   launch, then the Mac-only checks in section 4 (voice, WebGPU frame and frame time,
   computer control at Observe then at a raised leash with the banner and ⌃⌥⌘H).
7. Publish (runbook 5-6) to makapark.com and prove the updater.
8. Connectors one at a time as the owner opens accounts (LIVE_TEST 8, 10-13, 15b-15n,
   17, 18), then the business loop: results after a day of real syncs, the Scout's first
   venture brief, a starter recipe, a supplier purchase that stops at the payment page.

## Rules that still hold here
- Commit per step with test:fast green; push to main; keep CODE_MAP / BRAIN / DECISIONS /
  README / LIVE_TEST / RELEASE_RUNBOOK true to what you verified on this Mac (move items
  from "verified only on the Mac" to verified, with the date).
- Sidecar stays dependency-free; Rust/Swift only in src-tauri/.
- Never paste or log a secret; if one appears in output, tell the owner and stop that path.
- When a step's "Expect" line does not happen, it is a real gap: fix it or record it.
