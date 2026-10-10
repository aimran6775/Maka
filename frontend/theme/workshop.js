// Workshop / atelier theme: tile colours and prop drawings keyed by object kind. The
// renderer (world.js) knows nothing about kinds; swap this file to change the look.
// Every drawing is plain canvas primitives so there are no assets to load.

export const theme = {
  name: 'workshop',
  tile: 48,
  colors: {
    background: '#0f1114',
    floorA: '#3a2d22',
    floorB: '#342821',
    floorLine: '#2a1f18',
    wall: '#55433a',
    wallTop: '#6b574b',
    roomLabel: '#d9c7a8',
    grid: 'rgba(255,255,255,0.05)',
    ghostOk: 'rgba(120, 220, 140, 0.45)',
    ghostBad: 'rgba(230, 90, 90, 0.45)',
    select: 'rgba(255, 220, 120, 0.9)',
  },
  // Floor tile: wooden planks with a subtle alternation.
  drawFloor(ctx, px, py, s, tx, ty) {
    ctx.fillStyle = (tx + ty) % 2 === 0 ? this.colors.floorA : this.colors.floorB;
    ctx.fillRect(px, py, s, s);
    ctx.fillStyle = this.colors.floorLine;
    ctx.fillRect(px, py + s * 0.33, s, 1);
    ctx.fillRect(px, py + s * 0.66, s, 1);
    ctx.fillRect(px + ((tx * 7 + ty * 13) % s), py, 1, s * 0.33);
  },
  props: {
    bookshelf: {
      label: 'Bookshelf',
      draw(ctx, px, py, s) {
        ctx.fillStyle = '#5a3b22';
        ctx.fillRect(px + s * 0.1, py + s * 0.05, s * 0.8, s * 0.9);
        const spines = ['#b53a2e', '#2e6fb5', '#c9a227', '#3f8f4a', '#7d4fb5', '#d1703a'];
        for (let row = 0; row < 3; row++) {
          const y = py + s * (0.12 + row * 0.28);
          let x = px + s * 0.15;
          let i = row;
          while (x < px + s * 0.82) {
            const w = s * (0.08 + ((i * 37) % 3) * 0.03);
            ctx.fillStyle = spines[i % spines.length];
            ctx.fillRect(x, y, w, s * 0.22);
            x += w + 1.5;
            i++;
          }
          ctx.fillStyle = '#3d2714';
          ctx.fillRect(px + s * 0.1, y + s * 0.22, s * 0.8, 2);
        }
      },
    },
    workbench: {
      label: 'Workbench',
      draw(ctx, px, py, s) {
        ctx.fillStyle = '#8a6a44';
        ctx.fillRect(px + s * 0.08, py + s * 0.3, s * 0.84, s * 0.22);
        ctx.fillStyle = '#5c4328';
        ctx.fillRect(px + s * 0.14, py + s * 0.52, s * 0.1, s * 0.38);
        ctx.fillRect(px + s * 0.76, py + s * 0.52, s * 0.1, s * 0.38);
        // vise + hammer
        ctx.fillStyle = '#9aa3ad';
        ctx.fillRect(px + s * 0.62, py + s * 0.18, s * 0.2, s * 0.14);
        ctx.fillStyle = '#c7cdd4';
        ctx.fillRect(px + s * 0.2, py + s * 0.2, s * 0.22, s * 0.07);
        ctx.fillStyle = '#7a5230';
        ctx.fillRect(px + s * 0.28, py + s * 0.27, s * 0.05, s * 0.05);
      },
    },
    window: {
      label: 'Window',
      draw(ctx, px, py, s) {
        ctx.fillStyle = '#d8d2c4';
        ctx.fillRect(px + s * 0.12, py + s * 0.08, s * 0.76, s * 0.76);
        const sky = ctx.createLinearGradient(px, py, px, py + s);
        sky.addColorStop(0, '#78b6e8');
        sky.addColorStop(1, '#cfe6f7');
        ctx.fillStyle = sky;
        ctx.fillRect(px + s * 0.18, py + s * 0.14, s * 0.64, s * 0.64);
        ctx.fillStyle = '#d8d2c4';
        ctx.fillRect(px + s * 0.48, py + s * 0.14, s * 0.04, s * 0.64);
        ctx.fillRect(px + s * 0.18, py + s * 0.44, s * 0.64, s * 0.04);
        ctx.fillStyle = '#9c8f7a';
        ctx.fillRect(px + s * 0.08, py + s * 0.84, s * 0.84, s * 0.08);
      },
    },
  },
  // The agent body. `state` is one of the five harness states; `t` is seconds for animation.
  drawAgent(ctx, px, py, s, { name, state, t }) {
    const cx = px + s / 2;
    const bob = state === 'idle' ? Math.sin(t * 2) * 1.5 : 0;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(cx, py + s * 0.9, s * 0.26, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    // body (apron)
    ctx.fillStyle = state === 'error' ? '#7a2f2f' : '#3c5a7a';
    ctx.fillRect(cx - s * 0.18, py + s * 0.42 + bob, s * 0.36, s * 0.42);
    ctx.fillStyle = '#c9a66b';
    ctx.fillRect(cx - s * 0.12, py + s * 0.52 + bob, s * 0.24, s * 0.3);
    // head
    ctx.fillStyle = '#f0c9a0';
    ctx.beginPath();
    ctx.arc(cx, py + s * 0.3 + bob, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
    // eyes
    ctx.fillStyle = '#222';
    const blink = state === 'done' ? 0.5 : 1;
    ctx.fillRect(cx - s * 0.07, py + s * 0.28 + bob, 2, 3 * blink);
    ctx.fillRect(cx + s * 0.04, py + s * 0.28 + bob, 2, 3 * blink);
    // state badge above the head
    const by = py + s * 0.04 + bob;
    if (state === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const phase = (t * 3 + i * 0.6) % 1.8;
        ctx.fillStyle = `rgba(230,230,255,${0.3 + 0.7 * Math.max(0, Math.sin(phase * Math.PI))})`;
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
    } else if (state === 'done') {
      ctx.strokeStyle = '#7fe08a';
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
    // name tag
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
