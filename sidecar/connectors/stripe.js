// Stripe connector (phase 2 step 15): balance, charges, payouts and refunds read into the
// local store; a refund is the one write, under money_out with its amount. Official API
// only (https://api.stripe.com/v1, bearer secret key, form-encoded writes), core modules.
//
//   createStripeClient({ apiKey, fetch, baseUrl }) -> { balance(), list(kind, params),
//                                                     listAll(kind, params, { maxPages }), createRefund(params) }
//   stripeSpec({ baseUrl })  -> a connector spec for sidecar/connectors/registry.js
//   STRIPE_TOOLS             -> stripe.balance / charges / payouts / refunds (research, from
//                               the local store) and stripe.refund (money_out)

export const STRIPE_BASE_URL = 'https://api.stripe.com/v1';
export const STRIPE_SYNC_MS = 15 * 60 * 1000;
export const STRIPE_PAGE_LIMIT = 100;
export const STRIPE_MAX_PAGES = 5;
export const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

// Minor units → major (cents → dollars; zero-decimal currencies as is).
export const isUsd = (currency) => String(currency || '').toLowerCase() === 'usd';

export function major(amountMinor, currency) {
  const n = Number(amountMinor) || 0;
  return ZERO_DECIMAL.has(String(currency || '').toLowerCase()) ? n : n / 100;
}
export function minor(amountMajor, currency) {
  const n = Number(amountMajor) || 0;
  return ZERO_DECIMAL.has(String(currency || '').toLowerCase()) ? Math.round(n) : Math.round(n * 100);
}

function encodeForm(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) out.push(encodeForm(v, key));
    else if (Array.isArray(v)) v.forEach((x, i) => out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

export function createStripeClient({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = STRIPE_BASE_URL } = {}) {
  if (!apiKey) throw new TypeError('createStripeClient needs apiKey');
  async function call(method, p, params) {
    const url = method === 'GET' && params ? `${baseUrl}${p}?${encodeForm(params)}` : `${baseUrl}${p}`;
    let res;
    try {
      res = await fetchImpl(url, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: method === 'POST' ? encodeForm(params || {}) : undefined });
    } catch (err) {
      throw fail('NETWORK', `Stripe unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw fail('BAD_RESPONSE', `Stripe answered ${res.status} with a non-JSON body`);
    }
    if (!res.ok) {
      const e = json.error || {};
      throw fail(`HTTP_${res.status}`, `Stripe ${res.status}: ${e.message || text.slice(0, 200)}${e.code ? ` (${e.code})` : ''}`, res.status);
    }
    return json;
  }
  const client = {
    balance: () => call('GET', '/balance'),
    list: (kind, params = {}) => call('GET', `/${kind}`, { limit: STRIPE_PAGE_LIMIT, ...params }),
    async listAll(kind, params = {}, { maxPages = STRIPE_MAX_PAGES } = {}) {
      const out = [];
      let after;
      for (let i = 0; i < maxPages; i++) {
        const page = await client.list(kind, { ...params, ...(after ? { starting_after: after } : {}) });
        out.push(...(page.data || []));
        if (!page.has_more || !page.data || !page.data.length) break;
        after = page.data[page.data.length - 1].id;
      }
      return out;
    },
    retrieve: (kind, id) => call('GET', `/${kind}/${encodeURIComponent(id)}`),
    createRefund: (params) => call('POST', '/refunds', params),
  };
  return client;
}

const chargeRow = (c) => ({ id: c.id, created: (c.created || 0) * 1000, amount: c.amount, amountRefunded: c.amount_refunded || 0, currency: c.currency, status: c.status, paid: Boolean(c.paid), refunded: Boolean(c.refunded), description: c.description || '', customer: typeof c.customer === 'string' ? c.customer : (c.customer && c.customer.id) || null, receiptEmail: c.receipt_email || null, paymentIntent: typeof c.payment_intent === 'string' ? c.payment_intent : null });
const payoutRow = (p) => ({ id: p.id, created: (p.created || 0) * 1000, arrivalDate: (p.arrival_date || 0) * 1000, amount: p.amount, currency: p.currency, status: p.status, method: p.method || '', description: p.description || '' });
const refundRow = (r) => ({ id: r.id, created: (r.created || 0) * 1000, amount: r.amount, currency: r.currency, status: r.status, reason: r.reason || '', charge: typeof r.charge === 'string' ? r.charge : (r.charge && r.charge.id) || null });

export function emptyStripeData() {
  return { balance: { available: [], pending: [] }, charges: [], payouts: [], refunds: [] };
}

export function summarizeStripe(data) {
  if (!data || !data.balance) return null;
  const avail = (data.balance.available || []).map((b) => `${major(b.amount, b.currency).toFixed(2)} ${String(b.currency).toUpperCase()}`).join(' + ') || '0';
  return `balance ${avail} available · ${(data.charges || []).length} charge(s) · ${(data.payouts || []).length} payout(s) · ${(data.refunds || []).length} refund(s)`;
}

export function stripeSpec({ baseUrl = STRIPE_BASE_URL } = {}) {
  return {
    kind: 'stripe',
    label: 'Stripe',
    auth: 'api_key',
    envVar: 'STRIPE_API_KEY',
    keyName: 'stripe',
    zoneKind: 'finance',
    syncEveryMs: STRIPE_SYNC_MS,
    emptyData: emptyStripeData,
    summarize: summarizeStripe,
    makeClient: ({ token, fetch: fetchImpl }) => createStripeClient({ apiKey: token.accessToken, fetch: fetchImpl, baseUrl }),
    // Reads: the balance now, the last pages of charges / payouts / refunds (newest first).
    async sync({ client, data }) {
      const [balance, charges, payouts, refunds] = await Promise.all([client.balance(), client.listAll('charges'), client.listAll('payouts'), client.listAll('refunds')]);
      const known = { charges: new Set((data.charges || []).map((c) => c.id)), refunds: new Set((data.refunds || []).map((r) => r.id)), payouts: new Set((data.payouts || []).map((p) => p.id)) };
      const next = {
        ...data,
        balance: { available: (balance.available || []).map((b) => ({ amount: b.amount, currency: b.currency })), pending: (balance.pending || []).map((b) => ({ amount: b.amount, currency: b.currency })), livemode: Boolean(balance.livemode) },
        charges: charges.map(chargeRow),
        payouts: payouts.map(payoutRow),
        refunds: refunds.map(refundRow),
      };
      return { data: next, counts: { charges: next.charges.length, newCharges: next.charges.filter((c) => !known.charges.has(c.id)).length, payouts: next.payouts.length, refunds: next.refunds.length, newRefunds: next.refunds.filter((r) => !known.refunds.has(r.id)).length } };
    },
    tools: STRIPE_TOOLS,
  };
}

function noConnectors(ctx) {
  return !ctx.connectors ? { ok: false, error: 'the connector framework is not available in this run' } : null;
}
function stripeData(ctx) {
  const st = ctx.connectors.status('stripe');
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: 'Stripe is not defined in this build' } };
  const data = ctx.connectors.data('stripe');
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: 'Stripe is not connected; ask the Superintendent to connect it at the Peak' } };
  return { data, status: st };
}
const sinceFilter = (input) => (input.sinceDays ? Date.now() - input.sinceDays * 86_400_000 : 0);

export const stripeBalance = {
  name: 'stripe.balance',
  description: 'The Stripe balance (available and pending, per currency) from the last sync, with the sync time. Set fresh to sync first.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { fresh: { type: 'boolean' } } },
  confirm: false,
  summarize: () => 'read the Stripe balance',
  async run(input, ctx) {
    const missing = noConnectors(ctx);
    if (missing) return missing;
    if (input.fresh) {
      try {
        await ctx.connectors.sync('stripe', 'ranger');
      } catch (err) {
        return { ok: false, code: err.code || 'SYNC_FAILED', error: err.message };
      }
    }
    const { data, error } = stripeData(ctx);
    if (error) return error;
    const fmt = (rows) => rows.map((b) => ({ amount: major(b.amount, b.currency), currency: b.currency }));
    return { ok: true, output: JSON.stringify({ available: fmt(data.balance.available || []), pending: fmt(data.balance.pending || []), livemode: Boolean(data.balance.livemode), syncedAt: data.syncedAt ? new Date(data.syncedAt).toISOString() : null }) };
  },
};

function listTool(name, key, description, rowFn) {
  return {
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 }, sinceDays: { type: 'integer', minimum: 1, maximum: 365 }, status: { type: 'string' } } },
    confirm: false,
    summarize: () => `read Stripe ${key}`,
    async run(input, ctx) {
      const missing = noConnectors(ctx);
      if (missing) return missing;
      const { data, error } = stripeData(ctx);
      if (error) return error;
      const since = sinceFilter(input);
      let rows = (data[key] || []).filter((r) => r.created >= since && (!input.status || r.status === input.status));
      const total = rows.reduce((n, r) => n + major(r.amount, r.currency), 0);
      rows = rows.slice(0, input.limit || 50).map(rowFn);
      return { ok: true, output: JSON.stringify({ count: rows.length, totalAmount: Number(total.toFixed(2)), syncedAt: data.syncedAt ? new Date(data.syncedAt).toISOString() : null, [key]: rows }) };
    },
  };
}
const withMajor = (r) => ({ ...r, created: new Date(r.created).toISOString(), amount: major(r.amount, r.currency), ...(r.amountRefunded !== undefined ? { amountRefunded: major(r.amountRefunded, r.currency) } : {}) });

export const stripeCharges = listTool('stripe.charges', 'charges', 'Charges from the last Stripe sync (newest first): id, amount, currency, status, customer, description. Filters: limit, sinceDays, status.', withMajor);
export const stripePayouts = listTool('stripe.payouts', 'payouts', 'Payouts to the bank from the last Stripe sync: id, amount, arrival date, status.', (r) => ({ ...withMajor(r), arrivalDate: new Date(r.arrivalDate).toISOString() }));
export const stripeRefunds = listTool('stripe.refunds', 'refunds', 'Refunds from the last Stripe sync: id, amount, charge, reason, status.', withMajor);

export const stripeRefund = {
  name: 'stripe.refund',
  description: 'Refund a USD charge (money out; follows the money_out leash and its daily cap; a charge in another currency is refused). Give the charge id; amountUsd defaults to the full remaining amount. reason: duplicate | fraudulent | requested_by_customer.',
  inputSchema: { type: 'object', required: ['chargeId'], additionalProperties: false, properties: { chargeId: { type: 'string', minLength: 1 }, amountUsd: { type: 'number', exclusiveMinimum: 0 }, reason: { type: 'string', enum: ['duplicate', 'fraudulent', 'requested_by_customer'] }, note: { type: 'string' } } },
  confirm: false,
  domain: 'money_out',
  // The money the Gate and the ledger see: the given amount, else the charge's remaining
  // amount from the last sync. An unknown charge is null (safety H2: the amount cannot be
  // proven, so the gate sends it to the Gate and run() refuses it).
  // Safety L2: the ledger counts USD, so only a USD charge has a provable amount; a charge
  // in another currency is unknown here (the Gate) and refused in run().
  amountUsd: (input, ctx) => {
    const data = ctx && ctx.connectors && ctx.connectors.status('stripe') ? ctx.connectors.data('stripe') : null;
    const charge = data ? (data.charges || []).find((c) => c.id === input.chargeId) : null;
    if (!charge || !isUsd(charge.currency)) return null;
    if (typeof input.amountUsd === 'number') return input.amountUsd;
    return major(charge.amount - (charge.amountRefunded || 0), charge.currency);
  },
  summarize: (input) => `refund ${typeof input.amountUsd === 'number' ? `$${input.amountUsd.toFixed(2)} of ` : ''}Stripe charge ${input.chargeId}${input.reason ? ` (${input.reason})` : ''}`,
  async run(input, ctx) {
    const missing = noConnectors(ctx);
    if (missing) return missing;
    const { data, error } = stripeData(ctx);
    if (error) return error;
    const charge = (data.charges || []).find((c) => c.id === input.chargeId);
    if (!charge) return { ok: false, code: 'NOT_FOUND', error: `no charge ${input.chargeId} in the last Stripe sync; sync first or check the id` };
    if (!isUsd(charge.currency)) return { ok: false, code: 'NON_USD', error: `charge ${input.chargeId} is in ${String(charge.currency || '?').toUpperCase()}; the park's ledger and caps count USD, so refunds from here are USD charges only (safety L2). Ask the Superintendent to refund it in the Stripe dashboard.` };
    const remaining = charge.amount - (charge.amountRefunded || 0);
    const amountMinor = typeof input.amountUsd === 'number' ? minor(input.amountUsd, charge.currency) : remaining;
    if (amountMinor <= 0 || amountMinor > remaining) return { ok: false, code: 'BAD_AMOUNT', error: `refund must be between 0 and the remaining ${major(remaining, charge.currency)} ${charge.currency.toUpperCase()}` };
    let client;
    try {
      client = await ctx.connectors.client('stripe');
    } catch (err) {
      return { ok: false, code: err.code || 'NOT_CONNECTED', error: err.message };
    }
    try {
      const r = await client.createRefund({ charge: input.chargeId, amount: amountMinor, ...(input.reason ? { reason: input.reason } : {}), ...(input.note ? { metadata: { note: input.note.slice(0, 500), by: `maka:${ctx.agentId || 'ranger'}` } } : { metadata: { by: `maka:${ctx.agentId || 'ranger'}` } }) });
      const row = refundRow(r);
      data.refunds = [row, ...(data.refunds || []).filter((x) => x.id !== row.id)];
      charge.amountRefunded = (charge.amountRefunded || 0) + row.amount;
      charge.refunded = charge.amountRefunded >= charge.amount;
      ctx.connectors.sync('stripe', 'after-refund').catch(() => {});
      return { ok: true, output: JSON.stringify({ ...withMajor(row), charge: input.chargeId }) };
    } catch (err) {
      return { ok: false, code: err.code || 'STRIPE', error: err.message };
    }
  },
};

export const STRIPE_TOOLS = Object.freeze({
  'stripe.balance': stripeBalance,
  'stripe.charges': stripeCharges,
  'stripe.payouts': stripePayouts,
  'stripe.refunds': stripeRefunds,
  'stripe.refund': stripeRefund,
});
