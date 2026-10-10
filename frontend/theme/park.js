// National park theme built from the licensed sheets in frontend/assets/ (see
// frontend/assets/manifest.json and NOTICE.md):
//   tiny-town.png  Kenney "Tiny Town", CC0, 16x16 tiles, 12 columns, no spacing
//   ranger.png     Shade "Puny Characters" (Soldier-Yellow sheet), CC0, 32x32 frames,
//                  24 columns, 8 direction rows; row 0 faces the viewer
// The renderer (world.js) knows nothing about kinds or tile indices; swap this file to
// re-skin. Until the sheets load (or if they fail), simple primitive drawings stand in and
// `theme.assets.status` says so, so the page never pretends the art is there.
//
// Day/night is a cosmetic tint from the real clock and never encodes state.

const TILE_SRC = 16;
const SHEET_COLS = 12;
const FRAME_SRC = 32;
const FRAME_COLS = 24;

// Tile indices in tiny-town.png (row-major, 12 per row).
const T = {
  grass: [0, 0, 0, 0, 0, 0, 1, 1, 2], // weighted: mostly plain, some tufts, a few flowers
  pathTL: 12, pathT: 13, pathTR: 14, pathL: 24, pathC: 25, pathR: 26, pathBL: 36, pathB: 37, pathBR: 38,
  dirt: [39, 40, 41, 42],
  trees: [4, 16, 28],
  bush: 5,
  sign: 83,
  chest: 130,
  fenceL: 44, fence: 45, fenceR: 46,
  roof: [64, 65, 66],
  wall: [72, 73, 74],
  door: 85,
  window: 77,
};

function hash(x, y, salt = 0) {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export const theme = {
  name: 'park',
  tile: 48,
  colors: {
    background: '#3f7433',
    grassA: '#4f8a3f',
    grassB: '#4a823b',
    path: '#c9b58e',
    pathEdge: '#8f7f62',
    zoneLabel: '#f1e9d2',
    labelBg: 'rgba(20, 40, 25, 0.78)',
    grid: 'rgba(255,255,255,0.08)',
    ghostOk: 'rgba(160, 230, 150, 0.45)',
    ghostBad: 'rgba(230, 90, 90, 0.45)',
    select: 'rgba(255, 220, 120, 0.9)',
    gateGlow: 'rgba(255, 200, 80, 0.35)',
  },
  assets: { status: 'loading', tiles: null, ranger: null, error: null },

  // Loads the sheets once. Resolves either way; `assets.status` is 'ready' or 'missing'.
  load() {
    if (this._loading) return this._loading;
    const loadImage = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`could not load ${src}`));
        img.src = src;
      });
    this._loading = Promise.all([loadImage('/assets/tiny-town.png'), loadImage('/assets/ranger.png')])
      .then(([tiles, ranger]) => {
        this.assets.tiles = tiles;
        this.assets.ranger = ranger;
        this.assets.status = 'ready';
      })
      .catch((err) => {
        this.assets.status = 'missing';
        this.assets.error = err.message;
      });
    return this._loading;
  },

  skyTint(date = new Date()) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h >= 7 && h < 18) return { color: '#86b8d9', alpha: 0 };
    if (h >= 5 && h < 7) return { color: '#f0a070', alpha: 0.18 };
    if (h >= 18 && h < 20) return { color: '#e08a5a', alpha: 0.22 };
    return { color: '#0a1a3a', alpha: 0.45 };
  },

  drawTile(ctx, idx, px, py, s) {
    const img = this.assets.tiles;
    if (!img) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, (idx % SHEET_COLS) * TILE_SRC, Math.floor(idx / SHEET_COLS) * TILE_SRC, TILE_SRC, TILE_SRC, px, py, s, s);
    return true;
  },

  // Open ground everywhere the camera can see.
  drawGround(ctx, tx, ty, s) {
    const px = tx * s;
    const py = ty * s;
    const h = hash(tx, ty);
    if (!this.drawTile(ctx, T.grass[h % T.grass.length], px, py, s)) {
      ctx.fillStyle = (tx + ty) % 2 === 0 ? this.colors.grassA : this.colors.grassB;
      ctx.fillRect(px, py, s, s);
    }
  },

  // Scattered trees outside zones, deterministic per tile so they never move.
  isTreeTile(tx, ty) {
    return hash(tx, ty, 7) % 9 === 0;
  },
  drawTree(ctx, tx, ty, s) {
    const idx = T.trees[hash(tx, ty, 3) % T.trees.length];
    if (!this.drawTile(ctx, idx, tx * s, ty * s, s)) {
      ctx.fillStyle = '#2f6b2a';
      ctx.beginPath();
      ctx.arc(tx * s + s / 2, ty * s + s / 2, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  // The ring of path tiles around a zone (one tile outside its rectangle).
  drawZoneBorder(ctx, room, s) {
    const x0 = room.x - 1;
    const y0 = room.y - 1;
    const x1 = room.x + room.w;
    const y1 = room.y + room.h;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const inside = tx > x0 && tx < x1 && ty > y0 && ty < y1;
        if (inside) continue;
        let idx = T.pathC;
        if (ty === y0) idx = tx === x0 ? T.pathTL : tx === x1 ? T.pathTR : T.pathT;
        else if (ty === y1) idx = tx === x0 ? T.pathBL : tx === x1 ? T.pathBR : T.pathB;
        else idx = tx === x0 ? T.pathL : T.pathR;
        if (!this.drawTile(ctx, idx, tx * s, ty * s, s)) {
          ctx.fillStyle = this.colors.path;
          ctx.fillRect(tx * s, ty * s, s, s);
        }
      }
    }
  },

  drawFloor(ctx, px, py, s, tx, ty) {
    const h = hash(tx, ty, 1);
    if (!this.drawTile(ctx, T.grass[h % T.grass.length], px, py, s)) {
      ctx.fillStyle = (tx + ty) % 2 === 0 ? this.colors.grassA : this.colors.grassB;
      ctx.fillRect(px, py, s, s);
    }
  },

  // Decorative station building in the zone's top-left corner (3 x 2 tiles). It is drawn
  // under fixtures and Rangers; the sidecar, not the theme, decides what tiles are free.
  drawStation(ctx, room, s) {
    const px = room.x * s;
    const py = room.y * s;
    if (!this.assets.tiles) {
      ctx.fillStyle = '#8a6a44';
      ctx.fillRect(px, py, 3 * s, 2 * s);
      return;
    }
    for (let i = 0; i < 3; i++) this.drawTile(ctx, T.roof[i], px + i * s, py, s);
    this.drawTile(ctx, T.wall[0], px, py + s, s);
    this.drawTile(ctx, T.door, px + s, py + s, s);
    this.drawTile(ctx, T.window, px + 2 * s, py + s, s);
  },

  // The Entrance Gate sits on the path at the middle of the zone's bottom edge.
  gateTile(room) {
    return { x: room.x + Math.floor(room.w / 2), y: room.y + room.h };
  },
  drawGate(ctx, room, s, { pending, t }) {
    const g = this.gateTile(room);
    const px = g.x * s;
    const py = g.y * s;
    if (pending) {
      ctx.fillStyle = this.colors.gateGlow;
      ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(t * 2));
      ctx.fillRect(px - s, py - s * 0.3, 3 * s, s * 1.4);
      ctx.globalAlpha = 1;
    }
    if (!this.drawTile(ctx, T.fenceR, px - s, py, s)) {
      ctx.fillStyle = '#8a6a44';
      ctx.fillRect(px - s + 4, py + s * 0.3, s - 8, s * 0.4);
    }
    this.drawTile(ctx, T.fenceL, px + s, py, s);
    this.drawTile(ctx, T.sign, px + s, py - s * 0.7, s);
    ctx.font = `${Math.round(s * 0.22)}px system-ui, sans-serif`;
    ctx.fillStyle = this.colors.labelBg;
    const label = 'Entrance Gate';
    const w = ctx.measureText(label).width + 8;
    ctx.fillRect(px + s / 2 - w / 2, py + s * 0.98, w, s * 0.28);
    ctx.fillStyle = this.colors.zoneLabel;
    ctx.textAlign = 'center';
    ctx.fillText(label, px + s / 2, py + s * 1.19);
    ctx.textAlign = 'start';
  },

  props: {
    trailhead_sign: {
      label: 'Trailhead sign',
      draw(ctx, px, py, s) {
        if (theme.drawTile(ctx, T.sign, px, py, s)) return;
        ctx.fillStyle = '#8a6a44';
        ctx.fillRect(px + s * 0.14, py + s * 0.14, s * 0.72, s * 0.3);
        ctx.fillRect(px + s * 0.46, py + s * 0.35, s * 0.08, s * 0.55);
      },
    },
    supply_cache: {
      label: 'Supply cache',
      draw(ctx, px, py, s) {
        if (theme.drawTile(ctx, T.chest, px, py, s)) return;
        ctx.fillStyle = '#7a5a36';
        ctx.fillRect(px + s * 0.14, py + s * 0.34, s * 0.72, s * 0.52);
      },
    },
  },

  // The Ranger. `state`: idle | thinking | tool-running | waiting | done | error.
  drawAgent(ctx, px, py, s, { name, state, t }) {
    const cx = px + s / 2;
    const img = this.assets.ranger;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(cx, py + s * 0.92, s * 0.26, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    if (img) {
      // Frame choice is a function of the harness state (and time only within a state).
      let frame = 0;
      if (state === 'thinking') frame = Math.floor(t * 2) % 2;
      else if (state === 'tool-running') frame = 2 + (Math.floor(t * 4) % 2);
      else if (state === 'error') frame = 6;
      const size = s * 1.35;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, (frame % FRAME_COLS) * FRAME_SRC, 0, FRAME_SRC, FRAME_SRC, cx - size / 2, py + s * 0.95 - size, size, size);
    } else {
      ctx.fillStyle = state === 'error' ? '#7a2f2f' : '#3f6b3a';
      ctx.fillRect(cx - s * 0.18, py + s * 0.42, s * 0.36, s * 0.44);
      ctx.fillStyle = '#f0c9a0';
      ctx.beginPath();
      ctx.arc(cx, py + s * 0.3, s * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    const by = py - s * 0.08;
    if (state === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const phase = (t * 3 + i * 0.6) % 1.8;
        ctx.fillStyle = `rgba(240,240,255,${0.3 + 0.7 * Math.max(0, Math.sin(phase * Math.PI))})`;
        ctx.beginPath();
        ctx.arc(cx - s * 0.12 + i * s * 0.12, by, s * 0.04, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (state === 'tool-running') {
      ctx.save();
      ctx.translate(cx, by);
      ctx.rotate(t * 2.5);
      ctx.strokeStyle = '#ffd36b';
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos((i * Math.PI) / 3) * s * 0.09, Math.sin((i * Math.PI) / 3) * s * 0.09);
        ctx.stroke();
      }
      ctx.restore();
    } else if (state === 'waiting') {
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 2));
      ctx.fillStyle = `rgba(255, 200, 80, ${pulse})`;
      ctx.beginPath();
      ctx.arc(cx, by, s * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.font = `bold ${Math.round(s * 0.15)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('?', cx, by + s * 0.05);
      ctx.textAlign = 'start';
    } else if (state === 'done') {
      ctx.strokeStyle = '#9ff09a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.08, by);
      ctx.lineTo(cx - s * 0.02, by + s * 0.06);
      ctx.lineTo(cx + s * 0.09, by - s * 0.06);
      ctx.stroke();
    } else if (state === 'error') {
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.07, by - s * 0.07);
      ctx.lineTo(cx + s * 0.07, by + s * 0.07);
      ctx.moveTo(cx + s * 0.07, by - s * 0.07);
      ctx.lineTo(cx - s * 0.07, by + s * 0.07);
      ctx.stroke();
    }
    ctx.font = `${Math.round(s * 0.22)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const w = ctx.measureText(name).width + 8;
    ctx.fillRect(cx - w / 2, py + s * 0.98, w, s * 0.26);
    ctx.fillStyle = '#eee';
    ctx.fillText(name, cx, py + s * 1.17);
    ctx.textAlign = 'start';
  },
};
