// National park theme: tile colours and fixture drawings keyed by object kind, plus the
// Ranger body. The renderer (world.js) knows nothing about kinds; swap this file to change
// the look. Every drawing is plain canvas primitives, so there are no assets to load.
//
// The sky tint follows the real clock (day/night is cosmetic and never encodes state).

export const theme = {
  name: 'park',
  tile: 48,
  colors: {
    background: '#0b1410',
    grassA: '#4f8a3f',
    grassB: '#4a823b',
    grassDot: '#3f7433',
    path: '#b9a98a',
    pathEdge: '#8f7f62',
    zoneLabel: '#f1e9d2',
    labelBg: 'rgba(20, 40, 25, 0.75)',
    grid: 'rgba(255,255,255,0.07)',
    ghostOk: 'rgba(160, 230, 150, 0.45)',
    ghostBad: 'rgba(230, 90, 90, 0.45)',
    select: 'rgba(255, 220, 120, 0.9)',
  },
  // Background tint by local hour: dawn, day, dusk, night. Purely cosmetic.
  skyTint(date = new Date()) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h >= 7 && h < 18) return { color: '#86b8d9', alpha: 0 };
    if (h >= 5 && h < 7) return { color: '#f0a070', alpha: 0.18 };
    if (h >= 18 && h < 20) return { color: '#e08a5a', alpha: 0.22 };
    return { color: '#0a1a3a', alpha: 0.45 };
  },
  drawFloor(ctx, px, py, s, tx, ty) {
    ctx.fillStyle = (tx + ty) % 2 === 0 ? this.colors.grassA : this.colors.grassB;
    ctx.fillRect(px, py, s, s);
    ctx.fillStyle = this.colors.grassDot;
    const n = (tx * 7 + ty * 13) % 5;
    for (let i = 0; i < n; i++) {
      const gx = px + ((tx * 31 + i * 17 + ty * 5) % (s - 6)) + 3;
      const gy = py + ((ty * 23 + i * 11 + tx * 3) % (s - 6)) + 3;
      ctx.fillRect(gx, gy, 2, 3);
    }
  },
  // The zone border is a gravel path.
  drawZoneBorder(ctx, room, s) {
    ctx.fillStyle = this.colors.pathEdge;
    ctx.fillRect((room.x - 0.35) * s, (room.y - 0.35) * s, (room.w + 0.7) * s, (room.h + 0.7) * s);
    ctx.fillStyle = this.colors.path;
    ctx.fillRect((room.x - 0.3) * s, (room.y - 0.3) * s, (room.w + 0.6) * s, (room.h + 0.6) * s);
  },
  props: {
    trailhead_sign: {
      label: 'Trailhead sign',
      draw(ctx, px, py, s) {
        ctx.fillStyle = '#6b4a2b';
        ctx.fillRect(px + s * 0.46, py + s * 0.35, s * 0.08, s * 0.55);
        ctx.fillStyle = '#8a6a44';
        ctx.fillRect(px + s * 0.14, py + s * 0.14, s * 0.72, s * 0.3);
        ctx.fillStyle = '#5c4328';
        ctx.fillRect(px + s * 0.14, py + s * 0.14, s * 0.72, 2);
        ctx.fillStyle = '#f1e9d2';
        ctx.fillRect(px + s * 0.22, py + s * 0.22, s * 0.4, 2);
        ctx.fillRect(px + s * 0.22, py + s * 0.3, s * 0.52, 2);
        ctx.fillStyle = '#2f6b2a';
        ctx.beginPath();
        ctx.moveTo(px + s * 0.66, py + s * 0.17);
        ctx.lineTo(px + s * 0.8, py + s * 0.17);
        ctx.lineTo(px + s * 0.73, py + s * 0.27);
        ctx.closePath();
        ctx.fill();
      },
    },
    supply_cache: {
      label: 'Supply cache',
      draw(ctx, px, py, s) {
        ctx.fillStyle = '#7a5a36';
        ctx.fillRect(px + s * 0.14, py + s * 0.34, s * 0.72, s * 0.52);
        ctx.fillStyle = '#9a7a4e';
        ctx.fillRect(px + s * 0.14, py + s * 0.34, s * 0.72, s * 0.12);
        ctx.fillStyle = '#5c4328';
        ctx.fillRect(px + s * 0.14, py + s * 0.6, s * 0.72, 2);
        ctx.fillRect(px + s * 0.48, py + s * 0.34, 2, s * 0.52);
        ctx.fillStyle = '#c7cdd4';
        ctx.fillRect(px + s * 0.44, py + s * 0.5, s * 0.12, s * 0.08);
        ctx.fillStyle = '#3f7433';
        ctx.fillRect(px + s * 0.1, py + s * 0.84, s * 0.8, s * 0.04);
      },
    },
  },
  // The Ranger body. `state`: idle | thinking | tool-running | waiting | done | error.
  drawAgent(ctx, px, py, s, { name, state, t }) {
    const cx = px + s / 2;
    const bob = state === 'idle' ? Math.sin(t * 2) * 1.5 : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(cx, py + s * 0.9, s * 0.26, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    // shirt (ranger green) and trousers
    ctx.fillStyle = state === 'error' ? '#7a2f2f' : '#3f6b3a';
    ctx.fillRect(cx - s * 0.18, py + s * 0.42 + bob, s * 0.36, s * 0.26);
    ctx.fillStyle = '#5a4a3a';
    ctx.fillRect(cx - s * 0.16, py + s * 0.68 + bob, s * 0.32, s * 0.18);
    // badge
    ctx.fillStyle = '#e4c15a';
    ctx.fillRect(cx + s * 0.05, py + s * 0.48 + bob, s * 0.06, s * 0.06);
    // head and hat
    ctx.fillStyle = '#f0c9a0';
    ctx.beginPath();
    ctx.arc(cx, py + s * 0.3 + bob, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8a6a44';
    ctx.fillRect(cx - s * 0.24, py + s * 0.2 + bob, s * 0.48, s * 0.05);
    ctx.fillRect(cx - s * 0.13, py + s * 0.08 + bob, s * 0.26, s * 0.13);
    ctx.fillStyle = '#222';
    const blink = state === 'done' ? 0.5 : 1;
    ctx.fillRect(cx - s * 0.07, py + s * 0.29 + bob, 2, 3 * blink);
    ctx.fillRect(cx + s * 0.04, py + s * 0.29 + bob, 2, 3 * blink);
    // state badge above the hat
    const by = py - s * 0.02 + bob;
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
      // a raised hand: the Ranger is waiting on the Superintendent at the Gate
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 2));
      ctx.fillStyle = `rgba(255, 200, 80, ${pulse})`;
      ctx.beginPath();
      ctx.arc(cx, by, s * 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#222';
      ctx.font = `bold ${Math.round(s * 0.14)}px system-ui, sans-serif`;
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
    ctx.fillRect(cx - w / 2, py + s * 0.94, w, s * 0.26);
    ctx.fillStyle = '#eee';
    ctx.fillText(name, cx, py + s * 1.12);
    ctx.textAlign = 'start';
  },
};
