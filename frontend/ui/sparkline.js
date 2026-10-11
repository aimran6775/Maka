// Hand-drawn sparklines for the Peak's results table (phase 4 step 9). No chart library:
// `sparklineGeometry` is pure (tested under Node) and `sparkline` turns it into one SVG.
// A null value is "no data": it leaves a gap in the line and a hollow mark, never a zero.

export function sparklineGeometry(values, { w = 120, h = 24, pad = 2 } = {}) {
  const known = values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? { i, v } : null)).filter(Boolean);
  if (!known.length) return { w, h, points: [], segments: [], gaps: values.map((_, i) => i), min: null, max: null, last: null };
  let min = Math.min(...known.map((k) => k.v));
  let max = Math.max(...known.map((k) => k.v));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const n = Math.max(values.length - 1, 1);
  const x = (i) => pad + (i / n) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
  const points = known.map((k) => ({ i: k.i, x: Number(x(k.i).toFixed(2)), y: Number(y(k.v).toFixed(2)), v: k.v }));
  // Consecutive known indexes form one segment; a null between them breaks the line.
  const segments = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && p.i !== cur[cur.length - 1].i + 1) {
      segments.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) segments.push(cur);
  const path = segments.map((seg) => seg.map((p, j) => `${j ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')).join(' ');
  return { w, h, points, segments, path, gaps: values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? null : i)).filter((i) => i !== null), min, max, last: known[known.length - 1].v };
}

const NS = 'http://www.w3.org/2000/svg';

export function sparkline(values, { w = 120, h = 24, title = '', color = 'currentColor' } = {}) {
  const g = sparklineGeometry(values, { w, h });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (title) {
    const t = document.createElementNS(NS, 'title');
    t.textContent = title;
    svg.append(t);
  }
  if (!g.points.length) {
    const txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', '2');
    txt.setAttribute('y', String(h - 6));
    txt.setAttribute('class', 'spark-empty');
    txt.textContent = 'no data';
    svg.append(txt);
    return svg;
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', g.path);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '1.2');
  svg.append(path);
  for (const seg of g.segments) {
    if (seg.length !== 1) continue; // a lone known day has no line: mark it
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(seg[0].x));
    c.setAttribute('cy', String(seg[0].y));
    c.setAttribute('r', '1.5');
    c.setAttribute('fill', color);
    svg.append(c);
  }
  const last = g.points[g.points.length - 1];
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', String(last.x));
  dot.setAttribute('cy', String(last.y));
  dot.setAttribute('r', '2');
  dot.setAttribute('fill', color);
  svg.append(dot);
  return svg;
}
