// A fake Stripe API on an ephemeral port: /v1/balance, /v1/charges, /v1/payouts,
// /v1/refunds (list with cursor pagination; POST creates a refund and updates the charge).
// Bearer secret key; errors in Stripe's shape. Test-only.
import http from 'node:http';

const now = () => Math.floor(Date.now() / 1000);

export async function startFakeStripe({ apiKey = 'sk_test_fake', charges = null, payouts = null, pageSize = 100 } = {}) {
  const state = {
    calls: [],
    balance: { object: 'balance', available: [{ amount: 125_00, currency: 'usd' }], pending: [{ amount: 40_00, currency: 'usd' }], livemode: false },
    charges: charges || [
      { id: 'ch_3', object: 'charge', amount: 2500, amount_refunded: 0, currency: 'usd', status: 'succeeded', paid: true, refunded: false, description: 'Lantern, red', customer: 'cus_a', receipt_email: 'a@example.com', created: now() - 3600, payment_intent: 'pi_3' },
      { id: 'ch_2', object: 'charge', amount: 4000, amount_refunded: 1000, currency: 'usd', status: 'succeeded', paid: true, refunded: false, description: 'Lantern, blue ×2', customer: 'cus_b', created: now() - 2 * 86400 },
      { id: 'ch_1', object: 'charge', amount: 1500, amount_refunded: 0, currency: 'usd', status: 'failed', paid: false, refunded: false, description: 'Declined', customer: null, created: now() - 10 * 86400 },
    ],
    payouts: payouts || [{ id: 'po_1', object: 'payout', amount: 6000, currency: 'usd', status: 'paid', method: 'standard', arrival_date: now() - 86400, created: now() - 2 * 86400, description: 'STRIPE PAYOUT' }],
    refunds: [{ id: 're_1', object: 'refund', amount: 1000, currency: 'usd', status: 'succeeded', reason: 'requested_by_customer', charge: 'ch_2', created: now() - 86400 }],
    fail: null,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? Object.fromEntries(new URLSearchParams(raw)) : null;
    state.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const error = (status, type, message, code) => send(status, { error: { type, message, ...(code ? { code } : {}) } });
    if (req.headers.authorization !== `Bearer ${apiKey}`) return error(401, 'invalid_request_error', 'Invalid API Key provided');
    if (state.fail) return error(state.fail.status || 500, 'api_error', state.fail.message || 'down');
    const page = (rows) => {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 10, pageSize);
      const after = url.searchParams.get('starting_after');
      let start = 0;
      if (after) {
        const i = rows.findIndex((r) => r.id === after);
        if (i < 0) return error(400, 'invalid_request_error', `No such object: ${after}`, 'resource_missing');
        start = i + 1;
      }
      const data = rows.slice(start, start + limit);
      return send(200, { object: 'list', data, has_more: start + limit < rows.length, url: url.pathname });
    };
    if (req.method === 'GET' && url.pathname === '/v1/balance') return send(200, state.balance);
    if (req.method === 'GET' && url.pathname === '/v1/charges') return page(state.charges);
    if (req.method === 'GET' && url.pathname === '/v1/payouts') return page(state.payouts);
    if (req.method === 'GET' && url.pathname === '/v1/refunds') return page(state.refunds);
    if (req.method === 'POST' && url.pathname === '/v1/refunds') {
      if (!body || !body.charge) return error(400, 'invalid_request_error', 'Must provide a charge', 'parameter_missing');
      const ch = state.charges.find((c) => c.id === body.charge);
      if (!ch) return error(404, 'invalid_request_error', `No such charge: '${body.charge}'`, 'resource_missing');
      const amount = body.amount ? Number(body.amount) : ch.amount - ch.amount_refunded;
      if (amount <= 0 || amount > ch.amount - ch.amount_refunded) return error(400, 'invalid_request_error', 'Refund amount exceeds the charge', 'amount_too_large');
      if (body.reason && !['duplicate', 'fraudulent', 'requested_by_customer'].includes(body.reason)) return error(400, 'invalid_request_error', 'Invalid reason');
      const r = { id: `re_${state.refunds.length + 1}`, object: 'refund', amount, currency: ch.currency, status: 'succeeded', reason: body.reason || null, charge: ch.id, created: now(), metadata: Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) };
      ch.amount_refunded += amount;
      ch.refunded = ch.amount_refunded >= ch.amount;
      state.refunds.unshift(r);
      state.balance.available[0].amount -= amount;
      return send(200, r);
    }
    error(404, 'invalid_request_error', `Unrecognized request URL (${req.method}: ${url.pathname})`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
