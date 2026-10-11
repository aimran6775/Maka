# Notices

Maka is an original implementation inspired by StarNet
(https://github.com/androoAGI/starnet), Copyright (c) 2026 Andrew Sims, MIT License.
Any code adapted from StarNet is listed here with its origin.

- (none yet)

## Third-party frontend library

| Library | Version | License | Source |
| --- | --- | --- | --- |
| Three.js (the WebGL2 module build, `three.core.js`, the WebGPU build `three.webgpu.js` with `three.tsl.js` (loaded only when the park runs on WebGPU, phase 4 step 15), and the addons OrbitControls, GLTFLoader, FBXLoader, NURBSCurve, NURBSUtils, BufferGeometryUtils, SkeletonUtils, Sky, SkyMesh, fflate 0.8.2) | 0.186.1 | MIT (`frontend/vendor/three/LICENSE`; fflate carries its own MIT header) | https://registry.npmjs.org/three/-/three-0.186.1.tgz |

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
| Animated Characters Protagonists | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/animated-characters-protagonists | the Ranger body, idle and run clips, skater skin (`frontend/assets/characters/`) |
| Animated Characters Survivors | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/animated-characters-survivors | pinned and verified, nothing extracted yet |
| Ultimate Platformer Pack | Quaternius | CC0-1.0 (itch.io listing) | https://quaternius.itch.io/ultimate-platformer-pack | not fetched: itch.io has no stable direct URL to pin; listed as the brief's fallback rig |
| Leafy Grass (PBR texture, 1k) | Charlotte Baglioni (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/leafy_grass | the terrain's grass layer (`frontend/assets/polyhaven/`) |
| Forest Leaves 04 (PBR texture, 1k) | Rob Tuytel (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/forest_leaves_04 | the terrain's forest-floor layer |
| Rock Face (PBR texture, 1k) | Greg Zaal, Dario Barresi (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/rock_face | the terrain's cliff and peak layer |
| Sandy Gravel (PBR texture, 1k) | Charlotte Baglioni (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/sandy_gravel | the terrain's shore layer and the trails |
| Pine Bark (PBR texture, 1k) | Dimitrios Savva (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/pine_bark | the procedural trees' trunks |
| Boulder 01 (photoscanned model, 1k) | Rico Cilliers (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/boulder_01 | the park's rocks (`frontend/assets/polyhaven/boulder_01/`) |
| Grass Medium 02 (photoscanned model, 1k) | Rico Cilliers (Poly Haven) | CC0-1.0 (polyhaven.com/license) | https://polyhaven.com/a/grass_medium_02 | grass clumps near the camera (`frontend/assets/polyhaven/grass_medium_02/`) |

Poly Haven files are loose (no archive): each file's own SHA-256 is pinned in
`scripts/fetch-assets.mjs` and `frontend/assets/manifest.json`, and the md5 of every file
was checked against `api.polyhaven.com` when the pins were taken (2026-10-11).
`frontend/vendor/three/textures/waternormals.jpg` (the lake's normal map) comes from the
three.js repository at tag r186 (MIT), pinned the same way: the npm tarball ships no
example textures.

The brief's "Animated Characters 1 and 3" correspond to Kenney's current pack names
Protagonists and Survivors; both ship binary FBX (model plus separate animation files), not
glTF, which is why FBXLoader is vendored.

Kenney's Nature Kit and Survival Kit were vendored for the park's first look and removed
with it (D166): every station, gate and fixture piece is now built from primitives in
`frontend/park/render.js` at real size, in timber, canvas and stone, so there is nothing
to attribute for them. The crew still comes from Kenney's character packs.

The 2D pixel-art packs vendored for the superseded 2D park (Kenney Tiny Town, Shade Puny
Characters) were removed with that park.
