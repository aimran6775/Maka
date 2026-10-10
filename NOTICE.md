# Notices

Maka is an original implementation inspired by StarNet
(https://github.com/androoAGI/starnet), Copyright (c) 2026 Andrew Sims, MIT License.
Any code adapted from StarNet is listed here with its origin.

- (none yet)

## Third-party frontend library

| Library | Version | License | Source |
| --- | --- | --- | --- |
| Three.js (module build, `three.core.js`, and the addons OrbitControls, GLTFLoader, FBXLoader, NURBSCurve, NURBSUtils, BufferGeometryUtils, SkeletonUtils, Sky, fflate 0.8.2) | 0.186.1 | MIT (`frontend/vendor/three/LICENSE`; fflate carries its own MIT header) | https://registry.npmjs.org/three/-/three-0.186.1.tgz |

Vendored under `frontend/vendor/three/` by `scripts/fetch-assets.mjs`, which verifies the
tarball's SHA-256 before extracting; per-file hashes are in `frontend/assets/manifest.json`.

## Bundled runtime (the macOS app)

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Node.js (the official `darwin-arm64` binary, bundled as the sidecar's runtime by `scripts/release-node.mjs`, verified against nodejs.org's `SHASUMS256.txt`; never committed) | 22.22.0 (`scripts/release-lib.mjs` `NODE_VERSION`) | MIT (https://github.com/nodejs/node/blob/main/LICENSE; the binary embeds V8, ICU, OpenSSL and others under their own licenses listed there) | https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz |

The Rust crates of the shell (`src-tauri/Cargo.toml`, pinned; `Cargo.lock` for the rest)
are MIT / Apache-2.0 / MPL-2.0 licensed open source from crates.io, compiled into the
shell on the owner's Mac; `cargo tree --manifest-path src-tauri/Cargo.toml` lists them.

## Art assets

Vendored model files live under `frontend/assets/<pack>/` and are produced by
`scripts/fetch-assets.mjs`, which downloads each archive from its official URL, verifies the
pinned SHA-256, and extracts only the files listed in `frontend/assets/manifest.json`. All
packs are CC0 (Creative Commons Zero); credit is given here because it is appreciated,
not required.

| Pack | Author | License | Source | Used |
| --- | --- | --- | --- | --- |
| Nature Kit | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/nature-kit | trees, rocks, sign, campfire, fences, tent (`frontend/assets/nature-kit/`) |
| Survival Kit | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/survival-kit | station structure, tent, campfire pit, signpost, chest, box, fence pieces and their colormap (`frontend/assets/survival-kit/`) |
| Animated Characters Protagonists | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/animated-characters-protagonists | the Ranger body, idle and run clips, skater skin (`frontend/assets/characters/`) |
| Animated Characters Survivors | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/animated-characters-survivors | pinned and verified, nothing extracted yet |
| Ultimate Platformer Pack | Quaternius | CC0-1.0 (itch.io listing) | https://quaternius.itch.io/ultimate-platformer-pack | not fetched: itch.io has no stable direct URL to pin; listed as the brief's fallback rig |

The brief's "Animated Characters 1 and 3" correspond to Kenney's current pack names
Protagonists and Survivors; both ship binary FBX (model plus separate animation files), not
glTF, which is why FBXLoader is vendored.

The 2D pixel-art packs vendored for the superseded 2D park (Kenney Tiny Town, Shade Puny
Characters) were removed with that park.
