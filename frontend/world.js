// Canvas world renderer. Draws rooms, placed objects and agent bodies from the frontend
// state, using a theme for all visuals. Handles build-mode hover/click on tiles.
//
//   createWorld({ canvas, theme, getState, insets?, onPlace(roomId, x, y), onReclaim(objectId), onPick(info) })
//     -> { render(), setBuild(kind|null), destroy() }
//
// insets() returns { left, right, top, bottom } pixels to keep clear (windows sit there).

export function createWorld({ canvas, theme, getState, insets = () => ({ left: 0, right: 0, top: 0, bottom: 0 }), onPlace, onReclaim, onPick }) {
  const ctx = canvas.getContext('2d');
  let buildKind = null; // object kind being placed, or null
  let hover = null; // { x, y } tile under the cursor
  let raf = null;
  let destroyed = false;
  const start = performance.now();
  let offset = { x: 0, y: 0 };
  let scale = 1;

  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const state = getState();
    const s = theme.tile;
    let maxX = 0;
    let maxY = 0;
    for (const r of state.layout.rooms) {
      maxX = Math.max(maxX, r.x + r.w + 1);
      maxY = Math.max(maxY, r.y + r.h + 1);
    }
    const worldW = Math.max(1, maxX) * s;
    const worldH = Math.max(1, maxY) * s;
    const inset = insets();
    const availW = Math.max(200, rect.width - inset.left - inset.right);
    const availH = Math.max(200, rect.height - inset.top - inset.bottom);
    scale = Math.min(1.5, Math.max(0.5, Math.min(availW / worldW, availH / worldH)));
    offset = { x: inset.left + Math.max(0, (availW - worldW * scale) / 2), y: inset.top + Math.max(0, (availH - worldH * scale) / 2) };
  }

  function tileAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - offset.x) / scale / theme.tile;
    const y = (clientY - rect.top - offset.y) / scale / theme.tile;
    return { x: Math.floor(x), y: Math.floor(y) };
  }

  function roomAt(state, x, y) {
    return state.layout.rooms.find((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) || null;
  }

  function occupied(state, x, y) {
    return state.layout.objects.some((o) => o.x === x && o.y === y) || state.layout.agents.some((a) => a.x === x && a.y === y);
  }

  function draw() {
    if (destroyed) return;
    const state = getState();
    const dpr = window.devicePixelRatio || 1;
    const s = theme.tile;
    const t = (performance.now() - start) / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);

    for (const room of state.layout.rooms) {
      theme.drawZoneBorder(ctx, room, s);
      for (let ty = room.y; ty < room.y + room.h; ty++) {
        for (let tx = room.x; tx < room.x + room.w; tx++) theme.drawFloor(ctx, tx * s, ty * s, s, tx, ty);
      }
      ctx.font = `${Math.round(s * 0.3)}px system-ui, sans-serif`;
      const labelW = ctx.measureText(room.name).width + 12;
      ctx.fillStyle = theme.colors.labelBg;
      ctx.fillRect(room.x * s, (room.y - 0.3) * s - s * 0.42, labelW, s * 0.42);
      ctx.fillStyle = theme.colors.zoneLabel;
      ctx.fillText(room.name, room.x * s + 6, (room.y - 0.3) * s - s * 0.12);
      if (buildKind) {
        ctx.strokeStyle = theme.colors.grid;
        for (let ty = room.y; ty <= room.y + room.h; ty++) {
          ctx.beginPath();
          ctx.moveTo(room.x * s, ty * s);
          ctx.lineTo((room.x + room.w) * s, ty * s);
          ctx.stroke();
        }
        for (let tx = room.x; tx <= room.x + room.w; tx++) {
          ctx.beginPath();
          ctx.moveTo(tx * s, room.y * s);
          ctx.lineTo(tx * s, (room.y + room.h) * s);
          ctx.stroke();
        }
      }
    }

    // objects and agents, painter's order by y
    const drawables = [
      ...state.layout.objects.map((o) => ({ y: o.y, draw: () => drawProp(o.kind, o.x * s, o.y * s, s) })),
      ...state.layout.agents.map((a) => ({
        y: a.y,
        draw: () => theme.drawAgent(ctx, a.x * s, a.y * s, s, { name: a.name, state: state.agentStates[a.id] || 'idle', t }),
      })),
    ].sort((a, b) => a.y - b.y);
    for (const d of drawables) d.draw();

    // build ghost
    if (buildKind && hover) {
      const room = roomAt(state, hover.x, hover.y);
      const ok = room && !occupied(state, hover.x, hover.y);
      ctx.fillStyle = ok ? theme.colors.ghostOk : theme.colors.ghostBad;
      ctx.fillRect(hover.x * s, hover.y * s, s, s);
      if (ok && theme.props[buildKind]) {
        ctx.globalAlpha = 0.6;
        theme.props[buildKind].draw(ctx, hover.x * s, hover.y * s, s);
        ctx.globalAlpha = 1;
      }
    } else if (!buildKind && hover) {
      const obj = state.layout.objects.find((o) => o.x === hover.x && o.y === hover.y);
      if (obj) {
        ctx.strokeStyle = theme.colors.select;
        ctx.lineWidth = 2;
        ctx.strokeRect(obj.x * s + 1, obj.y * s + 1, s - 2, s - 2);
      }
    }

    // Cosmetic day/night tint from the real clock. Never encodes state.
    const tint = theme.skyTint ? theme.skyTint(new Date()) : null;
    if (tint && tint.alpha > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = tint.alpha;
      ctx.fillStyle = tint.color;
      ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      ctx.globalAlpha = 1;
    }

    const animating = Object.values(state.agentStates).some((st) => st === 'thinking' || st === 'tool-running' || st === 'idle' || st === 'waiting');
    raf = animating ? requestAnimationFrame(draw) : null;
  }

  // Unknown kinds (a newer sidecar than this page) draw as a labelled placeholder.
  function drawProp(kind, px, py, s) {
    const prop = theme.props[kind];
    if (prop) return prop.draw(ctx, px, py, s);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(px + 4, py + 4, s - 8, s - 8);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(s * 0.2)}px system-ui, sans-serif`;
    ctx.fillText(kind.slice(0, 8), px + 6, py + s / 2);
  }

  function render() {
    fit();
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  }

  const onMove = (e) => {
    hover = tileAt(e.clientX, e.clientY);
    canvas.style.cursor = buildKind ? 'crosshair' : 'default';
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const onLeave = () => {
    hover = null;
    if (!raf) raf = requestAnimationFrame(draw);
  };
  const onClick = (e) => {
    const state = getState();
    const { x, y } = tileAt(e.clientX, e.clientY);
    const obj = state.layout.objects.find((o) => o.x === x && o.y === y);
    if (buildKind) {
      if (obj) onReclaim(obj.id);
      else {
        const room = roomAt(state, x, y);
        if (room && !occupied(state, x, y)) onPlace(room.id, x, y);
      }
      return;
    }
    const agent = state.layout.agents.find((a) => a.x === x && a.y === y);
    if (obj) onPick({ type: 'object', object: obj });
    else if (agent) onPick({ type: 'agent', agent });
    else onPick(null);
  };
  const onResize = () => render();

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('click', onClick);
  window.addEventListener('resize', onResize);

  return {
    render,
    setBuild(kind) {
      buildKind = kind;
      render();
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('resize', onResize);
    },
  };
}
