// Canvas park renderer. Draws ground, zones, the station, fixtures, the Entrance Gate and
// Ranger bodies from the frontend state, using a theme for all visuals. Camera: wheel to
// zoom, drag to pan. Clicks report what was hit (Ranger, fixture, Gate, zone) to onPick;
// in build mode a click places or reclaims a fixture.
//
//   createWorld({ canvas, theme, getState, insets?, onPlace(roomId, x, y), onReclaim(objectId), onPick(info) })
//     -> { render(), setBuild(kind|null), agentTile(agent), destroy() }

export function createWorld({ canvas, theme, getState, insets = () => ({ left: 0, right: 0, top: 0, bottom: 0 }), onPlace, onReclaim, onPick }) {
  const ctx = canvas.getContext('2d');
  let buildKind = null;
  let hover = null;
  let raf = null;
  let destroyed = false;
  const start = performance.now();
  let base = { offset: { x: 0, y: 0 }, scale: 1 };
  const camera = { pan: { x: 0, y: 0 }, zoom: 1, touched: false };
  let drag = null;

  const scale = () => base.scale * camera.zoom;
  const offset = () => ({ x: base.offset.x + camera.pan.x, y: base.offset.y + camera.pan.y });

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
      maxY = Math.max(maxY, r.y + r.h + 2.5);
    }
    const worldW = Math.max(1, maxX) * s;
    const worldH = Math.max(1, maxY) * s;
    const inset = insets();
    const availW = Math.max(200, rect.width - inset.left - inset.right);
    const availH = Math.max(200, rect.height - inset.top - inset.bottom);
    const sc = Math.min(1.5, Math.max(0.5, Math.min(availW / worldW, availH / worldH)));
    base = { scale: sc, offset: { x: inset.left + Math.max(0, (availW - worldW * sc) / 2), y: inset.top + Math.max(0, (availH - worldH * sc) / 2) } };
  }

  function tileAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const o = offset();
    const sc = scale();
    return { x: Math.floor((clientX - rect.left - o.x) / sc / theme.tile), y: Math.floor((clientY - rect.top - o.y) / sc / theme.tile) };
  }

  const roomAt = (state, x, y) => state.layout.rooms.find((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) || null;
  const occupied = (state, x, y) => state.layout.objects.some((o) => o.x === x && o.y === y) || state.layout.agents.some((a) => a.x === x && a.y === y);

  // Where a Ranger stands: at the Gate while waiting on the Superintendent, else at home.
  function agentTile(state, agent) {
    const st = state.agentStates[agent.id];
    const room = state.layout.rooms.find((r) => r.id === agent.roomId);
    if (st === 'waiting' && room && theme.gateTile) {
      const g = theme.gateTile(room);
      return { x: g.x, y: g.y };
    }
    return { x: agent.x, y: agent.y };
  }

  function draw() {
    if (destroyed) return;
    const state = getState();
    const dpr = window.devicePixelRatio || 1;
    const s = theme.tile;
    const t = (performance.now() - start) / 1000;
    const o = offset();
    const sc = scale();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.translate(o.x, o.y);
    ctx.scale(sc, sc);

    // Ground and trees over the visible area.
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    const tx0 = Math.floor(-o.x / sc / s) - 1;
    const ty0 = Math.floor(-o.y / sc / s) - 1;
    const tx1 = Math.ceil((viewW - o.x) / sc / s) + 1;
    const ty1 = Math.ceil((viewH - o.y) / sc / s) + 1;
    const inAnyZoneOrRing = (tx, ty) => state.layout.rooms.some((r) => tx >= r.x - 1 && ty >= r.y - 1 && tx <= r.x + r.w && ty <= r.y + r.h + 1);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (theme.drawGround) theme.drawGround(ctx, tx, ty, s);
        else theme.drawFloor(ctx, tx * s, ty * s, s, tx, ty);
      }
    }
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (theme.isTreeTile && theme.isTreeTile(tx, ty) && !inAnyZoneOrRing(tx, ty)) theme.drawTree(ctx, tx, ty, s);
      }
    }

    for (const room of state.layout.rooms) {
      theme.drawZoneBorder(ctx, room, s);
      for (let ty = room.y; ty < room.y + room.h; ty++) {
        for (let tx = room.x; tx < room.x + room.w; tx++) theme.drawFloor(ctx, tx * s, ty * s, s, tx, ty);
      }
      if (theme.drawStation) theme.drawStation(ctx, room, s);
      ctx.font = `${Math.round(s * 0.3)}px system-ui, sans-serif`;
      const labelW = ctx.measureText(room.name).width + 12;
      ctx.fillStyle = theme.colors.labelBg;
      ctx.fillRect(room.x * s, (room.y - 1) * s - s * 0.42, labelW, s * 0.42);
      ctx.fillStyle = theme.colors.zoneLabel;
      ctx.fillText(room.name, room.x * s + 6, (room.y - 1) * s - s * 0.12);
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
      if (theme.drawGate) {
        const pending = state.pendingPrompts.length > 0;
        theme.drawGate(ctx, room, s, { pending, t });
      }
    }

    const drawables = [
      ...state.layout.objects.map((obj) => ({ y: obj.y, draw: () => drawProp(obj.kind, obj.x * s, obj.y * s, s) })),
      ...state.layout.agents.map((a) => {
        const pos = agentTile(state, a);
        return { y: pos.y, draw: () => theme.drawAgent(ctx, pos.x * s, pos.y * s, s, { name: a.name, state: state.agentStates[a.id] || 'idle', t }) };
      }),
    ].sort((a, b) => a.y - b.y);
    for (const d of drawables) d.draw();

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
      const obj = state.layout.objects.find((ob) => ob.x === hover.x && ob.y === hover.y);
      if (obj) {
        ctx.strokeStyle = theme.colors.select;
        ctx.lineWidth = 2;
        ctx.strokeRect(obj.x * s + 1, obj.y * s + 1, s - 2, s - 2);
      }
    }

    const tint = theme.skyTint ? theme.skyTint(new Date()) : null;
    if (tint && tint.alpha > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = tint.alpha;
      ctx.fillStyle = tint.color;
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.globalAlpha = 1;
    }

    const animating = Object.values(state.agentStates).some((st) => st !== 'done') || state.pendingPrompts.length > 0;
    raf = animating ? requestAnimationFrame(draw) : null;
  }

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
  const redraw = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  const onDown = (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, panX: camera.pan.x, panY: camera.pan.y, moved: false };
  };
  const onMove = (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved && !buildKind) {
        camera.pan = { x: drag.panX + dx, y: drag.panY + dy };
        camera.touched = true;
      }
    }
    hover = tileAt(e.clientX, e.clientY);
    canvas.style.cursor = buildKind ? 'crosshair' : drag && drag.moved ? 'grabbing' : 'default';
    redraw();
  };
  const onUp = (e) => {
    const wasDrag = drag && drag.moved && !buildKind;
    drag = null;
    if (wasDrag) return;
    click(e);
  };
  const onLeave = () => {
    hover = null;
    drag = null;
    redraw();
  };
  const onWheel = (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const before = scale();
    camera.zoom = Math.min(3, Math.max(0.4, camera.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const after = scale();
    // keep the world point under the cursor fixed
    const o = offset();
    const wx = (mx - o.x) / before;
    const wy = (my - o.y) / before;
    camera.pan.x += mx - (base.offset.x + camera.pan.x + wx * after);
    camera.pan.y += my - (base.offset.y + camera.pan.y + wy * after);
    camera.touched = true;
    redraw();
  };
  function click(e) {
    const state = getState();
    const { x, y } = tileAt(e.clientX, e.clientY);
    const obj = state.layout.objects.find((ob) => ob.x === x && ob.y === y);
    if (buildKind) {
      if (obj) onReclaim(obj.id);
      else {
        const room = roomAt(state, x, y);
        if (room && !occupied(state, x, y)) onPlace(room.id, x, y);
      }
      return;
    }
    const agent = state.layout.agents.find((a) => {
      const p = agentTile(state, a);
      return p.x === x && p.y === y;
    });
    const room = roomAt(state, x, y);
    const gateRoom = theme.gateTile ? state.layout.rooms.find((r) => { const g = theme.gateTile(r); return (g.x === x || g.x === x + 1 || g.x === x - 1) && g.y === y; }) : null;
    if (agent) onPick({ type: 'agent', agent });
    else if (obj) onPick({ type: 'object', object: obj });
    else if (gateRoom) onPick({ type: 'gate', room: gateRoom });
    else if (room) onPick({ type: 'zone', room });
    else onPick(null);
  }
  const onResize = () => render();

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', onResize);

  return {
    render,
    redraw,
    agentTile: (agent) => agentTile(getState(), agent),
    setBuild(kind) {
      buildKind = kind;
      render();
    },
    resetCamera() {
      camera.pan = { x: 0, y: 0 };
      camera.zoom = 1;
      camera.touched = false;
      render();
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
    },
  };
}
