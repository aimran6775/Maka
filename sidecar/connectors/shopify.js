// Shopify connector (phase 2 step 16): the Admin REST API of one store, read into the
// local store (products with variants and stock, orders); writes are a product created
// or updated (publishing) and a variant price change (money_in). Official API only:
// https://<shop>.myshopify.com/admin/api/<version>/…, header X-Shopify-Access-Token (a
// custom app's Admin API access token: SHOPIFY_ACCESS_TOKEN or the keystore), JSON bodies,
// cursor pagination through the Link header. No supplier purchase exists in this API, so
// there is no money_out tool here (docs/DECISIONS.md D80).
//
//   createShopifyClient({ shop, accessToken, fetch, baseUrl, version })
//   shopifySpec({ baseUrl })   -> a connector spec (zone kinds product_listings, sales)
//   SHOPIFY_TOOLS

export const SHOPIFY_API_VERSION = '2024-10';
export const SHOPIFY_SYNC_MS = 15 * 60 * 1000;
export const SHOPIFY_PAGE_LIMIT = 250;
export const SHOPIFY_MAX_PAGES = 4;

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export function shopDomain(shop) {
  const s = String(shop || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return null;
  return s.includes('.') ? s : `${s}.myshopify.com`;
}

function nextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m) {
      try {
        return new URL(m[1]).searchParams.get('page_info');
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createShopifyClient({ shop, accessToken, fetch: fetchImpl = globalThis.fetch, baseUrl = null, version = SHOPIFY_API_VERSION } = {}) {
  const domain = shopDomain(shop);
  if (!domain) throw fail('NO_SHOP', 'Shopify needs the shop domain (connectors.shopify.shop in config.json or SHOPIFY_SHOP), e.g. "lanterns.myshopify.com"');
  if (!accessToken) throw new TypeError('createShopifyClient needs accessToken');
  const root = `${baseUrl || `https://${domain}`}/admin/api/${version}`;
  async function call(method, p, { params, body } = {}) {
    const url = new URL(`${root}${p}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url.toString(), { method, headers: { 'x-shopify-access-token': accessToken, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw fail('NETWORK', `Shopify unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw fail('BAD_RESPONSE', `Shopify answered ${res.status} with a non-JSON body`);
    }
    if (!res.ok) {
      const errs = json.errors;
      const msg = typeof errs === 'string' ? errs : errs ? JSON.stringify(errs) : text.slice(0, 200);
      throw fail(`HTTP_${res.status}`, `Shopify ${res.status}: ${msg}`, res.status);
    }
    return { json, next: nextPageInfo(res.headers.get('link')) };
  }
  const client = {
    shop: domain,
    async shopInfo() {
      return (await call('GET', '/shop.json')).json.shop;
    },
    async listAll(resource, params = {}, { maxPages = SHOPIFY_MAX_PAGES } = {}) {
      const out = [];
      let pageInfo = null;
      for (let i = 0; i < maxPages; i++) {
        // Shopify refuses filters together with page_info: only limit rides along.
        const { json, next } = await call('GET', `/${resource}.json`, { params: pageInfo ? { limit: SHOPIFY_PAGE_LIMIT, page_info: pageInfo } : { limit: SHOPIFY_PAGE_LIMIT, ...params } });
        out.push(...(json[resource] || []));
        if (!next) break;
        pageInfo = next;
      }
      return out;
    },
    products: (params) => client.listAll('products', params),
    orders: (params) => client.listAll('orders', { status: 'any', ...params }),
    createProduct: async (product) => (await call('POST', '/products.json', { body: { product } })).json.product,
    updateProduct: async (id, product) => (await call('PUT', `/products/${encodeURIComponent(id)}.json`, { body: { product: { id, ...product } } })).json.product,
    updateVariant: async (id, variant) => (await call('PUT', `/variants/${encodeURIComponent(id)}.json`, { body: { variant: { id, ...variant } } })).json.variant,
  };
  return client;
}

const variantRow = (v) => ({ id: v.id, title: v.title, sku: v.sku || '', price: String(v.price), compareAtPrice: v.compare_at_price ? String(v.compare_at_price) : null, inventoryQuantity: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null, inventoryItemId: v.inventory_item_id || null });
const productRow = (p) => ({ id: p.id, title: p.title, handle: p.handle || '', status: p.status || 'active', vendor: p.vendor || '', productType: p.product_type || '', tags: p.tags || '', createdAt: p.created_at || null, updatedAt: p.updated_at || null, variants: (p.variants || []).map(variantRow) });
const orderRow = (o) => ({ id: o.id, name: o.name || String(o.id), createdAt: o.created_at || null, financialStatus: o.financial_status || '', fulfillmentStatus: o.fulfillment_status || 'unfulfilled', totalPrice: String(o.total_price || '0'), currency: o.currency || '', customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() || o.customer.email || String(o.customer.id) : (o.email || ''), lineItems: (o.line_items || []).map((li) => ({ title: li.title, quantity: li.quantity, price: String(li.price), sku: li.sku || '', variantId: li.variant_id || null })) });

export function emptyShopifyData() {
  return { shop: null, products: [], orders: [] };
}

export function summarizeShopify(data) {
  if (!data || !Array.isArray(data.products)) return null;
  const week = Date.now() - 7 * 86_400_000;
  const recent = (data.orders || []).filter((o) => o.createdAt && Date.parse(o.createdAt) >= week && o.financialStatus === 'paid');
  const revenue = recent.reduce((n, o) => n + (Number(o.totalPrice) || 0), 0);
  const cur = (data.shop && data.shop.currency) || (recent[0] && recent[0].currency) || '';
  return `${data.shop && data.shop.name ? `${data.shop.name} · ` : ''}${data.products.length} product(s) · ${(data.orders || []).length} order(s) · last 7 days: ${recent.length} paid, ${revenue.toFixed(2)} ${cur}`.trim();
}

export function shopifySpec({ baseUrl = null } = {}) {
  return {
    kind: 'shopify',
    label: 'Shopify',
    auth: 'api_key',
    envVar: 'SHOPIFY_ACCESS_TOKEN',
    keyName: 'shopify',
    zoneKinds: ['product_listings', 'sales'],
    syncEveryMs: SHOPIFY_SYNC_MS,
    emptyData: emptyShopifyData,
    summarize: summarizeShopify,
    makeClient: ({ token, fetch: fetchImpl, env, config }) => createShopifyClient({ shop: (config && config.shop) || env.SHOPIFY_SHOP, accessToken: token.accessToken, fetch: fetchImpl, baseUrl }),
    async sync({ client, data }) {
      const [shop, products, orders] = await Promise.all([client.shopInfo(), client.products(), client.orders()]);
      const knownOrders = new Set((data.orders || []).map((o) => o.id));
      const next = { ...data, shop: { id: shop.id, name: shop.name, domain: shop.myshopify_domain || client.shop, currency: shop.currency || '' }, products: products.map(productRow), orders: orders.map(orderRow) };
      return { data: next, counts: { products: next.products.length, orders: next.orders.length, newOrders: next.orders.filter((o) => !knownOrders.has(o.id)).length } };
    },
    tools: SHOPIFY_TOOLS,
  };
}

// ---- tools ----

function need(ctx, kind, label) {
  if (!ctx.connectors) return { error: { ok: false, error: 'the connector framework is not available in this run' } };
  const st = ctx.connectors.status(kind);
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: `${label} is not defined in this build` } };
  const data = ctx.connectors.data(kind);
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: `${label} is not connected; ask the Superintendent to connect it at the Peak` } };
  return { data, status: st };
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(String(q).toLowerCase()));

export const shopifyProducts = {
  name: 'shopify.products',
  description: 'Products from the last Shopify sync: id, title, status, variants with sku, price and stock. Filters: query (title / sku / tags), status (active | draft | archived), limit.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, status: { type: 'string', enum: ['active', 'draft', 'archived'] }, limit: { type: 'integer', minimum: 1, maximum: 250 } } },
  confirm: false,
  summarize: () => 'read the Shopify products',
  async run(input, ctx) {
    const { data, error } = need(ctx, 'shopify', 'Shopify');
    if (error) return error;
    const rows = data.products.filter((p) => (!input.status || p.status === input.status) && matches(input.query, p.title, p.tags, ...p.variants.map((v) => v.sku)));
    return { ok: true, output: JSON.stringify({ shop: data.shop, count: rows.length, syncedAt: iso(data.syncedAt), products: rows.slice(0, input.limit || 50) }) };
  },
};

export const shopifyOrders = {
  name: 'shopify.orders',
  description: 'Orders from the last Shopify sync (newest first): name, date, financial and fulfillment status, total, customer, line items. Filters: sinceDays, financialStatus, fulfillmentStatus, limit.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { sinceDays: { type: 'integer', minimum: 1, maximum: 365 }, financialStatus: { type: 'string' }, fulfillmentStatus: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 250 } } },
  confirm: false,
  summarize: () => 'read the Shopify orders',
  async run(input, ctx) {
    const { data, error } = need(ctx, 'shopify', 'Shopify');
    if (error) return error;
    const since = input.sinceDays ? Date.now() - input.sinceDays * 86_400_000 : 0;
    const rows = data.orders.filter((o) => (!since || (o.createdAt && Date.parse(o.createdAt) >= since)) && (!input.financialStatus || o.financialStatus === input.financialStatus) && (!input.fulfillmentStatus || o.fulfillmentStatus === input.fulfillmentStatus));
    const total = rows.reduce((n, o) => n + (Number(o.totalPrice) || 0), 0);
    return { ok: true, output: JSON.stringify({ count: rows.length, total: Number(total.toFixed(2)), currency: data.shop ? data.shop.currency : '', syncedAt: iso(data.syncedAt), orders: rows.slice(0, input.limit || 50) }) };
  },
};

export const shopifyInventory = {
  name: 'shopify.inventory',
  description: 'Stock per variant from the last Shopify sync: product, variant, sku, quantity. Filters: sku, productId, lowStockBelow.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { sku: { type: 'string' }, productId: { type: 'integer' }, lowStockBelow: { type: 'integer', minimum: 0 } } },
  confirm: false,
  summarize: () => 'read the Shopify stock levels',
  async run(input, ctx) {
    const { data, error } = need(ctx, 'shopify', 'Shopify');
    if (error) return error;
    const rows = [];
    for (const p of data.products) {
      if (input.productId && p.id !== input.productId) continue;
      for (const v of p.variants) {
        if (input.sku && v.sku !== input.sku) continue;
        if (typeof input.lowStockBelow === 'number' && !(typeof v.inventoryQuantity === 'number' && v.inventoryQuantity < input.lowStockBelow)) continue;
        rows.push({ productId: p.id, product: p.title, variantId: v.id, variant: v.title, sku: v.sku, quantity: v.inventoryQuantity, price: v.price });
      }
    }
    return { ok: true, output: JSON.stringify({ count: rows.length, syncedAt: iso(data.syncedAt), inventory: rows }) };
  },
};

async function withClient(ctx, kind, fn) {
  let client;
  try {
    client = await ctx.connectors.client(kind);
  } catch (err) {
    return { ok: false, code: err.code || 'NOT_CONNECTED', error: err.message };
  }
  try {
    return await fn(client);
  } catch (err) {
    return { ok: false, code: err.code || kind.toUpperCase(), error: err.message };
  }
}

export const shopifyCreateProduct = {
  name: 'shopify.create_product',
  description: 'Create a product in the Shopify store (publishing). Give title, body (HTML allowed), variants with price (and sku / quantity), and status draft or active. Original listings only.',
  inputSchema: { type: 'object', required: ['title', 'variants'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1 }, body: { type: 'string' }, vendor: { type: 'string' }, productType: { type: 'string' }, tags: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active'] }, variants: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['price'], additionalProperties: false, properties: { title: { type: 'string' }, price: { type: 'number', minimum: 0 }, sku: { type: 'string' }, inventoryQuantity: { type: 'integer', minimum: 0 } } } } } },
  confirm: false,
  summarize: (input) => `create the Shopify product "${input.title.slice(0, 60)}" (${input.status || 'draft'}, ${input.variants.length} variant(s) from ${Math.min(...input.variants.map((v) => v.price)).toFixed(2)})`,
  async run(input, ctx) {
    const { data, error } = need(ctx, 'shopify', 'Shopify');
    if (error) return error;
    return withClient(ctx, 'shopify', async (client) => {
      const product = await client.createProduct({ title: input.title, body_html: input.body || '', vendor: input.vendor, product_type: input.productType, tags: input.tags, status: input.status || 'draft', variants: input.variants.map((v) => ({ title: v.title, price: v.price.toFixed(2), sku: v.sku, inventory_quantity: v.inventoryQuantity, inventory_management: typeof v.inventoryQuantity === 'number' ? 'shopify' : undefined })) });
      const row = productRow(product);
      data.products = [row, ...data.products.filter((p) => p.id !== row.id)];
      ctx.connectors.sync('shopify', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const shopifyUpdateProduct = {
  name: 'shopify.update_product',
  description: 'Update a Shopify product (publishing): title, body, tags, status (draft | active | archived).',
  inputSchema: { type: 'object', required: ['productId'], additionalProperties: false, properties: { productId: { type: 'integer' }, title: { type: 'string', minLength: 1 }, body: { type: 'string' }, tags: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active', 'archived'] } } },
  confirm: false,
  summarize: (input) => `update Shopify product ${input.productId}: ${Object.keys(input).filter((k) => k !== 'productId').join(', ') || 'nothing'}`,
  async run(input, ctx) {
    const { data, error } = need(ctx, 'shopify', 'Shopify');
    if (error) return error;
    const patch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.body_html = input.body;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.status !== undefined) patch.status = input.status;
    if (!Object.keys(patch).length) return { ok: false, error: 'give at least one of title, body, tags, status' };
    return withClient(ctx, 'shopify', async (client) => {
      const product = await client.updateProduct(input.productId, patch);
      const row = productRow(product);
      data.products = data.products.map((p) => (p.id === row.id ? row : p));
      ctx.connectors.sync('shopify', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const shopifySetPrice = {
  name: 'shopify.set_price',
  description: 'Change a variant\'s price in the Shopify store (money_in leash). Give the variantId and the new price; compareAtPrice is optional.',
  inputSchema: { type: 'object', required: ['variantId', 'price'], additionalProperties: false, properties: { variantId: { type: 'integer' }, price: { type: 'number', minimum: 0 }, compareAtPrice: { type: 'number', minimum: 0 } } },
  confirm: false,
  summarize: (input, ctx) => `set Shopify variant ${input.variantId} price to ${input.price.toFixed(2)}`,
  async run(input, ctx) {
    const { data, error } = need(ctx, 'shopify', 'Shopify');
    if (error) return error;
    const owner = data.products.find((p) => p.variants.some((v) => v.id === input.variantId));
    if (!owner) return { ok: false, code: 'NOT_FOUND', error: `no variant ${input.variantId} in the last Shopify sync` };
    return withClient(ctx, 'shopify', async (client) => {
      const v = await client.updateVariant(input.variantId, { price: input.price.toFixed(2), ...(input.compareAtPrice !== undefined ? { compare_at_price: input.compareAtPrice.toFixed(2) } : {}) });
      const row = variantRow(v);
      owner.variants = owner.variants.map((x) => (x.id === row.id ? row : x));
      ctx.connectors.sync('shopify', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ product: owner.title, variant: row }) };
    });
  },
};

export const SHOPIFY_TOOLS = Object.freeze({
  'shopify.products': shopifyProducts,
  'shopify.orders': shopifyOrders,
  'shopify.inventory': shopifyInventory,
  'shopify.create_product': shopifyCreateProduct,
  'shopify.update_product': shopifyUpdateProduct,
  'shopify.set_price': shopifySetPrice,
});
