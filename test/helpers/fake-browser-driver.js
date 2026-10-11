// A fake browser driver for sidecar/browser/control.js (phase 4 step 17): a supplier site
// with a shop page, a cart, a checkout page the handoff check calls a payment page, and a
// confirmation page. `click({ text })` follows `links`; `state.pay()` is the Superintendent
// paying in the window (the page moves to the confirmation). Test-only.
import path from 'node:path';
import { promises as fsp } from 'node:fs';

export const SUPPLIER = 'http://supplier.test';

export function fakeBrowserDriver({ host = SUPPLIER } = {}) {
  const pages = {
    [`${host}/`]: { title: 'Lantern Supply Co', text: 'Rice paper rolls, bamboo frames. Add to cart' },
    [`${host}/cart`]: { title: 'Your cart', text: '2 × Rice paper roll · 1 × Bamboo frame · Total $42.50 · Checkout' },
    [`${host}/checkout`]: { title: 'Checkout', text: 'Shipping address. Card number CVC Expiry Place order', payment: true },
    [`${host}/confirmation`]: { title: 'Thank you', text: 'Order #LS-1001 confirmed. Total $42.50 paid. A receipt was emailed.' },
  };
  // One-click controls (safety 2026-10-11 H3): on a logged-in supplier with a saved card,
  // "Buy now" on the shop page and "#express" (which reads "Buy with Shop Pay") place the
  // order with no card field in sight.
  const links = { 'Add to cart': `${host}/cart`, Checkout: `${host}/checkout`, 'Place order': `${host}/confirmation`, 'Buy now': `${host}/confirmation`, '#express': `${host}/confirmation` };
  const elements = { '#express': { tag: 'button', text: 'Buy with Shop Pay' }, '#qty': { tag: 'input', text: '', editable: true } };
  const state = { launched: 0, killed: 0, pagesOpened: 0, clicked: [], typed: [], lastPage: null, pay() { if (state.lastPage) { state.lastPage._p.url = `${host}/confirmation`; } } };
  return {
    state,
    find: async () => '/fake/chromium',
    launch: async () => { state.launched += 1; return { wsUrl: 'ws://fake', pid: 1, kill() { state.killed += 1; } }; },
    connect: async () => ({ close() {}, closed: new Promise(() => {}) }),
    openPage: async () => {
      state.pagesOpened += 1;
      const p = { url: 'about:blank' };
      const at = () => pages[p.url] || { title: 'page', text: '' };
      const page = {
        url: () => p.url,
        async navigate(u) { p.url = u; return { url: u, title: at().title }; },
        async summary() { return { url: p.url, title: at().title }; },
        async facts() { const pg = at(); return { url: p.url, title: pg.title, text: pg.text, payment: Boolean(pg.payment) }; },
        async text(limit = 4000) { return at().text.slice(0, limit); },
        async tree() { return [`RootWebArea "${at().title}"`]; },
        async locate(t) { return elements[t.selector] || { tag: 'a', text: t.text || '' }; },
        async click(t) { state.clicked.push({ url: p.url, target: t }); const to = links[t.text] || links[t.selector]; if (to) p.url = to; return { tag: 'a', text: t.text || t.selector || '' }; },
        async type(t, value, opts) { state.typed.push({ url: p.url, t, value, opts }); return { tag: 'input', text: '' }; },
        async upload(sel, files) { return { count: files.length }; },
        async download(input, dir) { const f = path.join(dir, 'file.bin'); await fsp.writeFile(f, 'x'); return { path: f, bytes: 1, url: input.url || p.url }; },
        async screenshot() { return Buffer.from('\x89PNG fake'); },
        async bringToFront() {},
        async close() {},
        _p: p,
      };
      state.lastPage = page;
      return page;
    },
  };
}
