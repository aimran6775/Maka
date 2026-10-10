// A fake Etsy Open API v3 on an ephemeral port: the OAuth token endpoint (PKCE checked,
// refresh grants), users/me, the shop, listings by state (offset pagination), receipts,
// listing inventory get / put, draft listing create, listing patch. Headers x-api-key
// (the app keystring) and a bearer token. Test-only.
import http from 'node:http';
import { createHash } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const money = (amount, currency = 'USD') => ({ amount: Math.round(amount * 100), divisor: 100, currency_code: currency });

export async function startFakeEtsy({ clientId = 'etsy-keystring', pageSize = 100 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    calls: [],
    codes: new Map(),
    tokens: new Map([['at_seed', { refresh: 'rt_seed' }]]),
    refreshes: 0,
    shop: { shop_id: 55, shop_name: 'LanternCo', currency_code: 'USD', url: 'https://www.etsy.com/shop/LanternCo' },
    listings: [
      { listing_id: 501, title: 'Paper lantern, red', state: 'active', quantity: 12, price: money(25), url: 'https://www.etsy.com/listing/501', tags: ['lantern', 'red'], updated_timestamp: now - 86400, created_timestamp: now - 30 * 86400 },
      { listing_id: 502, title: 'Paper lantern, blue', state: 'draft', quantity: 3, price: money(30), url: '', tags: ['lantern', 'blue'], updated_timestamp: now - 3600, created_timestamp: now - 2 * 86400 },
    ],
    inventories: new Map([[501, { products: [{ product_id: 1, sku: 'LAN-RED', property_values: [], offerings: [{ offering_id: 11, price: money(25), quantity: 12, is_enabled: true }] }], price_on_property: [], quantity_on_property: [], sku_on_property: [] }]]),
    receipts: [
      { receipt_id: 7001, created_timestamp: now - 3600, status: 'Paid', is_paid: true, is_shipped: false, grandtotal: money(25), name: 'Ada L', buyer_email: 'a@example.com', buyer_user_id: 1, transactions: [{ title: 'Paper lantern, red', quantity: 1, price: money(25), listing_id: 501 }] },
      { receipt_id: 7000, created_timestamp: now - 20 * 86400, status: 'Completed', is_paid: true, is_shipped: true, grandtotal: money(30), name: 'Bo', buyer_user_id: 2, transactions: [{ title: 'Paper lantern, blue', quantity: 1, price: money(30), listing_id: 502 }] },
    ],
    fail: null,
  };
  let nextId = 600;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const ctype = req.headers['content-type'] || '';
    const body = !raw ? null : ctype.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    state.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && url.pathname === '/v3/public/oauth/token') {
      if (body.client_id !== clientId) return send(400, { error: 'invalid_client' });
      if (body.grant_type === 'authorization_code') {
        const c = state.codes.get(body.code);
        if (!c || c.redirectUri !== body.redirect_uri) return send(400, { error: 'invalid_grant', error_description: 'bad code' });
        if (b64url(createHash('sha256').update(body.code_verifier || '').digest()) !== c.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        state.codes.delete(body.code);
        const access = `at_${state.tokens.size}`;
        state.tokens.set(access, { refresh: `rt_${state.tokens.size}` });
        return send(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: 3600, token_type: 'Bearer' });
      }
      if (body.grant_type === 'refresh_token') {
        const entry = [...state.tokens.values()].find((t) => t.refresh === body.refresh_token);
        if (!entry) return send(400, { error: 'invalid_grant' });
        state.refreshes += 1;
        const access = `at_${state.tokens.size}`;
        state.tokens.set(access, { refresh: `rt_${state.tokens.size}` });
        return send(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: 3600, token_type: 'Bearer' });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (req.headers['x-api-key'] !== clientId) return send(401, { error: 'Invalid API key' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!state.tokens.has(bearer)) return send(401, { error: 'Invalid or expired token' });
    if (state.fail) return send(state.fail.status || 500, { error: state.fail.message || 'down' });
    const p = url.pathname.replace(/^\/v3\/application/, '');
    const page = (rows) => {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 25, pageSize);
      const offset = Number(url.searchParams.get('offset') || 0);
      return send(200, { count: rows.length, results: rows.slice(offset, offset + limit) });
    };
    if (req.method === 'GET' && p === '/users/me') return send(200, { user_id: 9, shop_id: state.shop.shop_id });
    if (req.method === 'GET' && p === `/shops/${state.shop.shop_id}`) return send(200, state.shop);
    if (req.method === 'GET' && p === `/shops/${state.shop.shop_id}/listings`) return page(state.listings.filter((l) => l.state === (url.searchParams.get('state') || 'active')));
    if (req.method === 'GET' && p === `/shops/${state.shop.shop_id}/receipts`) return page(state.receipts);
    if (req.method === 'POST' && p === `/shops/${state.shop.shop_id}/listings`) {
      for (const k of ['quantity', 'title', 'description', 'price', 'who_made', 'when_made', 'taxonomy_id']) if (body[k] === undefined) return send(400, { error: `${k} is required` });
      const l = { listing_id: ++nextId, title: body.title, description: body.description, state: 'draft', quantity: body.quantity, price: money(body.price), url: '', tags: body.tags || [], updated_timestamp: Math.floor(Date.now() / 1000), created_timestamp: Math.floor(Date.now() / 1000) };
      state.listings.unshift(l);
      return send(201, l);
    }
    const lm = /^\/shops\/\d+\/listings\/(\d+)$/.exec(p);
    if (lm && req.method === 'PATCH') {
      const l = state.listings.find((x) => x.listing_id === Number(lm[1]));
      if (!l) return send(404, { error: 'listing not found' });
      for (const k of ['title', 'description', 'tags', 'state']) if (body[k] !== undefined) l[k] = body[k];
      l.updated_timestamp = Math.floor(Date.now() / 1000);
      return send(200, l);
    }
    const im = /^\/listings\/(\d+)\/inventory$/.exec(p);
    if (im) {
      const id = Number(im[1]);
      const l = state.listings.find((x) => x.listing_id === id);
      if (!l) return send(404, { error: 'listing not found' });
      if (req.method === 'GET') return send(200, state.inventories.get(id) || { products: [], price_on_property: [], quantity_on_property: [], sku_on_property: [] });
      if (req.method === 'PUT') {
        if (!Array.isArray(body.products) || !body.products.length) return send(400, { error: 'products is required' });
        const inv = { products: body.products.map((pr, i) => ({ product_id: i + 1, sku: pr.sku || '', property_values: pr.property_values || [], offerings: (pr.offerings || []).map((o, j) => ({ offering_id: (i + 1) * 10 + j, price: money(Number(o.price)), quantity: o.quantity, is_enabled: o.is_enabled !== false })) })), price_on_property: body.price_on_property || [], quantity_on_property: body.quantity_on_property || [], sku_on_property: body.sku_on_property || [] };
        state.inventories.set(id, inv);
        l.price = inv.products[0].offerings[0].price;
        return send(200, inv);
      }
    }
    send(404, { error: `no route ${req.method} ${p}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    baseUrl: `${url}/v3/application`,
    tokenUrl: `${url}/v3/public/oauth/token`,
    authorizeUrl: `${url}/oauth/connect`,
    clientId,
    state,
    authorize(authorizeUrl) {
      const u = new URL(authorizeUrl);
      const code = `code_${state.codes.size + 1}`;
      state.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirectUri: u.searchParams.get('redirect_uri') });
      return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri'), scope: u.searchParams.get('scope') };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
