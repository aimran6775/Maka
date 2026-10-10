// A fake Shopify Admin REST API on an ephemeral port: shop.json, products.json and
// orders.json with Link-header cursor pagination, product create / update, variant update.
// Header X-Shopify-Access-Token. Test-only.
import http from 'node:http';

export async function startFakeShopify({ accessToken = 'shpat_fake', pageSize = 250 } = {}) {
  const iso = (d) => new Date(d).toISOString();
  const now = Date.now();
  const state = {
    calls: [],
    shop: { id: 1, name: 'Lantern Co', myshopify_domain: 'lanterns.myshopify.com', currency: 'USD' },
    products: [
      { id: 101, title: 'Paper lantern, red', handle: 'paper-lantern-red', status: 'active', vendor: 'Lantern Co', product_type: 'Lantern', tags: 'lantern, red', created_at: iso(now - 30 * 86400e3), updated_at: iso(now - 86400e3), variants: [{ id: 1001, product_id: 101, title: 'Default', sku: 'LAN-RED', price: '25.00', compare_at_price: null, inventory_quantity: 12, inventory_item_id: 5001 }] },
      { id: 102, title: 'Paper lantern, blue', handle: 'paper-lantern-blue', status: 'draft', vendor: 'Lantern Co', product_type: 'Lantern', tags: 'lantern, blue', created_at: iso(now - 2 * 86400e3), updated_at: iso(now - 86400e3), variants: [{ id: 1002, product_id: 102, title: 'Small', sku: 'LAN-BLU-S', price: '20.00', compare_at_price: null, inventory_quantity: 0, inventory_item_id: 5002 }, { id: 1003, product_id: 102, title: 'Large', sku: 'LAN-BLU-L', price: '30.00', compare_at_price: '35.00', inventory_quantity: 3, inventory_item_id: 5003 }] },
    ],
    orders: [
      { id: 9001, name: '#1001', created_at: iso(now - 3600e3), financial_status: 'paid', fulfillment_status: null, total_price: '25.00', currency: 'USD', email: 'a@example.com', customer: { id: 7, first_name: 'Ada', last_name: 'L' }, line_items: [{ title: 'Paper lantern, red', quantity: 1, price: '25.00', sku: 'LAN-RED', variant_id: 1001 }] },
      { id: 9002, name: '#1002', created_at: iso(now - 20 * 86400e3), financial_status: 'refunded', fulfillment_status: 'fulfilled', total_price: '30.00', currency: 'USD', email: 'b@example.com', customer: null, line_items: [{ title: 'Paper lantern, blue', quantity: 1, price: '30.00', sku: 'LAN-BLU-L', variant_id: 1003 }] },
    ],
    fail: null,
  };
  let nextId = 200;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    state.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.headers['x-shopify-access-token'] !== accessToken) return send(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
    if (state.fail) return send(state.fail.status || 500, { errors: state.fail.message || 'down' });
    const m = /^\/admin\/api\/(\d{4}-\d{2})\/(.+)$/.exec(url.pathname);
    if (!m) return send(404, { errors: 'Not Found' });
    const p = m[2];
    // Like Shopify, the cursor remembers the query's filters: page_info = "<start>|<status>".
    const cursor = (url.searchParams.get('page_info') || '').split('|');
    const start = Number(cursor[0] || 0);
    const status = cursor.length > 1 ? cursor[1] : url.searchParams.get('status') || '';
    if (url.searchParams.get('page_info') && [...url.searchParams.keys()].some((k) => !['limit', 'page_info'].includes(k))) return send(400, { errors: 'page_info cannot be combined with other filters' });
    const page = (key, rows) => {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, pageSize);
      const data = rows.slice(start, start + limit);
      const headers = start + limit < rows.length ? { link: `<${url.origin}${url.pathname}?limit=${limit}&page_info=${encodeURIComponent(`${start + limit}|${status}`)}>; rel="next"` } : {};
      return send(200, { [key]: data }, headers);
    };
    if (req.method === 'GET' && p === 'shop.json') return send(200, { shop: state.shop });
    if (req.method === 'GET' && p === 'products.json') return page('products', state.products);
    if (req.method === 'GET' && p === 'orders.json') return page('orders', status === 'any' ? state.orders : state.orders.filter((o) => o.financial_status !== 'refunded'));
    if (req.method === 'POST' && p === 'products.json') {
      const pr = body && body.product;
      if (!pr || !pr.title) return send(422, { errors: { title: ["can't be blank"] } });
      const id = ++nextId;
      const product = { id, title: pr.title, handle: pr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), status: pr.status || 'active', vendor: pr.vendor || '', product_type: pr.product_type || '', tags: pr.tags || '', body_html: pr.body_html || '', created_at: iso(Date.now()), updated_at: iso(Date.now()), variants: (pr.variants || [{ price: '0.00' }]).map((v, i) => ({ id: id * 10 + i, product_id: id, title: v.title || 'Default', sku: v.sku || '', price: v.price, compare_at_price: null, inventory_quantity: v.inventory_quantity ?? 0, inventory_item_id: id * 100 + i })) };
      state.products.unshift(product);
      return send(201, { product });
    }
    const pm = /^products\/(\d+)\.json$/.exec(p);
    if (pm && req.method === 'PUT') {
      const product = state.products.find((x) => x.id === Number(pm[1]));
      if (!product) return send(404, { errors: 'Not Found' });
      Object.assign(product, Object.fromEntries(Object.entries(body.product).filter(([k]) => ['title', 'body_html', 'tags', 'status', 'vendor', 'product_type'].includes(k))), { updated_at: iso(Date.now()) });
      return send(200, { product });
    }
    const vm = /^variants\/(\d+)\.json$/.exec(p);
    if (vm && req.method === 'PUT') {
      for (const product of state.products) {
        const v = product.variants.find((x) => x.id === Number(vm[1]));
        if (v) {
          if (body.variant.price !== undefined) v.price = String(body.variant.price);
          if (body.variant.compare_at_price !== undefined) v.compare_at_price = String(body.variant.compare_at_price);
          return send(200, { variant: v });
        }
      }
      return send(404, { errors: 'Not Found' });
    }
    send(404, { errors: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, accessToken, state, async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
