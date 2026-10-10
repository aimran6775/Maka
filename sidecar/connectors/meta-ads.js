// Meta Ads connector (phase 2 step 17): the Marketing API of one ad account, read into
// the local store (the account, campaigns, the last 7 days of insights); writes are a new
// campaign (created PAUSED), a daily budget change and a status change, all money_out
// with the daily budget as the amount so the daily cap applies. Official API only:
// https://graph.facebook.com/v21.0, bearer access token (META_ACCESS_TOKEN or keystore
// `metaAds`), the ad account from connectors.meta_ads.adAccountId or META_AD_ACCOUNT_ID.
//
//   createMetaAdsClient({ accessToken, adAccountId, fetch, baseUrl })
//   metaAdsSpec({ baseUrl })   -> a connector spec (camp marketing)
//   META_ADS_TOOLS

export const META_BASE_URL = 'https://graph.facebook.com/v21.0';
export const META_SYNC_MS = 15 * 60 * 1000;
export const META_MAX_PAGES = 4;
export const META_INSIGHTS_PRESET = 'last_7d';
export const META_OBJECTIVES = Object.freeze(['OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_APP_PROMOTION']);

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export function adAccountId(id) {
  const s = String(id || '').trim();
  if (!s) return null;
  return s.startsWith('act_') ? s : `act_${s}`;
}

export function createMetaAdsClient({ accessToken, adAccountId: account, fetch: fetchImpl = globalThis.fetch, baseUrl = META_BASE_URL } = {}) {
  const act = adAccountId(account);
  if (!act) throw fail('NO_AD_ACCOUNT', 'Meta Ads needs the ad account id (connectors.meta_ads.adAccountId in config.json or META_AD_ACCOUNT_ID), e.g. "act_123"');
  if (!accessToken) throw new TypeError('createMetaAdsClient needs accessToken');
  async function call(method, p, { params, body } = {}) {
    const url = new URL(`${baseUrl}/${p.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
    let res;
    try {
      res = await fetchImpl(url.toString(), { method, headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw fail('NETWORK', `Meta unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw fail('BAD_RESPONSE', `Meta answered ${res.status} with a non-JSON body`);
    }
    if (!res.ok || json.error) {
      const e = json.error || {};
      throw fail(`HTTP_${res.status}`, `Meta ${res.status}: ${e.message || text.slice(0, 200)}${e.code ? ` (code ${e.code})` : ''}`, res.status);
    }
    return json;
  }
  const client = {
    account: act,
    accountInfo: () => call('GET', act, { params: { fields: 'id,name,currency,account_status,amount_spent,balance,timezone_name' } }),
    async listAll(p, params = {}, { maxPages = META_MAX_PAGES } = {}) {
      const out = [];
      let after;
      for (let i = 0; i < maxPages; i++) {
        const page = await call('GET', p, { params: { limit: 100, ...params, ...(after ? { after } : {}) } });
        out.push(...(page.data || []));
        after = page.paging && page.paging.cursors && page.paging.cursors.after && page.paging.next ? page.paging.cursors.after : null;
        if (!after) break;
      }
      return out;
    },
    campaigns: () => client.listAll(`${act}/campaigns`, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time' }),
    insights: (preset = META_INSIGHTS_PRESET) => client.listAll(`${act}/insights`, { level: 'campaign', date_preset: preset, fields: 'campaign_id,campaign_name,spend,impressions,clicks,cpc,ctr,actions' }),
    createCampaign: (body) => call('POST', `${act}/campaigns`, { body }),
    updateCampaign: (id, body) => call('POST', id, { body }),
  };
  return client;
}

const minorToMajor = (s) => (s === undefined || s === null || s === '' ? null : Number(s) / 100);
const campaignRow = (c) => ({ id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status || c.status, objective: c.objective || '', dailyBudget: minorToMajor(c.daily_budget), lifetimeBudget: minorToMajor(c.lifetime_budget), createdAt: c.created_time || null, updatedAt: c.updated_time || null });
const insightRow = (r) => ({ campaignId: r.campaign_id, campaignName: r.campaign_name, spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, cpc: r.cpc !== undefined ? Number(r.cpc) : null, ctr: r.ctr !== undefined ? Number(r.ctr) : null, results: (r.actions || []).map((a) => ({ type: a.action_type, value: Number(a.value) || 0 })) });

export function emptyMetaAdsData() {
  return { account: null, campaigns: [], insights: { preset: META_INSIGHTS_PRESET, rows: [] } };
}

export function summarizeMetaAds(data) {
  if (!data || !Array.isArray(data.campaigns)) return null;
  const rows = (data.insights && data.insights.rows) || [];
  const spend = rows.reduce((n, r) => n + r.spend, 0);
  const cur = (data.account && data.account.currency) || '';
  return `${data.account && data.account.name ? `${data.account.name} · ` : ''}${data.campaigns.length} campaign(s) (${data.campaigns.filter((c) => c.effectiveStatus === 'ACTIVE').length} active) · last 7 days: spend ${spend.toFixed(2)} ${cur}, ${rows.reduce((n, r) => n + r.clicks, 0)} click(s), ${rows.reduce((n, r) => n + r.impressions, 0)} impression(s)`.trim();
}

export function metaAdsSpec({ baseUrl = META_BASE_URL } = {}) {
  return {
    kind: 'meta_ads',
    label: 'Meta Ads',
    auth: 'api_key',
    envVar: 'META_ACCESS_TOKEN',
    keyName: 'metaAds',
    zoneKinds: ['marketing'],
    syncEveryMs: META_SYNC_MS,
    emptyData: emptyMetaAdsData,
    summarize: summarizeMetaAds,
    makeClient: ({ token, fetch: fetchImpl, env, config }) => createMetaAdsClient({ accessToken: token.accessToken, adAccountId: (config && config.adAccountId) || env.META_AD_ACCOUNT_ID, fetch: fetchImpl, baseUrl }),
    async sync({ client, data }) {
      const [account, campaigns, insights] = await Promise.all([client.accountInfo(), client.campaigns(), client.insights()]);
      const next = { ...data, account: { id: account.id, name: account.name || '', currency: account.currency || '', status: account.account_status, amountSpent: minorToMajor(account.amount_spent), balance: minorToMajor(account.balance), timezone: account.timezone_name || '' }, campaigns: campaigns.map(campaignRow), insights: { preset: META_INSIGHTS_PRESET, rows: insights.map(insightRow) } };
      return { data: next, counts: { campaigns: next.campaigns.length, active: next.campaigns.filter((c) => c.effectiveStatus === 'ACTIVE').length, insightRows: next.insights.rows.length, spend7d: Number(next.insights.rows.reduce((n, r) => n + r.spend, 0).toFixed(2)) } };
    },
    tools: META_ADS_TOOLS,
  };
}

// ---- tools ----

function need(ctx) {
  if (!ctx.connectors) return { error: { ok: false, error: 'the connector framework is not available in this run' } };
  const st = ctx.connectors.status('meta_ads');
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: 'Meta Ads is not defined in this build' } };
  const data = ctx.connectors.data('meta_ads');
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: 'Meta Ads is not connected; ask the Superintendent to connect it at the Peak' } };
  return { data, status: st };
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
async function withClient(ctx, fn) {
  let client;
  try {
    client = await ctx.connectors.client('meta_ads');
  } catch (err) {
    return { ok: false, code: err.code || 'NOT_CONNECTED', error: err.message };
  }
  try {
    return await fn(client);
  } catch (err) {
    return { ok: false, code: err.code || 'META', error: err.message };
  }
}
// The money activating a campaign commits (safety H2): its campaign-level daily budget;
// a lifetime budget counts in full (it can all be spent); a campaign with neither (its
// budgets live on ad sets, or it is not in the store) is null: the amount cannot be
// proven, the gate sends it to the Gate, and run() refuses it.
export const budgetOf = (ctx, id) => {
  const data = ctx && ctx.connectors && ctx.connectors.status('meta_ads') ? ctx.connectors.data('meta_ads') : null;
  const c = data ? data.campaigns.find((x) => x.id === id) : null;
  return campaignBudget(c);
};
export function campaignBudget(c) {
  if (!c) return null;
  if (typeof c.dailyBudget === 'number' && Number.isFinite(c.dailyBudget) && c.dailyBudget > 0) return c.dailyBudget;
  if (typeof c.lifetimeBudget === 'number' && Number.isFinite(c.lifetimeBudget) && c.lifetimeBudget > 0) return c.lifetimeBudget;
  return null;
}

export const metaAdsCampaigns = {
  name: 'meta_ads.campaigns',
  description: 'Campaigns of the Meta ad account from the last sync: id, name, status, objective, daily budget. Filters: status (ACTIVE | PAUSED | ARCHIVED), query.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Meta Ads campaigns',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.campaigns.filter((c) => (!input.status || c.effectiveStatus === input.status || c.status === input.status) && (!input.query || c.name.toLowerCase().includes(input.query.toLowerCase())));
    return { ok: true, output: JSON.stringify({ account: data.account, count: rows.length, syncedAt: iso(data.syncedAt), campaigns: rows.slice(0, input.limit || 50) }) };
  },
};

export const metaAdsInsights = {
  name: 'meta_ads.insights',
  description: 'Spend and results per campaign for the last 7 days from the last Meta Ads sync: spend, impressions, clicks, cpc, ctr, results (actions). Filter: campaignId.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { campaignId: { type: 'string' } } },
  confirm: false,
  summarize: () => 'read the Meta Ads results',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.insights.rows.filter((r) => !input.campaignId || r.campaignId === input.campaignId);
    return { ok: true, output: JSON.stringify({ preset: data.insights.preset, currency: data.account ? data.account.currency : '', totalSpend: Number(rows.reduce((n, r) => n + r.spend, 0).toFixed(2)), syncedAt: iso(data.syncedAt), rows }) };
  },
};

export const metaAdsCreateCampaign = {
  name: 'meta_ads.create_campaign',
  description: 'Create a Meta Ads campaign, PAUSED, with a daily budget (money_out: the daily budget counts against the cap). Objective: OUTCOME_SALES | OUTCOME_TRAFFIC | OUTCOME_LEADS | OUTCOME_AWARENESS | OUTCOME_ENGAGEMENT | OUTCOME_APP_PROMOTION. Activate it with meta_ads.set_status once ad sets and ads exist.',
  inputSchema: { type: 'object', required: ['name', 'objective', 'dailyBudget'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, objective: { type: 'string', enum: [...META_OBJECTIVES] }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input) => input.dailyBudget,
  summarize: (input) => `create the Meta Ads campaign "${input.name.slice(0, 60)}" (${input.objective}, ${input.dailyBudget.toFixed(2)}/day, paused)`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    return withClient(ctx, async (client) => {
      const r = await client.createCampaign({ name: input.name, objective: input.objective, status: 'PAUSED', daily_budget: Math.round(input.dailyBudget * 100), special_ad_categories: [] });
      const row = { id: r.id, name: input.name, status: 'PAUSED', effectiveStatus: 'PAUSED', objective: input.objective, dailyBudget: input.dailyBudget, lifetimeBudget: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.campaigns = [row, ...data.campaigns.filter((c) => c.id !== row.id)];
      ctx.connectors.sync('meta_ads', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const metaAdsSetBudget = {
  name: 'meta_ads.set_budget',
  description: 'Change a Meta Ads campaign\'s daily budget (money_out: the new daily budget counts against the cap).',
  inputSchema: { type: 'object', required: ['campaignId', 'dailyBudget'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1 }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input) => input.dailyBudget,
  summarize: (input) => `set Meta Ads campaign ${input.campaignId} daily budget to ${input.dailyBudget.toFixed(2)}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const c = data.campaigns.find((x) => x.id === input.campaignId);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: `no campaign ${input.campaignId} in the last Meta Ads sync` };
    return withClient(ctx, async (client) => {
      await client.updateCampaign(input.campaignId, { daily_budget: Math.round(input.dailyBudget * 100) });
      const before = c.dailyBudget;
      c.dailyBudget = input.dailyBudget;
      ctx.connectors.sync('meta_ads', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ id: c.id, name: c.name, dailyBudget: input.dailyBudget, before }) };
    });
  },
};

export const metaAdsSetStatus = {
  name: 'meta_ads.set_status',
  description: 'Pause or activate a Meta Ads campaign. Activating is money_out (its campaign-level daily budget counts against the cap, a lifetime budget in full; a campaign with no campaign-level budget cannot be activated from here); pausing moves no money.',
  inputSchema: { type: 'object', required: ['campaignId', 'status'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input, ctx) => (input.status === 'ACTIVE' ? budgetOf(ctx, input.campaignId) : 0),
  summarize: (input) => `${input.status === 'ACTIVE' ? 'activate' : 'pause'} Meta Ads campaign ${input.campaignId}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const c = data.campaigns.find((x) => x.id === input.campaignId);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: `no campaign ${input.campaignId} in the last Meta Ads sync` };
    if (input.status === 'ACTIVE' && campaignBudget(c) === null) return { ok: false, code: 'NO_BUDGET', error: `campaign ${input.campaignId} has no campaign-level daily or lifetime budget in the store, so what activating it would spend cannot be proven; set a campaign budget with meta_ads.set_budget first` };
    return withClient(ctx, async (client) => {
      await client.updateCampaign(input.campaignId, { status: input.status });
      c.status = input.status;
      c.effectiveStatus = input.status;
      ctx.connectors.sync('meta_ads', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ id: c.id, name: c.name, status: input.status, dailyBudget: c.dailyBudget }) };
    });
  },
};

export const META_ADS_TOOLS = Object.freeze({
  'meta_ads.campaigns': metaAdsCampaigns,
  'meta_ads.insights': metaAdsInsights,
  'meta_ads.create_campaign': metaAdsCreateCampaign,
  'meta_ads.set_budget': metaAdsSetBudget,
  'meta_ads.set_status': metaAdsSetStatus,
});
