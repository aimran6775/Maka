// A fake Meta Marketing API on an ephemeral port: the ad account, campaigns with cursor
// paging, campaign insights, campaign create (POST act_x/campaigns) and update (POST <id>).
// Bearer access token; errors in Graph's shape. Test-only.
import http from 'node:http';

export async function startFakeMetaAds({ accessToken = 'EAAB_fake', account = 'act_123', pageSize = 100 } = {}) {
  const state = {
    calls: [],
    account: { id: account, name: 'Lantern Co Ads', currency: 'USD', account_status: 1, amount_spent: '12345', balance: '0', timezone_name: 'America/New_York' },
    campaigns: [
      { id: 'c1', name: 'Lanterns – Sales', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '2000', created_time: '2026-09-01T00:00:00+0000', updated_time: '2026-10-01T00:00:00+0000' },
      { id: 'c2', name: 'Lanterns – Awareness', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_AWARENESS', lifetime_budget: '50000', created_time: '2026-08-01T00:00:00+0000', updated_time: '2026-09-15T00:00:00+0000' },
    ],
    insights: [{ campaign_id: 'c1', campaign_name: 'Lanterns – Sales', spend: '84.50', impressions: '12000', clicks: '240', cpc: '0.352083', ctr: '2.0', actions: [{ action_type: 'purchase', value: '6' }], date_start: '2026-10-03', date_stop: '2026-10-09' }],
    fail: null,
  };
  let n = 10;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    state.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const error = (status, message, code) => send(status, { error: { message, type: 'OAuthException', code } });
    if (req.headers.authorization !== `Bearer ${accessToken}`) return error(401, 'Invalid OAuth access token - Cannot parse access token', 190);
    if (state.fail) return error(state.fail.status || 500, state.fail.message || 'down', 1);
    const p = url.pathname.replace(/^\/v\d+\.\d+\//, '');
    const page = (rows) => {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 25, pageSize);
      const start = Number(url.searchParams.get('after') || 0);
      const data = rows.slice(start, start + limit);
      const more = start + limit < rows.length;
      return send(200, { data, paging: { cursors: { before: String(start), after: String(start + limit) }, ...(more ? { next: `${url.origin}${url.pathname}?after=${start + limit}` } : {}) } });
    };
    if (req.method === 'GET' && p === account) return send(200, state.account);
    if (req.method === 'GET' && p === `${account}/campaigns`) return page(state.campaigns);
    if (req.method === 'GET' && p === `${account}/insights`) {
      if (url.searchParams.get('level') !== 'campaign') return error(400, 'level must be campaign', 100);
      return page(state.insights);
    }
    if (req.method === 'POST' && p === `${account}/campaigns`) {
      if (!body || !body.name || !body.objective) return error(400, 'Missing required field: name/objective', 100);
      if (!Array.isArray(body.special_ad_categories)) return error(400, 'special_ad_categories is required', 100);
      const c = { id: `c${++n}`, name: body.name, status: body.status || 'PAUSED', effective_status: body.status || 'PAUSED', objective: body.objective, daily_budget: body.daily_budget ? String(body.daily_budget) : undefined, created_time: new Date().toISOString(), updated_time: new Date().toISOString() };
      state.campaigns.unshift(c);
      return send(200, { id: c.id });
    }
    const c = state.campaigns.find((x) => x.id === p);
    if (c && req.method === 'POST') {
      if (body.daily_budget !== undefined) c.daily_budget = String(body.daily_budget);
      if (body.status !== undefined) {
        c.status = body.status;
        c.effective_status = body.status;
      }
      c.updated_time = new Date().toISOString();
      return send(200, { success: true });
    }
    error(404, `Unsupported get request. Object with ID '${p}' does not exist`, 100);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v21.0`, accessToken, account, state, async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
