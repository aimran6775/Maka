// Google Ads connector (phase 2 step 17): the Google Ads API (REST, GAQL through
// searchStream) of one customer, read into the local store (the customer, campaigns with
// their budgets, the last 7 days of metrics); writes are a new campaign (a budget plus a
// PAUSED campaign), a budget change and a status change, all money_out with the daily
// budget as the amount. Official API only: https://googleads.googleapis.com/v18, OAuth 2
// through the framework (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET, scope adwords),
// header developer-token (GOOGLE_ADS_DEVELOPER_TOKEN), the customer id from
// connectors.google_ads.customerId or GOOGLE_ADS_CUSTOMER_ID (login-customer-id optional).
//
//   createGoogleAdsClient({ accessToken, developerToken, customerId, loginCustomerId, fetch, baseUrl })
//   googleAdsSpec({ baseUrl, authorizeUrl, tokenUrl })  -> a connector spec (camp marketing)
//   GOOGLE_ADS_TOOLS

export const GOOGLE_ADS_BASE_URL = 'https://googleads.googleapis.com/v18';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_ADS_SCOPES = ['https://www.googleapis.com/auth/adwords'];
export const GOOGLE_ADS_SYNC_MS = 15 * 60 * 1000;
export const GOOGLE_ADS_CHANNELS = Object.freeze(['SEARCH', 'DISPLAY', 'SHOPPING', 'VIDEO', 'PERFORMANCE_MAX']);

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export const customerId = (id) => String(id || '').replace(/-/g, '').trim() || null;
export const microsToMajor = (m) => (m === undefined || m === null ? null : Number(m) / 1_000_000);
export const majorToMicros = (n) => Math.round(Number(n) * 1_000_000);

export const CAMPAIGN_QUERY = "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.start_date, campaign_budget.id, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id";
export const METRICS_QUERY = 'SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date DURING LAST_7_DAYS';
export const CUSTOMER_QUERY = 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer';

export function createGoogleAdsClient({ accessToken, developerToken, customerId: cid, loginCustomerId = null, fetch: fetchImpl = globalThis.fetch, baseUrl = GOOGLE_ADS_BASE_URL } = {}) {
  const customer = customerId(cid);
  if (!customer) throw fail('NO_CUSTOMER', 'Google Ads needs the customer id (connectors.google_ads.customerId in config.json or GOOGLE_ADS_CUSTOMER_ID), e.g. "123-456-7890"');
  if (!developerToken) throw fail('NO_DEVELOPER_TOKEN', 'Google Ads needs GOOGLE_ADS_DEVELOPER_TOKEN in the environment or keystore');
  if (!accessToken) throw new TypeError('createGoogleAdsClient needs accessToken');
  async function call(p, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/customers/${customer}${p}`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'developer-token': developerToken, ...(loginCustomerId ? { 'login-customer-id': customerId(loginCustomerId) } : {}), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
      throw fail('NETWORK', `Google Ads unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw fail('BAD_RESPONSE', `Google Ads answered ${res.status} with a non-JSON body`);
    }
    if (!res.ok) {
      const e = (Array.isArray(json) ? json[0] && json[0].error : json.error) || {};
      const detail = e.details && e.details[0] && e.details[0].errors && e.details[0].errors[0] ? e.details[0].errors[0].message : null;
      throw fail(`HTTP_${res.status}`, `Google Ads ${res.status}: ${detail || e.message || text.slice(0, 200)}`, res.status);
    }
    return json;
  }
  const client = {
    customer,
    async search(query) {
      const batches = await call('/googleAds:searchStream', { query });
      return (Array.isArray(batches) ? batches : [batches]).flatMap((b) => b.results || []);
    },
    mutateBudgets: (operations) => call('/campaignBudgets:mutate', { operations }),
    mutateCampaigns: (operations) => call('/campaigns:mutate', { operations }),
  };
  return client;
}

const campaignRow = (r) => ({ id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status, channel: r.campaign.advertisingChannelType || '', startDate: r.campaign.startDate || null, budgetResource: r.campaignBudget ? r.campaignBudget.resourceName : null, budgetId: r.campaignBudget ? String(r.campaignBudget.id) : null, dailyBudget: r.campaignBudget ? microsToMajor(r.campaignBudget.amountMicros) : null });
const metricRow = (r) => ({ campaignId: String(r.campaign.id), campaignName: r.campaign.name, cost: microsToMajor(r.metrics.costMicros) || 0, impressions: Number(r.metrics.impressions) || 0, clicks: Number(r.metrics.clicks) || 0, conversions: Number(r.metrics.conversions) || 0, conversionsValue: Number(r.metrics.conversionsValue) || 0 });

export function emptyGoogleAdsData() {
  return { customer: null, campaigns: [], metrics: { range: 'LAST_7_DAYS', rows: [] } };
}

export function summarizeGoogleAds(data) {
  if (!data || !Array.isArray(data.campaigns)) return null;
  const rows = (data.metrics && data.metrics.rows) || [];
  const cost = rows.reduce((n, r) => n + r.cost, 0);
  const cur = (data.customer && data.customer.currency) || '';
  return `${data.customer && data.customer.name ? `${data.customer.name} · ` : ''}${data.campaigns.length} campaign(s) (${data.campaigns.filter((c) => c.status === 'ENABLED').length} enabled) · last 7 days: cost ${cost.toFixed(2)} ${cur}, ${rows.reduce((n, r) => n + r.clicks, 0)} click(s), ${rows.reduce((n, r) => n + r.conversions, 0)} conversion(s)`.trim();
}

export function googleAdsSpec({ baseUrl = GOOGLE_ADS_BASE_URL, authorizeUrl = GOOGLE_AUTHORIZE_URL, tokenUrl = GOOGLE_TOKEN_URL } = {}) {
  return {
    kind: 'google_ads',
    label: 'Google Ads',
    auth: 'oauth2',
    keyName: 'googleAds',
    zoneKinds: ['marketing'],
    syncEveryMs: GOOGLE_ADS_SYNC_MS,
    oauth: { authorizeUrl, tokenUrl, clientIdKey: 'googleAdsClientId', clientSecretKey: 'googleAdsClientSecret', scopes: GOOGLE_ADS_SCOPES, extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
    emptyData: emptyGoogleAdsData,
    summarize: summarizeGoogleAds,
    makeClient: async ({ token, fetch: fetchImpl, env, config, keys }) => createGoogleAdsClient({ accessToken: token.accessToken, developerToken: await keys.get('googleAdsDeveloperToken'), customerId: (config && config.customerId) || env.GOOGLE_ADS_CUSTOMER_ID, loginCustomerId: (config && config.loginCustomerId) || env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null, fetch: fetchImpl, baseUrl }),
    async sync({ client, data }) {
      const [customer, campaigns, metrics] = await Promise.all([client.search(CUSTOMER_QUERY), client.search(CAMPAIGN_QUERY), client.search(METRICS_QUERY)]);
      const c = customer[0] && customer[0].customer ? customer[0].customer : {};
      const next = { ...data, customer: { id: String(c.id || client.customer), name: c.descriptiveName || '', currency: c.currencyCode || '', timezone: c.timeZone || '' }, campaigns: campaigns.map(campaignRow), metrics: { range: 'LAST_7_DAYS', rows: metrics.map(metricRow) } };
      return { data: next, counts: { campaigns: next.campaigns.length, enabled: next.campaigns.filter((x) => x.status === 'ENABLED').length, metricRows: next.metrics.rows.length, cost7d: Number(next.metrics.rows.reduce((n, r) => n + r.cost, 0).toFixed(2)) } };
    },
    tools: GOOGLE_ADS_TOOLS,
  };
}

// ---- tools ----

function need(ctx) {
  if (!ctx.connectors) return { error: { ok: false, error: 'the connector framework is not available in this run' } };
  const st = ctx.connectors.status('google_ads');
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: 'Google Ads is not defined in this build' } };
  const data = ctx.connectors.data('google_ads');
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: 'Google Ads is not connected; ask the Superintendent to sign in at the Peak' } };
  return { data, status: st };
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
async function withClient(ctx, fn) {
  let client;
  try {
    client = await ctx.connectors.client('google_ads');
  } catch (err) {
    return { ok: false, code: err.code || 'NOT_CONNECTED', error: err.message };
  }
  try {
    return await fn(client);
  } catch (err) {
    return { ok: false, code: err.code || 'GOOGLE_ADS', error: err.message };
  }
}
const budgetOf = (ctx, id) => {
  const data = ctx && ctx.connectors && ctx.connectors.status('google_ads') ? ctx.connectors.data('google_ads') : null;
  const c = data ? data.campaigns.find((x) => x.id === id) : null;
  return c && typeof c.dailyBudget === 'number' ? c.dailyBudget : 0;
};

export const googleAdsCampaigns = {
  name: 'google_ads.campaigns',
  description: 'Campaigns of the Google Ads customer from the last sync: id, name, status (ENABLED | PAUSED), channel, daily budget. Filters: status, query.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Google Ads campaigns',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.campaigns.filter((c) => (!input.status || c.status === input.status) && (!input.query || c.name.toLowerCase().includes(input.query.toLowerCase())));
    return { ok: true, output: JSON.stringify({ customer: data.customer, count: rows.length, syncedAt: iso(data.syncedAt), campaigns: rows.slice(0, input.limit || 50) }) };
  },
};

export const googleAdsMetrics = {
  name: 'google_ads.metrics',
  description: 'Cost and results per campaign for the last 7 days from the last Google Ads sync: cost, impressions, clicks, conversions, conversion value. Filter: campaignId.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { campaignId: { type: 'string' } } },
  confirm: false,
  summarize: () => 'read the Google Ads results',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.metrics.rows.filter((r) => !input.campaignId || r.campaignId === input.campaignId);
    return { ok: true, output: JSON.stringify({ range: data.metrics.range, currency: data.customer ? data.customer.currency : '', totalCost: Number(rows.reduce((n, r) => n + r.cost, 0).toFixed(2)), syncedAt: iso(data.syncedAt), rows }) };
  },
};

export const googleAdsCreateCampaign = {
  name: 'google_ads.create_campaign',
  description: 'Create a Google Ads campaign, PAUSED, with its own daily budget (money_out: the daily budget counts against the cap). channel: SEARCH | DISPLAY | SHOPPING | VIDEO | PERFORMANCE_MAX. Enable it with google_ads.set_status once ad groups and ads exist.',
  inputSchema: { type: 'object', required: ['name', 'channel', 'dailyBudget'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, channel: { type: 'string', enum: [...GOOGLE_ADS_CHANNELS] }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input) => input.dailyBudget,
  summarize: (input) => `create the Google Ads campaign "${input.name.slice(0, 60)}" (${input.channel}, ${input.dailyBudget.toFixed(2)}/day, paused)`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    return withClient(ctx, async (client) => {
      const b = await client.mutateBudgets([{ create: { name: `${input.name} budget`, amountMicros: String(majorToMicros(input.dailyBudget)), deliveryMethod: 'STANDARD', explicitlyShared: false } }]);
      const budgetResource = b.results && b.results[0] ? b.results[0].resourceName : null;
      if (!budgetResource) throw fail('BAD_RESPONSE', 'Google Ads returned no budget resource name');
      const c = await client.mutateCampaigns([{ create: { name: input.name, status: 'PAUSED', advertisingChannelType: input.channel, campaignBudget: budgetResource, manualCpc: {} } }]);
      const resource = c.results && c.results[0] ? c.results[0].resourceName : '';
      const id = resource.split('/').pop();
      const row = { id, name: input.name, status: 'PAUSED', channel: input.channel, startDate: null, budgetResource, budgetId: budgetResource.split('/').pop(), dailyBudget: input.dailyBudget };
      data.campaigns = [row, ...data.campaigns.filter((x) => x.id !== row.id)];
      ctx.connectors.sync('google_ads', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const googleAdsSetBudget = {
  name: 'google_ads.set_budget',
  description: 'Change a Google Ads campaign\'s daily budget (money_out: the new daily budget counts against the cap).',
  inputSchema: { type: 'object', required: ['campaignId', 'dailyBudget'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1 }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input) => input.dailyBudget,
  summarize: (input) => `set Google Ads campaign ${input.campaignId} daily budget to ${input.dailyBudget.toFixed(2)}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const c = data.campaigns.find((x) => x.id === input.campaignId);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: `no campaign ${input.campaignId} in the last Google Ads sync` };
    if (!c.budgetResource) return { ok: false, code: 'NO_BUDGET', error: `campaign ${input.campaignId} has no budget resource in the store; sync first` };
    return withClient(ctx, async (client) => {
      await client.mutateBudgets([{ update: { resourceName: c.budgetResource, amountMicros: String(majorToMicros(input.dailyBudget)) }, updateMask: 'amount_micros' }]);
      const before = c.dailyBudget;
      // A budget can be shared: every campaign on it now has the new daily amount.
      for (const x of data.campaigns) if (x.budgetResource === c.budgetResource) x.dailyBudget = input.dailyBudget;
      ctx.connectors.sync('google_ads', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ id: c.id, name: c.name, dailyBudget: input.dailyBudget, before }) };
    });
  },
};

export const googleAdsSetStatus = {
  name: 'google_ads.set_status',
  description: 'Pause or enable a Google Ads campaign. Enabling is money_out (its daily budget counts against the cap); pausing moves no money.',
  inputSchema: { type: 'object', required: ['campaignId', 'status'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['ENABLED', 'PAUSED'] } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input, ctx) => (input.status === 'ENABLED' ? budgetOf(ctx, input.campaignId) : 0),
  summarize: (input) => `${input.status === 'ENABLED' ? 'enable' : 'pause'} Google Ads campaign ${input.campaignId}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const c = data.campaigns.find((x) => x.id === input.campaignId);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: `no campaign ${input.campaignId} in the last Google Ads sync` };
    return withClient(ctx, async (client) => {
      await client.mutateCampaigns([{ update: { resourceName: `customers/${client.customer}/campaigns/${c.id}`, status: input.status }, updateMask: 'status' }]);
      c.status = input.status;
      ctx.connectors.sync('google_ads', 'after-write').catch(() => {});
      return { ok: true, output: JSON.stringify({ id: c.id, name: c.name, status: input.status, dailyBudget: c.dailyBudget }) };
    });
  },
};

export const GOOGLE_ADS_TOOLS = Object.freeze({
  'google_ads.campaigns': googleAdsCampaigns,
  'google_ads.metrics': googleAdsMetrics,
  'google_ads.create_campaign': googleAdsCreateCampaign,
  'google_ads.set_budget': googleAdsSetBudget,
  'google_ads.set_status': googleAdsSetStatus,
});
