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
    adsets: [
      { id: 's1', name: 'US women 25-54', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '2000', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', targeting: { geo_locations: { countries: ['US'] }, age_min: 25, age_max: 54, genders: [2] }, start_time: '2026-09-01T00:00:00+0000' },
      { id: 's2', name: 'CA broad (no set budget)', campaign_id: 'c2', status: 'PAUSED', effective_status: 'PAUSED', optimization_goal: 'LINK_CLICKS', billing_event: 'LINK_CLICKS', targeting: { geo_locations: { countries: ['CA'] } } },
    ],
    ads: [{ id: 'a1', name: 'Lantern hero', adset_id: 's1', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: 'cr1' } }],
    creatives: [{ id: 'cr1', name: 'Hero creative', status: 'ACTIVE', object_story_spec: { page_id: '777', link_data: { image_hash: 'h1', link: 'https://lanterns.example/shop', message: 'Light your evenings.', name: 'Lanterns, handmade', description: 'Free shipping', call_to_action: { type: 'SHOP_NOW' } } }, thumbnail_url: 'https://cdn.example/t1.jpg' }],
    images: [],
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
    if (req.method === 'GET' && p === `${account}/adsets`) return page(state.adsets);
    if (req.method === 'GET' && p === `${account}/ads`) return page(state.ads);
    if (req.method === 'GET' && p === `${account}/adcreatives`) return page(state.creatives);
    if (req.method === 'POST' && p === `${account}/adsets`) {
      if (!body || !body.name || !body.campaign_id || !body.targeting || !body.optimization_goal || !body.billing_event) return error(400, 'Missing required field: name/campaign_id/targeting/optimization_goal/billing_event', 100);
      if (!state.campaigns.some((c) => c.id === body.campaign_id)) return error(400, 'Invalid parameter: campaign_id', 100);
      if (body.lifetime_budget && !body.end_time) return error(400, 'A lifetime budget needs an end_time', 100);
      if (!body.daily_budget && !body.lifetime_budget) return error(400, 'An ad set needs a budget', 100);
      const s = { id: `s${++n}`, name: body.name, campaign_id: body.campaign_id, status: body.status || 'PAUSED', effective_status: body.status || 'PAUSED', daily_budget: body.daily_budget ? String(body.daily_budget) : undefined, lifetime_budget: body.lifetime_budget ? String(body.lifetime_budget) : undefined, optimization_goal: body.optimization_goal, billing_event: body.billing_event, targeting: body.targeting, bid_amount: body.bid_amount, end_time: body.end_time };
      state.adsets.unshift(s);
      return send(200, { id: s.id });
    }
    if (req.method === 'POST' && p === `${account}/adimages`) {
      if (!body || !body.bytes) return error(400, 'bytes is required', 100);
      const hash = `img${state.images.length + 1}hash`;
      state.images.push({ hash, name: body.name, bytes: Buffer.from(body.bytes, 'base64').length });
      return send(200, { images: { [body.name || 'image']: { hash, url: `https://cdn.example/${hash}.jpg` } } });
    }
    if (req.method === 'POST' && p === `${account}/adcreatives`) {
      const spec = body && body.object_story_spec;
      if (!spec || !spec.page_id || !spec.link_data || !spec.link_data.link || !spec.link_data.image_hash) return error(400, 'object_story_spec needs page_id and link_data with link and image_hash', 100);
      if (!state.images.some((i) => i.hash === spec.link_data.image_hash) && !state.creatives.some((c) => c.object_story_spec.link_data.image_hash === spec.link_data.image_hash)) return error(400, 'Invalid image hash', 100);
      const cr = { id: `cr${++n}`, name: body.name || '', status: 'ACTIVE', object_story_spec: spec, thumbnail_url: null };
      state.creatives.unshift(cr);
      return send(200, { id: cr.id });
    }
    if (req.method === 'POST' && p === `${account}/ads`) {
      if (!body || !body.name || !body.adset_id || !body.creative || !body.creative.creative_id) return error(400, 'Missing required field: name/adset_id/creative', 100);
      const set = state.adsets.find((s) => s.id === body.adset_id);
      if (!set) return error(400, 'Invalid parameter: adset_id', 100);
      if (!state.creatives.some((c) => c.id === body.creative.creative_id)) return error(400, 'Invalid parameter: creative_id', 100);
      const ad = { id: `a${++n}`, name: body.name, adset_id: body.adset_id, campaign_id: set.campaign_id, status: body.status || 'PAUSED', effective_status: body.status || 'PAUSED', creative: { id: body.creative.creative_id } };
      state.ads.unshift(ad);
      return send(200, { id: ad.id });
    }
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
    const s = state.adsets.find((x) => x.id === p);
    if (s && req.method === 'POST') {
      if (body.daily_budget !== undefined) s.daily_budget = String(body.daily_budget);
      if (body.status !== undefined) { s.status = body.status; s.effective_status = body.status; }
      return send(200, { success: true });
    }
    const ad = state.ads.find((x) => x.id === p);
    if (ad && req.method === 'POST') {
      if (body.status !== undefined) { ad.status = body.status; ad.effective_status = body.status; }
      return send(200, { success: true });
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
