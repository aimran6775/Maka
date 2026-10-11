# Release runbook (phase 3)

How to turn a tagged commit on `main` into a signed, notarized `Maka-<version>-aarch64.dmg`
on makapark.com with a working updater, from the owner's Mac. Every command below is
exact; the scripts under `scripts/release*.mjs` do the work and `npm run release:dry`
prints the sequence before anything runs. What was validated where:

| Where | What |
| --- | --- |
| Linux (this repository's CI, no Xcode) | `npm run test:fast` (212 tests incl. the release scripts in dry run, the Node bundling against a fake nodejs.org, the shell's config and icons), `npm run shell:check` (`cargo check --target aarch64-apple-darwin` of `src-tauri/` and the host tests of the credential store, the broker and the HTTP client), `npm run demo`, `npm run demo:phase4`, `node scripts/park-check.mjs` |
| The Mac (this runbook) | `cargo test` in `src-tauri/` (incl. the Keychain), the build, signing, notarization, the smoke launch, the clean-account launch, publishing, the updater |

## 0. One-time setup on the Mac

```bash
xcode-select --install                                   # Xcode command line tools (codesign, notarytool, stapler, hdiutil)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust; then open a new shell
rustup target add aarch64-apple-darwin
cargo install tauri-cli --version "^2.0" --locked        # `cargo tauri` (the pinned CLI; check: cargo tauri --version)
brew install node@22 || true                             # Node 22 on PATH for the dev loop and the scripts (node --version)
git clone https://github.com/aimran6775/Maka.git && cd Maka
npm run assets:check                                     # the vendored Three.js and the CC0 kits match the manifest
```

Signing and notarization identities (Apple Developer account, Developer ID):

```bash
# 1. The certificate: Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application,
#    or developer.apple.com → Certificates. It must be in the login keychain:
security find-identity -v -p codesigning | grep "Developer ID Application"
# 2. An app-specific password for the Apple ID: https://appleid.apple.com → Sign-In and Security → App-Specific Passwords.
# 3. Store the notarytool credentials once (the password is typed, never put in a file):
xcrun notarytool store-credentials maka-notary --apple-id "<apple id>" --team-id "<TEAMID>"
# 4. The updater key pair (the public half is committed, the private half never):
cargo tauri signer generate -w ~/.tauri/maka.key          # asks for a password; keep both safe
cat ~/.tauri/maka.key.pub > src-tauri/updater.pub && git add src-tauri/updater.pub && git commit -m "Updater public key"
```

The environment the scripts read (`scripts/release-lib.mjs` `SIGNING_ENV`), kept in a
file outside the repository, mode 600, and sourced before a release:

```bash
cat > ~/.maka-release.env <<'ENV'
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="<apple id>"
export APPLE_TEAM_ID="<TEAMID>"
export APPLE_PASSWORD="<app-specific password>"        # Tauri's bundler notarizes the .app with these three
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/maka.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<the key's password>"
export NOTARY_PROFILE=maka-notary                      # release-notarize.mjs prefers the stored profile for the .dmg
ENV
chmod 600 ~/.maka-release.env
```

None of these is read from a file in the repository, ever. `scripts/release-site.mjs`
needs nothing; publishing (step 5) needs a Cloudflare login.

## 1. Before the release

```bash
git checkout main && git pull --ff-only
npm run test:fast                                        # the merge gate; must be green
npm run demo                                             # the phase 2 chain against the fakes; must print DEMO OK
npm run demo:phase4                                      # the phase 4 chain against the fakes (brief, listing, ad set, Telegram, results, briefing); must print DEMO OK
npm run shell:check                                      # cargo check for Apple Silicon + the host tests
(cd src-tauri && cargo test)                             # the shell's unit tests, the Keychain included (a Keychain prompt may appear once)
node scripts/park-check.mjs                              # headless Chromium: the park and the first-run card; must print PARK CHECK OK
```

## 2. Bump and tag

```bash
node scripts/release-bump.mjs 0.2.0                      # package.json, src-tauri/Cargo.toml, Cargo.lock; commits "Release v0.2.0"; tags v0.2.0
git push --follow-tags origin main
git checkout v0.2.0                                      # the release is built from the tag
```

## 3. Build, sign, notarize, staple

```bash
source ~/.maka-release.env
npm run release:dry                                      # prints every command; read dist/release/plan.sh
npm run release -- --notes "What changed, one line."     # the real thing; 10–20 minutes, most of it Apple's notary service
```

What `npm run release` does, in order (`scripts/release.mjs`):

1. Checks `HEAD` is the tag `v<version>` and the tree is clean.
2. Gates: `npm run test:fast`, `npm run demo`, `npm run demo:phase4`, `npm run shell:check`.
3. `node scripts/release-node.mjs`: downloads `node-v22.22.0-darwin-arm64.tar.gz`, verifies it against nodejs.org's `SHASUMS256.txt`, writes `src-tauri/binaries/node-aarch64-apple-darwin`.
4. `scripts/release-build.mjs`: `cargo tauri build --target aarch64-apple-darwin --config dist/release/tauri.release.conf.json`; Tauri's bundler signs the shell and the Node binary (hardened runtime, `src-tauri/Entitlements.plist`) with `APPLE_SIGNING_IDENTITY`, notarizes the `.app` with `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` and staples it, builds the `.dmg`, and writes `Maka.app.tar.gz` + `.sig` signed with `TAURI_SIGNING_PRIVATE_KEY`. The overlay carries the updater endpoint and the public key from `src-tauri/updater.pub`.
5. `scripts/release-notarize.mjs`: `xcrun notarytool submit <dmg> --keychain-profile maka-notary --wait`, `xcrun stapler staple`, `stapler validate`, `spctl --assess --type open --context context:primary-signature -v <dmg>`, `codesign --verify --deep --strict --verbose=2 <app>`, `spctl --assess --type execute -vv <app>`.
6. `scripts/release-smoke.mjs`: launches `Maka.app/Contents/MacOS/Maka` with a fresh `MAKA_HOME`, checks `/api/state` (contract v1, first run, the Keychain broker), the park page and the vendored renderer are served from the bundle, SIGTERM stops the app and the sidecar.
7. `scripts/release-site.mjs`: `dist/site/` = `website/` + `releases/latest.json` (updater) + `releases/download.json` (page) + `SHA256SUMS` + the `.dmg`, the `.app.tar.gz` and its `.sig`.

Outputs: `dist/release/Maka-0.2.0-aarch64.dmg`, `Maka-0.2.0-aarch64.app.tar.gz`, `.sig`,
`plan.sh`, `summary.json`; `dist/site/`. If a step fails, fix and rerun `npm run release`;
notarization of an already notarized file is accepted at once.

## 4. The clean-account launch (manual, once per release)

A fresh macOS user has no Maka data, no Keychain items, no Ollama, no Chromium: what a
new owner sees.

```bash
sudo sysadminctl -addUser makasmoke -fullName "Maka Smoke" -password "<a password>" -admin  # once
open "dist/release/Maka-0.2.0-aarch64.dmg"              # it opens without a Gatekeeper warning
# Apple menu → Log Out → log in as makasmoke (fast user switching works too), then:
#   1. open the .dmg (Finder shows it at /Volumes/Maka), drag Maka to Applications, open it from Applications.
#      Expected: no "unidentified developer" dialog; the splash "Starting the sidecar…" then the park;
#      the menu bar shows "Maka"; the FIRST RUN card lists its four steps with "not wired" / "not reachable" lines.
#   2. Paste a test key in step 2: expected "stored and verified". Open Keychain Access → login → search "com.makapark.maka":
#      one item named ANTHROPIC_API_KEY... (the name the broker was given, `anthropic`).
#   3. Close the window: the park hides, "Maka" stays in the menu bar; click "Open the park": it is back.
#   4. Menu bar → Quit Maka: `pgrep -fl "sidecar/index.js"` prints nothing.
#   5. Menu bar → "Start at login" → log out and in: Maka is running.
# Back on the owner's account:
sudo sysadminctl -deleteUser makasmoke                   # when done (removes the home too)
```

Record the outcome in the release notes; a failed expectation blocks the publish.

### Voice (phase 4 step 14), on the Mac

The shell's voice (`src-tauri/src/voice.rs`) is type-checked for Apple Silicon from Linux
but the frameworks only run here. In the dev loop (`cargo tauri dev`) and once in the built
app, verify:

1. The first "hold to talk" shows the macOS dialogs for the microphone and for speech
   recognition with Maka's two sentences (`src-tauri/Info.plist`); deny one and the bar
   says which setting to change (System Settings → Privacy & Security).
2. With both allowed, holding the button and speaking fills the transcript box on release,
   with Wi-Fi off (recognition is on-device; `voice_status` reports `on_device: true`). A
   locale the Mac cannot recognise on the device makes `voice_status` say so and listening
   is refused rather than sent off the device.
3. `voice: on` then approve or raise a Gate item: the sentence is spoken by the system
   en-US voice; `voice: off` cuts it mid-sentence.
4. The page is served from `http://127.0.0.1:<port>`: the capability's remote origin
   (`src-tauri/capabilities/default.json`) must let `window.__TAURI__.core.invoke('voice_status')`
   succeed from the park page; if Tauri refuses the pattern, the bar falls back to the
   browser path and says so, and the pattern needs adjusting.
5. Record the outcome in the release notes; a failed expectation blocks the publish.

### Renderer (phase 4 step 15), on the Mac

Headless Chromium on Linux cannot present WebGPU to a canvas, so the WebGPU path is verified
here only up to its first frame and the fallback after it. In the dev loop and once in the
built app, verify:

1. In the app's webview the status line says `park: webgpu` when the Mac's WebKit offers
   WebGPU (macOS 26 and later), else `park: webgl2 (…)` with the reason; either is
   acceptable, a wrong or missing word is not.
2. With the backtick key the overlay shows draw calls above zero and frame medians on both
   renderers (`?renderer=webgl2` forces the other); record the median between frames on the
   default park and on `?density=3` with a crew of ten. The 60 fps target holds when the
   default park's median is at or under 16.7 ms; a miss goes into the release notes with
   the numbers.
3. Orbit out until trees turn flat-shaded and lose their shadows, then further until they
   disappear into the fog; Rangers far away keep standing where they stand.
4. `node scripts/park-check.mjs` and `--webgpu` pass against the dev sidecar on the Mac
   (Chrome's WebGPU, not SwiftShader); `--webgpu` should print `webgpu drew the park OK`.
5. Record the outcome in the release notes.

### Computer control (phase 4 step 18), on the Mac

`src-tauri/src/computer.rs` is type-checked for Apple Silicon from Linux and its pure part
(the sensitive list, chords, the locate matcher) runs in the host tests, but Accessibility,
CGEvent, the display capture, the banner and the hotkey only run here. In the dev loop and
once in the built app, verify:

1. With a Control desk placed and `computer_control` raised to Draft at the Gate, a Ranger's
   first `computer.screenshot` makes macOS ask for Screen Recording and the first
   `computer.locate` for Accessibility (System Settings → Privacy & Security); until granted
   the action fails with the setting named and `/api/computer` shows the permission false.
2. With both granted: the banner window ("A Maka Ranger is driving this Mac · ⌃⌥⌘H halts
   it") appears at the top left when the first action runs and goes when the run ends; the
   trace folder holds a before and an after PNG per action and the PNG opens.
3. `computer.locate` on Finder or TextEdit returns nodes with sensible frames; a
   `computer.click` at a match's centre lands on it; `computer.type` types into a TextEdit
   document; `computer.key` with `cmd+s` opens its save sheet.
4. Bring Terminal (or System Settings) to the front: the next action raises a handoff, the
   Ranger's card shows it, nothing is typed; `computer.focus` on Terminal is refused.
5. Press ⌃⌥⌘H while a Ranger drives: the banner goes at once, `/api/computer` says halted
   by the hotkey, the next action is refused HALTED, Resume at the Peak lifts it. The hotkey
   registers at launch (a failure prints `maka: halt hotkey not registered` and the Peak's
   Halt button is the fallback).
6. Record the outcome in the release notes; a failed expectation blocks the publish.

## 5. Publish to makapark.com

The site is static: `dist/site/` is the whole thing. Cloudflare Pages (the domain is on
Cloudflare; one-time `npx wrangler@3 login` and a Pages project `makapark` with the custom
domain `makapark.com`):

```bash
npx wrangler@3 pages deploy dist/site --project-name makapark --commit-dirty=true
curl -sS https://makapark.com/releases/latest.json | head -c 400 && echo
curl -sS https://makapark.com/releases/download.json
curl -sSLo /tmp/Maka.dmg "$(python3 -c 'import json,sys;print(json.load(sys.stdin)["dmg"]["url"])' < <(curl -sS https://makapark.com/releases/download.json))"
shasum -a 256 /tmp/Maka.dmg                              # equals download.json's sha256 and dist/site/releases/SHA256SUMS
```

The page (`website/index.html`) is version-free and reads `releases/download.json`; the
app's updater reads `releases/latest.json` (the endpoint in `tauri.release.conf.json`).
Keep every previous `.dmg` and `.app.tar.gz` under `releases/` (the deploy uploads the
whole directory; older files already there stay unless removed).

## 6. The updater, end to end

From the previous version installed on the clean account (or the owner's): launch Maka,
menu bar → the updater line reads "Checking for updates…" then "Update to 0.2.0
available: install and relaunch"; click it; Maka downloads `Maka-0.2.0-aarch64.app.tar.gz`,
verifies the minisign signature against `updater.pub`, installs and relaunches; the line
then reads "Up to date (0.2.0)". A signature that does not verify is refused by the
updater plugin and the line says "Update failed".

## 7. Rollback

Re-upload the previous release's `latest.json` and `download.json` (kept in the previous
`dist/site/releases/`, or re-run `node scripts/release-site.mjs` on the previous tag with
its artifacts); the `.dmg` files stay. The app does not downgrade itself.

## 8. The dev loop on the Mac

```bash
cargo tauri dev --config src-tauri/tauri.conf.json       # from the repo root: the shell over `node` on PATH and this checkout
MAKA_HOME=/tmp/maka-dev cargo tauri dev                  # a scratch data directory; MAKA_PORT=8790 pins the port
```

Dev builds have no updater config (the tray says so) and sign ad hoc; they are never
distributed.
