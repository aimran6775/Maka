// Etsy connector (phase 2 step 16): Open API v3 of one shop over OAuth 2 PKCE (the
// framework's flow; ETSY_CLIENT_ID is the app's keystring, sent as x-api-key with every
// call). Reads: the shop, listings (with quantity and price), receipts (orders). Writes: a
// draft listing created or a listing updated (publishing), a price change through the
// listing's inventory (money_in). Official API only; no supplier purchase exists here
// (docs/DECISIONS.md D80).
//
//   createEtsyClient({ clientId, accessToken, fetch, baseUrl })
//   etsySpec({ baseUrl, authorizeUrl, tokenUrl })  -> a connector spec
//   ETSY_TOOLS

export const ETSY_BASE_URL = 'https://api.etsy.com/v3/application';
export const ETSY_AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
export const ETSY_SCOPES = ['listings_r', 'listings_w', 'transactions_r', 'shops_r'];
export const ETSY_SYNC_MS = 15 * 60 * 1000;
export const ETSY_PAGE_LIMIT = 100;
export const ETSY_MAX_PAGES = 3;

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export const etsyMoney = (m) => (m && typeof m.amount === 'number' ? m.amount / (m.divisor || 100) : null);

export function createEtsyClient({ clientId, accessToken, fetch: fetchImpl = globalThis.fetch, baseUrl = ETSY_BASE_URL } = {}) {
  if (!clientId) throw fail('NO_CLIENT_ID', 'Etsy needs ETSY_CLIENT_ID (the app keystring) in the environment or keystore');
  if (!accessToken) throw new TypeError('createEtsyClient needs accessToken');
  async function call(method, p, { params, body } = {}) {
    const url = new URL(`${baseUrl}${p}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url.toString(), { method, headers: { 'x-api-key': clientId, authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw fail('NETWORK', `Etsy unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw fail('BAD_RESPONSE', `Etsy answered ${res.status} with a non-JSON body`);
    }
    if (!res.ok) throw fail(`HTTP_${res.status}`, `Etsy ${res.status}: ${json.error || text.slice(0, 200)}`, res.status);
    return json;
  }
  let shopId = null;
  const client = {
    async me() {
      return call('GET', '/users/me');
    },
    async shopId() {
      if (shopId) return shopId;
      const me = await client.me();
      if (!me.shop_id) throw fail('NO_SHOP', 'this Etsy account has no shop');
      shopId = me.shop_id;
      return shopId;
    },
    async shop() {
      return call('GET', `/shops/${await client.shopId()}`);
    },
    async listAll(p, params = {}, { maxPages = ETSY_MAX_PAGES } = {}) {
      const out = [];
      for (let i = 0; i < maxPages; i++) {
        const page = await call('GET', p, { params: { limit: ETSY_PAGE_LIMIT, offset: out.length, ...params } });
        out.push(...(page.results || []));
        if (!page.results || !page.results.length || out.length >= (page.count || 0)) break;
      }
      return out;
    },
    async listings(state = 'active') {
      return client.listAll(`/shops/${await client.shopId()}/listings`, { state });
    },
    async receipts() {
      return client.listAll(`/shops/${await client.shopId()}/receipts`);
    },
    inventory: (listingId) => call('GET', `/listings/${encodeURIComponent(listingId)}/inventory`),
    updateInventory: (listingId, body) => call('PUT', `/listings/${encodeURIComponent(listingId)}/inventory`, { body }),
    createDraftListing: async (body) => call('POST', `/shops/${await client.shopId()}/listings`, { body }),
    updateListing: async (listingId, body) => call('PATCH', `/shops/${await client.shopId()}/listings/${encodeURIComponent(listingId)}`, { body }),
  };
  return client;
}

const listingRow = (l) => ({ listingId: l.listing_id, title: l.title, state: l.state, quantity: l.quantity, price: etsyMoney(l.price), currency: (l.price && l.price.currency_code) || '', url: l.url || '', tags: l.tags || [], updatedAt: l.updated_timestamp ? l.updated_timestamp * 1000 : null, createdAt: l.created_timestamp ? l.created_timestamp * 1000 : null });
const receiptRow = (r) => ({ receiptId: r.receipt_id, createdAt: r.created_timestamp ? r.created_timestamp * 1000 : null, status: r.status || '', paid: Boolean(r.is_paid), shipped: Boolean(r.is_shipped), grandTotal: etsyMoney(r.grandtotal), currency: (r.grandtotal && r.grandtotal.currency_code) || '', buyer: r.name || r.buyer_email || String(r.buyer_user_id || ''), items: (r.transactions || []).map((t) => ({ title: t.title, quantity: t.quantity, price: etsyMoney(t.price), listingId: t.listing_id })) });

export function emptyEtsyData() {
  return { shop: null, listings: [], receipts: [] };
}

export function summarizeEtsy(data) {
  if (!data || !Array.isArray(data.listings)) return null;
  const week = Date.now() - 7 * 86_400_000;
  const recent = (data.receipts || []).filter((r) => r.createdAt >= week && r.paid);
  const revenue = recent.reduce((n, r) => n + (r.grandTotal || 0), 0);
  const cur = (data.shop && data.shop.currency) || (recent[0] && recent[0].currency) || '';
  return `${data.shop && data.shop.name ? `${data.shop.name} · ` : ''}${data.listings.length} listing(s) · ${(data.receipts || []).length} receipt(s) · last 7 days: ${recent.length} paid, ${revenue.toFixed(2)} ${cur}`.trim();
}

export function etsySpec({ baseUrl = ETSY_BASE_URL, authorizeUrl = ETSY_AUTHORIZE_URL, tokenUrl = ETSY_TOKEN_URL } = {}) {
  return {
    kind: 'etsy',
    label: 'Etsy',
    auth: 'oauth2',
    keyName: 'etsy',
    zoneKinds: ['product_listings', 'sales'],
    syncEveryMs: ETSY_SYNC_MS,
    oauth: { authorizeUrl, tokenUrl, clientIdKey: 'etsyClientId', scopes: ETSY_SCOPES },
    emptyData: emptyEtsyData,
    summarize: summarizeEtsy,
    makeClient: async ({ token, fetch: fetchImpl, keys }) => createEtsyClient({ clientId: await keys.get('etsyClientId'), accessToken: token.accessToken, fetch: fetchImpl, baseUrl }),
    async sync({ client, data }) {
      const shop = await client.shop();
      const [active, drafts, receipts] = await Promise.all([client.listings('active'), client.listings('draft'), client.receipts()]);
      const known = new Set((data.receipts || []).map((r) => r.receiptId));
      const next = { ...data, shop: { shopId: shop.shop_id, name: shop.shop_name, currency: shop.currency_code || '', url: shop.url || '' }, listings: [...active, ...drafts].map(listingRow), receipts: receipts.map(receiptRow) };
      return { data: next, counts: { listings: next.listings.length, drafts: drafts.length, receipts: next.receipts.length, newReceipts: next.receipts.filter((r) => !known.has(r.receiptId)).length } };
    },
    tools: ETSY_TOOLS,
  };
}

// ---- tools ----

function need(ctx) {
  if (!ctx.connectors) return { error: { ok: false, error: 'the connector framework is not available in this run' } };
  const st = ctx.connectors.status('etsy');
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: 'Etsy is not defined in this build' } };
  const data = ctx.connectors.data('etsy');
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: 'Etsy is not connected; ask the Superintendent to sign in at the Peak' } };
  return { data, status: st };
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(String(q).toLowerCase()));

async function withClient(ctx, fn) {
  let client;
  try {
    client = await ctx.connectors.client('etsy');
  } catch (err) {
    return { ok: false, code: err.code || 'NOT_CONNECTED', error: err.message };
  }
  try {
    return await fn(client);
  } catch (err) {
    return { ok: false, code: err.code || 'ETSY', error: err.message };
  }
}

export const etsyListings = {
  name: 'etsy.listings',
  description: 'Listings from the last Etsy sync: id, title, state (active | draft), quantity, price. Filters: query, state, limit.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, state: { type: 'string', enum: ['active', 'draft', 'inactive', 'sold_out', 'expired'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Etsy listings',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.listings.filter((l) => (!input.state || l.state === input.state) && matches(input.query, l.title, ...(l.tags || [])));
    return { ok: true, output: JSON.stringify({ shop: data.shop, count: rows.length, syncedAt: iso(data.syncedAt), listings: rows.slice(0, input.limit || 50).map((l) => ({ ...l, updatedAt: iso(l.updatedAt), createdAt: iso(l.createdAt) })) }) };
  },
};

export const etsyReceipts = {
  name: 'etsy.receipts',
  description: 'Orders (receipts) from the last Etsy sync, newest first: id, date, paid / shipped, total, buyer, items. Filters: sinceDays, unshippedOnly, limit.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { sinceDays: { type: 'integer', minimum: 1, maximum: 365 }, unshippedOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Etsy orders',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const since = input.sinceDays ? Date.now() - input.sinceDays * 86_400_000 : 0;
    const rows = data.receipts.filter((r) => (!since || r.createdAt >= since) && (!input.unshippedOnly || (r.paid && !r.shipped)));
    const total = rows.reduce((n, r) => n + (r.grandTotal || 0), 0);
    return { ok: true, output: JSON.stringify({ count: rows.length, total: Number(total.toFixed(2)), currency: data.shop ? data.shop.currency : '', syncedAt: iso(data.syncedAt), receipts: rows.slice(0, input.limit || 50).map((r) => ({ ...r, createdAt: iso(r.createdAt) })) }) };
  },
};

export const etsyInventory = {
  name: 'etsy.inventory',
  description: 'Stock and price per listing from the last Etsy sync. Filters: listingId, lowStockBelow.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { listingId: { type: 'integer' }, lowStockBelow: { type: 'integer', minimum: 0 } } },
  confirm: false,
  summarize: () => 'read the Etsy stock levels',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.listings.filter((l) => (!input.listingId || l.listingId === input.listingId) && (typeof input.lowStockBelow !== 'number' || (typeof l.quantity === 'number' && l.quantity < input.lowStockBelow))).map((l) => ({ listingId: l.listingId, title: l.title, state: l.state, quantity: l.quantity, price: l.price, currency: l.currency }));
    return { ok: true, output: JSON.stringify({ count: rows.length, syncedAt: iso(data.syncedAt), inventory: rows }) };
  },
};

export const etsyCreateListing = {
  name: 'etsy.create_listing',
  description: 'Create a DRAFT listing in the Etsy shop (publishing). Needs title, description, price, quantity, whoMade (i_did | someone_else | collective), whenMade (made_to_order | 2020_2026 | …), taxonomyId; shippingProfileId and tags optional. Original work only; activate it with etsy.update_listing after review.',
  inputSchema: { type: 'object', required: ['title', 'description', 'price', 'quantity', 'whoMade', 'whenMade', 'taxonomyId'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 140 }, description: { type: 'string', minLength: 1 }, price: { type: 'number', exclusiveMinimum: 0 }, quantity: { type: 'integer', minimum: 1 }, whoMade: { type: 'string', enum: ['i_did', 'someone_else', 'collective'] }, whenMade: { type: 'string', minLength: 1 }, taxonomyId: { type: 'integer' }, shippingProfileId: { type: 'integer' }, tags: { type: 'array', maxItems: 13, items: { type: 'string', minLength: 1, maxLength: 20 } } } },
  confirm: false,
  summarize: (input) => `create the Etsy draft listing "${input.title.slice(0, 60)}" at ${input.price.toFixed(2)} × ${input.quantity}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    return withClient(ctx, async (client) => {
      const l = await client.createDraftListing({ quantity: input.quantity, title: input.title, description: input.description, price: input.price, who_made: input.whoMade, when_made: input.whenMade, taxonomy_id: input.taxonomyId, ...(input.shippingProfileId ? { shipping_profile_id: input.shippingProfileId } : {}), ...(input.tags ? { tags: input.tags } : {}), type: 'physical' });
      const row = listingRow(l);
      data.listings = [row, ...data.listings.filter((x) => x.listingId !== row.listingId)];
      ctx.connectors.sync('etsy', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ ...row, updatedAt: iso(row.updatedAt), createdAt: iso(row.createdAt) }) };
    });
  },
};

export const etsyUpdateListing = {
  name: 'etsy.update_listing',
  description: 'Update an Etsy listing (publishing): title, description, tags, state (active | inactive | draft).',
  inputSchema: { type: 'object', required: ['listingId'], additionalProperties: false, properties: { listingId: { type: 'integer' }, title: { type: 'string', minLength: 1, maxLength: 140 }, description: { type: 'string' }, tags: { type: 'array', maxItems: 13, items: { type: 'string' } }, state: { type: 'string', enum: ['active', 'inactive', 'draft'] } } },
  confirm: false,
  summarize: (input) => `update Etsy listing ${input.listingId}: ${Object.keys(input).filter((k) => k !== 'listingId').join(', ') || 'nothing'}${input.state ? ` (→ ${input.state})` : ''}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const patch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.state !== undefined) patch.state = input.state;
    if (!Object.keys(patch).length) return { ok: false, error: 'give at least one of title, description, tags, state' };
    return withClient(ctx, async (client) => {
      const l = await client.updateListing(input.listingId, patch);
      const row = listingRow(l);
      data.listings = data.listings.some((x) => x.listingId === row.listingId) ? data.listings.map((x) => (x.listingId === row.listingId ? row : x)) : [row, ...data.listings];
      ctx.connectors.sync('etsy', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ ...row, updatedAt: iso(row.updatedAt), createdAt: iso(row.createdAt) }) };
    });
  },
};

export const etsySetPrice = {
  name: 'etsy.set_price',
  description: 'Change a listing\'s price on Etsy (money_in leash): every offering of the listing gets the new price through its inventory.',
  inputSchema: { type: 'object', required: ['listingId', 'price'], additionalProperties: false, properties: { listingId: { type: 'integer' }, price: { type: 'number', exclusiveMinimum: 0 } } },
  confirm: false,
  summarize: (input) => `set Etsy listing ${input.listingId} price to ${input.price.toFixed(2)}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const listing = data.listings.find((l) => l.listingId === input.listingId);
    if (!listing) return { ok: false, code: 'NOT_FOUND', error: `no listing ${input.listingId} in the last Etsy sync` };
    return withClient(ctx, async (client) => {
      const inv = await client.inventory(input.listingId);
      // Etsy wants the whole products array back, with read-only ids stripped.
      const products = (inv.products || []).map((p) => ({ sku: p.sku || '', property_values: (p.property_values || []).map((pv) => ({ property_id: pv.property_id, value_ids: pv.value_ids, scale_id: pv.scale_id, property_name: pv.property_name, values: pv.values })), offerings: (p.offerings || []).map((o) => ({ price: input.price, quantity: o.quantity, is_enabled: o.is_enabled !== false })) }));
      if (!products.length) products.push({ sku: '', property_values: [], offerings: [{ price: input.price, quantity: listing.quantity || 1, is_enabled: true }] });
      const out = await client.updateInventory(input.listingId, { products, price_on_property: inv.price_on_property || [], quantity_on_property: inv.quantity_on_property || [], sku_on_property: inv.sku_on_property || [] });
      listing.price = input.price;
      ctx.connectors.sync('etsy', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ listingId: input.listingId, title: listing.title, price: input.price, offerings: (out.products || products).reduce((n, p) => n + (p.offerings || []).length, 0) }) };
    });
  },
};

export const ETSY_TOOLS = Object.freeze({
  'etsy.listings': etsyListings,
  'etsy.receipts': etsyReceipts,
  'etsy.inventory': etsyInventory,
  'etsy.create_listing': etsyCreateListing,
  'etsy.update_listing': etsyUpdateListing,
  'etsy.set_price': etsySetPrice,
});
