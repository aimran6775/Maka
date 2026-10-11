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
    adGroups: [{ id: '5001', name: 'Lanterns – exact', status: 'ENABLED', type: 'SEARCH_STANDARD', campaignId: '9001', cpcBidMicros: '1200000' }],
    ads: [{ id: '7001', name: 'RSA 1', status: 'ENABLED', type: 'RESPONSIVE_SEARCH_AD', adGroupId: '5001', campaignId: '9001', finalUrls: ['https://lanterns.example/shop'], headlines: ['Handmade Lanterns', 'Light Your Evenings', 'Free Shipping'], descriptions: ['Hand-finished lanterns for porches and gardens.', 'Ships in two days.'], path1: 'lanterns', path2: '' }],
    assets: [{ id: '3001', name: 'hero.jpg', type: 'IMAGE', url: 'https://cdn.example/hero.jpg', fileSize: '20480' }],
    metrics: [{ campaignId: '9001', costMicros: '61250000', impressions: '9800', clicks: '310', conversions: 4, conversionsValue: 120.5 }],
    // segments.date rows (phase 4 step 9): one per campaign per day.
    metricsDaily: [
      { campaignId: '9001', date: '2026-10-08', costMicros: '8750000', impressions: '1400', clicks: '44', conversions: 1, conversionsValue: 30.5 },
      { campaignId: '9001', date: '2026-10-09', costMicros: '8250000', impressions: '1300', clicks: '41', conversions: 0, conversionsValue: 0 },
    ],
    fail: null,
  };
  let n = 9100;
  let bn = 2;
  let an = 5100;
  let adn = 7100;
  let asn = 3100;
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
      if (/segments\.date,/.test(q)) return send(200, [{ results: state.metricsDaily.map((r) => ({ campaign: { id: r.campaignId, name: state.campaigns.find((c) => c.id === r.campaignId).name }, segments: { date: r.date }, metrics: { costMicros: r.costMicros, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, conversionsValue: r.conversionsValue } })) }]);
      if (/metrics\./.test(q)) return send(200, [{ results: state.metrics.map((r) => ({ campaign: { id: r.campaignId, name: state.campaigns.find((c) => c.id === r.campaignId).name }, metrics: { costMicros: r.costMicros, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, conversionsValue: r.conversionsValue } })) }]);
      if (/FROM ad_group_ad/.test(q)) return send(200, [{ results: state.ads.filter((a) => a.status !== 'REMOVED').map((a) => ({ adGroupAd: { status: a.status, ad: { id: a.id, name: a.name, type: a.type, finalUrls: a.finalUrls, responsiveSearchAd: { headlines: a.headlines.map((text) => ({ text })), descriptions: a.descriptions.map((text) => ({ text })), path1: a.path1, path2: a.path2 } } }, adGroup: { id: a.adGroupId }, campaign: { id: a.campaignId } })) }]);
      if (/FROM ad_group/.test(q)) return send(200, [{ results: state.adGroups.filter((g) => g.status !== 'REMOVED').map((g) => ({ adGroup: { id: g.id, name: g.name, status: g.status, type: g.type, campaign: `customers/${customerId}/campaigns/${g.campaignId}`, cpcBidMicros: g.cpcBidMicros } })) }]);
      if (/FROM asset/.test(q)) return send(200, [{ results: state.assets.map((a) => ({ asset: { id: a.id, name: a.name, type: a.type, imageAsset: { fullSize: { url: a.url }, fileSize: a.fileSize } } })) }]);
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
    if (req.method === 'POST' && m[2] === 'adGroups:mutate') {
      const results = [];
      for (const op of body.operations || []) {
        if (op.create) {
          const campaignId = String(op.create.campaign).split('/').pop();
          if (!state.campaigns.some((c) => c.id === campaignId)) return gerror(400, 'Request contains an invalid argument.', 'RESOURCE_NOT_FOUND: campaign');
          const id = String(++an);
          state.adGroups.unshift({ id, name: op.create.name, status: op.create.status || 'PAUSED', type: op.create.type || 'SEARCH_STANDARD', campaignId, cpcBidMicros: String(op.create.cpcBidMicros || 0) });
          results.push({ resourceName: `customers/${customerId}/adGroups/${id}` });
        } else if (op.update) {
          const g = state.adGroups.find((x) => x.id === String(op.update.resourceName).split('/').pop());
          if (!g) return gerror(400, 'Request contains an invalid argument.', 'RESOURCE_NOT_FOUND');
          if (op.update.status) g.status = op.update.status;
          results.push({ resourceName: op.update.resourceName });
        }
      }
      return send(200, { results });
    }
    if (req.method === 'POST' && m[2] === 'adGroupAds:mutate') {
      const results = [];
      for (const op of body.operations || []) {
        if (op.create) {
          const adGroupId = String(op.create.adGroup).split('/').pop();
          const g = state.adGroups.find((x) => x.id === adGroupId);
          if (!g) return gerror(400, 'Request contains an invalid argument.', 'RESOURCE_NOT_FOUND: ad group');
          const rsa = op.create.ad && op.create.ad.responsiveSearchAd;
          if (!rsa || !Array.isArray(rsa.headlines) || rsa.headlines.length < 3) return gerror(400, 'Request contains an invalid argument.', 'TOO_FEW_HEADLINES');
          if (rsa.headlines.some((h) => h.text.length > 30)) return gerror(400, 'Request contains an invalid argument.', 'LINE_TOO_WIDE');
          const id = String(++adn);
          state.ads.unshift({ id, name: op.create.ad.name || '', status: op.create.status || 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', adGroupId, campaignId: g.campaignId, finalUrls: op.create.ad.finalUrls || [], headlines: rsa.headlines.map((h) => h.text), descriptions: (rsa.descriptions || []).map((d) => d.text), path1: rsa.path1 || '', path2: rsa.path2 || '' });
          results.push({ resourceName: `customers/${customerId}/adGroupAds/${adGroupId}~${id}` });
        } else if (op.update) {
          const adId = String(op.update.resourceName).split('~').pop();
          const a = state.ads.find((x) => x.id === adId);
          if (!a) return gerror(400, 'Request contains an invalid argument.', 'RESOURCE_NOT_FOUND');
          if (op.update.status) a.status = op.update.status;
          results.push({ resourceName: op.update.resourceName });
        }
      }
      return send(200, { results });
    }
    if (req.method === 'POST' && m[2] === 'assets:mutate') {
      const results = [];
      for (const op of body.operations || []) {
        if (!op.create || op.create.type !== 'IMAGE' || !op.create.imageAsset || !op.create.imageAsset.data) return gerror(400, 'Request contains an invalid argument.', 'IMAGE_DATA_REQUIRED');
        const id = String(++asn);
        state.assets.unshift({ id, name: op.create.name, type: 'IMAGE', url: `https://cdn.example/${id}.png`, fileSize: String(Buffer.from(op.create.imageAsset.data, 'base64').length) });
        results.push({ resourceName: `customers/${customerId}/assets/${id}` });
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
