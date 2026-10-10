// Minimal windowed UI: each window is a positioned panel with a draggable title bar.
// Small helpers for building DOM without a framework.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function createWindow({ id, title, x, y, w, parent = document.body, collapsible = true }) {
  const body = el('div', { class: 'win-body' });
  const toggle = el('button', { class: 'win-toggle', title: 'Collapse', text: '–', onclick: () => win.classList.toggle('collapsed') });
  const bar = el('div', { class: 'win-bar' }, el('span', { class: 'win-title', text: title }), collapsible ? toggle : null);
  const win = el('section', { class: 'win', id, style: `left:${x}px;top:${y}px;width:${w}px` }, bar, body);
  parent.append(win);

  let drag = null;
  bar.addEventListener('mousedown', (e) => {
    if (e.target === toggle) return;
    drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
    win.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    win.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
    win.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    win.classList.remove('dragging');
  });
  return { win, body, setTitle: (t) => (bar.firstChild.textContent = t) };
}

export function fmtUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`;
}
