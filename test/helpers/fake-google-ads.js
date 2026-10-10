// A fake Google Ads API on an ephemeral port: the OAuth token endpoint (PKCE, client
// secret in the body, refresh), searchStream answering the customer / campaign / metrics
// GAQL queries, campaignBudgets:mutate and campaigns:mutate. Headers: bearer token and
// developer-token. Test-only.
import http from 'node:http';
import { createHash } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startFakeGoogleAds({ clientId = 'gads-client.apps.googleusercontent.com', clientSecret = 'gads-secret', developerToken = 'dev-token', customerId = '1234567890' } = {}) {
  const state = {
    calls: [],
    codes: new Map(),
    tokens: new Map([['ya29.seed', { refresh: '1//seed' }]]),
    refreshes: 0,
    customer: { id: customerId, descriptiveName: 'Lantern Co', currencyCode: 'USD', timeZone: 'America/New_York' },
    budgets: new Map([['b1', { amountMicros: 15_000_000, name: 'Search budget' }]]),
    campaigns: [
      { id: '9001', name: 'Lanterns – Search', status: 'ENABLED', advertisingChannelType: 'SEARCH', startDate: '2026-09-01', budgetId: 'b1' },
      { id: '9002', name: 'Lanterns – Shopping', status: 'PAUSED', advertisingChannelType: 'SHOPPING', startDate: '2026-08-01', budgetId: 'b1' },
    ],
    metrics: [{ campaignId: '9001', costMicros: '61250000', impressions: '9800', clicks: '310', conversions: 4, conversionsValue: 120.5 }],
    fail: null,
  };
  let n = 9100;
  let bn = 2;
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
    const gerror = (status, message, detail) => send(status, [{ error: { code: status, message, status: 'INVALID_ARGUMENT', details: detail ? [{ errors: [{ message: detail }] }] : [] } }]);
    if (req.method === 'POST' && url.pathname === '/token') {
      if (body.client_id !== clientId || body.client_secret !== clientSecret) return send(401, { error: 'invalid_client', error_description: 'Unauthorized' });
      if (body.grant_type === 'authorization_code') {
        const c = state.codes.get(body.code);
        if (!c || c.redirectUri !== body.redirect_uri) return send(400, { error: 'invalid_grant', error_description: 'Bad Request' });
        if (b64url(createHash('sha256').update(body.code_verifier || '').digest()) !== c.challenge) return send(400, { error: 'invalid_grant', error_description: 'code_verifier mismatch' });
        state.codes.delete(body.code);
        const access = `ya29.${state.tokens.size}`;
        state.tokens.set(access, { refresh: `1//${state.tokens.size}` });
        return send(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: 3599, token_type: 'Bearer', scope: c.scope });
      }
      if (body.grant_type === 'refresh_token') {
        const entry = [...state.tokens.values()].find((t) => t.refresh === body.refresh_token);
        if (!entry) return send(400, { error: 'invalid_grant' });
        state.refreshes += 1;
        const access = `ya29.${state.tokens.size}`;
        state.tokens.set(access, { refresh: body.refresh_token });
        return send(200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!state.tokens.has(bearer)) return send(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    if (req.headers['developer-token'] !== developerToken) return gerror(401, 'The developer token is not valid.', 'DEVELOPER_TOKEN_INVALID');
    if (state.fail) return gerror(state.fail.status || 500, state.fail.message || 'down');
    const m = /^\/v\d+\/customers\/(\d+)\/(.+)$/.exec(url.pathname);
    if (!m) return gerror(404, 'not found');
    if (m[1] !== customerId) return gerror(403, 'The caller does not have permission', 'USER_PERMISSION_DENIED');
    const budgetRow = (id) => ({ resourceName: `customers/${customerId}/campaignBudgets/${id}`, id, amountMicros: String(state.budgets.get(id).amountMicros) });
    if (req.method === 'POST' && m[2] === 'googleAds:searchStream') {
      const q = String(body.query || '');
      if (/FROM customer/.test(q)) return send(200, [{ results: [{ customer: state.customer }] }]);
      if (/metrics\./.test(q)) return send(200, [{ results: state.metrics.map((r) => ({ campaign: { id: r.campaignId, name: state.campaigns.find((c) => c.id === r.campaignId).name }, metrics: { costMicros: r.costMicros, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, conversionsValue: r.conversionsValue } })) }]);
      if (/FROM campaign/.test(q)) return send(200, [{ results: state.campaigns.filter((c) => c.status !== 'REMOVED').map((c) => ({ campaign: { id: c.id, name: c.name, status: c.status, advertisingChannelType: c.advertisingChannelType, startDate: c.startDate }, campaignBudget: budgetRow(c.budgetId) })) }]);
      return gerror(400, 'Query error', 'Unrecognized field');
    }
    if (req.method === 'POST' && m[2] === 'campaignBudgets:mutate') {
      const results = [];
      for (const op of body.operations || []) {
        if (op.create) {
          const id = `b${++bn}`;
          state.budgets.set(id, { amountMicros: Number(op.create.amountMicros), name: op.create.name });
          results.push({ resourceName: `customers/${customerId}/campaignBudgets/${id}` });
        } else if (op.update) {
          const id = String(op.update.resourceName).split('/').pop();
          if (!state.budgets.has(id)) return gerror(400, 'Request contains an invalid argument.', 'RESOURCE_NOT_FOUND');
          state.budgets.get(id).amountMicros = Number(op.update.amountMicros);
          results.push({ resourceName: op.update.resourceName });
        }
      }
      return send(200, { results });
    }
    if (req.method === 'POST' && m[2] === 'campaigns:mutate') {
      const results = [];
      for (const op of body.operations || []) {
        if (op.create) {
          if (!op.create.campaignBudget) return gerror(400, 'Request contains an invalid argument.', 'REQUIRED: campaign_budget');
          const id = String(++n);
          state.campaigns.unshift({ id, name: op.create.name, status: op.create.status || 'PAUSED', advertisingChannelType: op.create.advertisingChannelType, startDate: null, budgetId: String(op.create.campaignBudget).split('/').pop() });
          results.push({ resourceName: `customers/${customerId}/campaigns/${id}` });
        } else if (op.update) {
          const id = String(op.update.resourceName).split('/').pop();
          const c = state.campaigns.find((x) => x.id === id);
          if (!c) return gerror(400, 'Request contains an invalid argument.', 'RESOURCE_NOT_FOUND');
          if (op.update.status) c.status = op.update.status;
          results.push({ resourceName: op.update.resourceName });
        }
      }
      return send(200, { results });
    }
    gerror(404, `no route ${m[2]}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    baseUrl: `${url}/v18`,
    tokenUrl: `${url}/token`,
    authorizeUrl: `${url}/o/oauth2/v2/auth`,
    clientId,
    clientSecret,
    developerToken,
    customerId,
    state,
    authorize(authorizeUrl) {
      const u = new URL(authorizeUrl);
      const code = `4/${state.codes.size + 1}`;
      state.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirectUri: u.searchParams.get('redirect_uri'), scope: u.searchParams.get('scope') });
      return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri'), scope: u.searchParams.get('scope'), accessType: u.searchParams.get('access_type'), prompt: u.searchParams.get('prompt') };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
