# Notices

Maka is an original implementation inspired by StarNet
(https://github.com/androoAGI/starnet), Copyright (c) 2026 Andrew Sims, MIT License.
Any code adapted from StarNet is listed here with its origin.

- (none yet)

## Art assets

Vendored sheets live in `frontend/assets/` and are produced by `scripts/fetch-assets.mjs`,
which downloads each archive from its official URL, verifies the pinned SHA-256, and
extracts only the files listed in `frontend/assets/manifest.json`. All sources are CC0
(Creative Commons Zero); credit is given here because it is appreciated, not required.

| Pack | Author | License | Source | Used |
| --- | --- | --- | --- | --- |
| Tiny Town (1.1) | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/tiny-town | `frontend/assets/tiny-town.png` |
| Puny Characters | Shade | CC0-1.0 (OpenGameArt listing) | https://opengameart.org/content/puny-characters | `frontend/assets/ranger.png` (Soldier-Yellow sheet) |
| Roguelike/RPG pack | Kenney | CC0-1.0 (License.txt in archive) | https://kenney.nl/assets/roguelike-rpg-pack | pinned and verified, nothing extracted yet |
| 16x16 Pixel Forest Tileset (free sample v1.1) | inkBubi | CC0-1.0 (license.txt in archive) | https://opengameart.org/node/180257 | pinned and verified, nothing extracted yet |

These 2D assets belong to the pixel-art park direction, which the owner superseded with a
3D direction on 2026-10-10 (see `docs/DECISIONS.md`). They stay listed while the files
are in the repo.
