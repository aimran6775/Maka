// Meta Ads, below the campaign (phase 4 step 7): ad sets, ads and ad creatives.
//
// Synced into the connector store beside the campaigns: `adsets` (targeting, budget at
// set level, optimisation goal), `ads` (which creative in which set) and `creatives`
// (copy, image hash, link). Tools, all behind the Notice board:
//   meta_ads.adsets / meta_ads.ads / meta_ads.creatives     research (from the store)
//   meta_ads.create_adset       money_out: the set's daily budget (a lifetime budget in
//                               full); created PAUSED
//   meta_ads.set_adset_budget   money_out: the new budget
//   meta_ads.set_adset_status   money_out when activating: the set's budget from the store
//                               (none provable → the Gate, then NO_BUDGET); pausing moves 0
//   meta_ads.upload_image       publishing: an image from the Ranger's workspace → image hash
//   meta_ads.create_creative    publishing: copy + image + link as an ad creative
//   meta_ads.create_ad          publishing: an ad (creative in a set), created PAUSED
//   meta_ads.set_ad_status      money_out when activating: the ad set's budget (an active
//                               ad spends its set's budget); pausing moves 0
// Every create is PAUSED; nothing spends until a status change the Gate or the cap saw.
// Product law 8: creatives carry the Ranger's own copy and the workspace's own images.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { resolveInWorkspace } from '../capability/tools.js';

export const META_OPTIMIZATION_GOALS = Object.freeze(['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'OFFSITE_CONVERSIONS', 'IMPRESSIONS', 'REACH', 'LEAD_GENERATION', 'POST_ENGAGEMENT']);
export const META_BILLING_EVENTS = Object.freeze(['IMPRESSIONS', 'LINK_CLICKS']);
export const META_CTA = Object.freeze(['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BUY_NOW', 'CONTACT_US', 'GET_OFFER', 'SUBSCRIBE']);
export const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
const minorToMajor = (s) => (s === undefined || s === null || s === '' ? null : Number(s) / 100);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export const adsetRow = (a) => ({ id: a.id, name: a.name, campaignId: a.campaign_id, status: a.status, effectiveStatus: a.effective_status || a.status, dailyBudget: minorToMajor(a.daily_budget), lifetimeBudget: minorToMajor(a.lifetime_budget), optimizationGoal: a.optimization_goal || '', billingEvent: a.billing_event || '', targeting: a.targeting || null, startTime: a.start_time || null, endTime: a.end_time || null });
export const adRow = (a) => ({ id: a.id, name: a.name, adsetId: a.adset_id, campaignId: a.campaign_id, status: a.status, effectiveStatus: a.effective_status || a.status, creativeId: a.creative && a.creative.id ? a.creative.id : null });
export const creativeRow = (c) => {
  const link = c.object_story_spec && c.object_story_spec.link_data ? c.object_story_spec.link_data : {};
  return { id: c.id, name: c.name || '', status: c.status || '', pageId: c.object_story_spec ? c.object_story_spec.page_id || null : null, link: link.link || null, message: link.message || '', headline: link.name || '', description: link.description || '', imageHash: link.image_hash || null, callToAction: link.call_to_action && link.call_to_action.type ? link.call_to_action.type : null, thumbnailUrl: c.thumbnail_url || null };
};

// The client calls the campaign module lacks; mixed into createMetaAdsClient's object.
export function adsetClientCalls(client, act) {
  return {
    adsets: () => client.listAll(`${act}/adsets`, { fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,start_time,end_time' }),
    ads: () => client.listAll(`${act}/ads`, { fields: 'id,name,adset_id,campaign_id,status,effective_status,creative' }),
    creatives: () => client.listAll(`${act}/adcreatives`, { fields: 'id,name,status,object_story_spec,thumbnail_url' }),
    createAdset: (body) => client.call('POST', `${act}/adsets`, { body }),
    updateAdset: (id, body) => client.call('POST', id, { body }),
    uploadImage: (bytesBase64, filename) => client.call('POST', `${act}/adimages`, { body: { bytes: bytesBase64, name: filename } }),
    createCreative: (body) => client.call('POST', `${act}/adcreatives`, { body }),
    createAd: (body) => client.call('POST', `${act}/ads`, { body }),
    updateAd: (id, body) => client.call('POST', id, { body }),
  };
}

// What activating an ad set would spend (safety H2): its own daily budget, else its
// lifetime budget in full, else nothing provable.
export function adsetBudget(a) {
  if (!a) return null;
  if (typeof a.dailyBudget === 'number' && Number.isFinite(a.dailyBudget) && a.dailyBudget > 0) return a.dailyBudget;
  if (typeof a.lifetimeBudget === 'number' && Number.isFinite(a.lifetimeBudget) && a.lifetimeBudget > 0) return a.lifetimeBudget;
  return null;
}
const dataOf = (ctx) => (ctx && ctx.connectors && ctx.connectors.status('meta_ads') ? ctx.connectors.data('meta_ads') : null);
export const adsetBudgetOf = (ctx, id) => {
  const d = dataOf(ctx);
  return adsetBudget(d ? (d.adsets || []).find((a) => a.id === id) : null);
};
// An active ad spends its ad set's budget; the ad set must be in the store.
export const adBudgetOf = (ctx, adId) => {
  const d = dataOf(ctx);
  const ad = d ? (d.ads || []).find((a) => a.id === adId) : null;
  return ad ? adsetBudgetOf(ctx, ad.adsetId) : null;
};

function need(ctx) {
  if (!ctx.connectors) return { error: { ok: false, error: 'the connector framework is not available in this run' } };
  const st = ctx.connectors.status('meta_ads');
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: 'Meta Ads is not defined in this build' } };
  const data = ctx.connectors.data('meta_ads');
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: 'Meta Ads is not connected; ask the Superintendent to connect it at the Peak' } };
  for (const k of ['adsets', 'ads', 'creatives']) if (!Array.isArray(data[k])) data[k] = [];
  return { data, status: st };
}
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
const resync = (ctx) => ctx.connectors.sync('meta_ads', 'after-write').catch(() => {});

const targetingSchema = { type: 'object', required: ['countries'], additionalProperties: false, properties: { countries: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'string', minLength: 2, maxLength: 2 }, description: 'ISO country codes, e.g. ["US", "CA"]' }, ageMin: { type: 'integer', minimum: 18, maximum: 65 }, ageMax: { type: 'integer', minimum: 18, maximum: 65 }, genders: { type: 'array', maxItems: 2, items: { type: 'integer', enum: [1, 2] }, description: '1 male, 2 female; omit for all' }, interests: { type: 'array', maxItems: 20, items: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' } } } } } };
export function targetingSpec(t) {
  const spec = { geo_locations: { countries: t.countries.map((c) => c.toUpperCase()) } };
  if (t.ageMin) spec.age_min = t.ageMin;
  if (t.ageMax) spec.age_max = t.ageMax;
  if (t.genders && t.genders.length) spec.genders = t.genders;
  if (t.interests && t.interests.length) spec.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) })) }];
  return spec;
}

export const metaAdsAdsets = {
  name: 'meta_ads.adsets',
  description: 'Ad sets of the Meta ad account from the last sync: id, name, campaign, status, budget at set level (daily or lifetime), optimisation goal, targeting. Filter: campaignId.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { campaignId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Meta Ads ad sets',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.adsets.filter((a) => !input.campaignId || a.campaignId === input.campaignId);
    return { ok: true, output: JSON.stringify({ count: rows.length, syncedAt: iso(data.syncedAt), adsets: rows.slice(0, input.limit || 50) }) };
  },
};
export const metaAdsAds = {
  name: 'meta_ads.ads',
  description: 'Ads of the Meta ad account from the last sync: id, name, ad set, campaign, status, creative id. Filters: adsetId, campaignId.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { adsetId: { type: 'string' }, campaignId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Meta Ads ads',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.ads.filter((a) => (!input.adsetId || a.adsetId === input.adsetId) && (!input.campaignId || a.campaignId === input.campaignId));
    return { ok: true, output: JSON.stringify({ count: rows.length, syncedAt: iso(data.syncedAt), ads: rows.slice(0, input.limit || 50) }) };
  },
};
export const metaAdsCreatives = {
  name: 'meta_ads.creatives',
  description: 'Ad creatives of the Meta ad account from the last sync: id, name, copy (message, headline, description), link, image hash, call to action.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Meta Ads creatives',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    return { ok: true, output: JSON.stringify({ count: data.creatives.length, syncedAt: iso(data.syncedAt), creatives: data.creatives.slice(0, input.limit || 50) }) };
  },
};

export const metaAdsCreateAdset = {
  name: 'meta_ads.create_adset',
  description: 'Create a Meta Ads ad set in a campaign, PAUSED, with its own budget at set level (money_out: the daily budget, or a lifetime budget in full, counts against the cap), targeting (countries, age range, genders, interests), an optimisation goal and a billing event. A lifetime budget needs endTime (ISO 8601).',
  inputSchema: { type: 'object', required: ['campaignId', 'name', 'targeting', 'optimizationGoal', 'billingEvent'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 200 }, dailyBudget: { type: 'number', exclusiveMinimum: 0 }, lifetimeBudget: { type: 'number', exclusiveMinimum: 0 }, endTime: { type: 'string' }, targeting: targetingSchema, optimizationGoal: { type: 'string', enum: [...META_OPTIMIZATION_GOALS] }, billingEvent: { type: 'string', enum: [...META_BILLING_EVENTS] }, bidAmount: { type: 'number', exclusiveMinimum: 0, description: 'Bid cap in major units; omit for lowest cost' } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input) => (typeof input.dailyBudget === 'number' ? input.dailyBudget : typeof input.lifetimeBudget === 'number' ? input.lifetimeBudget : null),
  summarize: (input) => `create the Meta Ads ad set "${input.name.slice(0, 60)}" in campaign ${input.campaignId} (${typeof input.dailyBudget === 'number' ? `${input.dailyBudget.toFixed(2)}/day` : typeof input.lifetimeBudget === 'number' ? `${input.lifetimeBudget.toFixed(2)} lifetime` : 'no budget'}, ${input.targeting.countries.join(',')}, paused)`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    if ((typeof input.dailyBudget === 'number') === (typeof input.lifetimeBudget === 'number')) return { ok: false, code: 'BAD_REQUEST', error: 'give exactly one of dailyBudget or lifetimeBudget' };
    if (typeof input.lifetimeBudget === 'number' && !input.endTime) return { ok: false, code: 'BAD_REQUEST', error: 'a lifetime budget needs endTime' };
    if (input.targeting.ageMin && input.targeting.ageMax && input.targeting.ageMin > input.targeting.ageMax) return { ok: false, code: 'BAD_REQUEST', error: 'ageMin is above ageMax' };
    const campaign = data.campaigns.find((c) => c.id === input.campaignId);
    if (!campaign) return { ok: false, code: 'NOT_FOUND', error: `no campaign ${input.campaignId} in the last Meta Ads sync` };
    return withClient(ctx, async (client) => {
      const body = { name: input.name, campaign_id: input.campaignId, status: 'PAUSED', targeting: targetingSpec(input.targeting), optimization_goal: input.optimizationGoal, billing_event: input.billingEvent };
      if (typeof input.dailyBudget === 'number') body.daily_budget = Math.round(input.dailyBudget * 100);
      if (typeof input.lifetimeBudget === 'number') {
        body.lifetime_budget = Math.round(input.lifetimeBudget * 100);
        body.end_time = input.endTime;
      }
      if (typeof input.bidAmount === 'number') body.bid_amount = Math.round(input.bidAmount * 100);
      const r = await client.createAdset(body);
      const row = { id: r.id, name: input.name, campaignId: input.campaignId, status: 'PAUSED', effectiveStatus: 'PAUSED', dailyBudget: typeof input.dailyBudget === 'number' ? input.dailyBudget : null, lifetimeBudget: typeof input.lifetimeBudget === 'number' ? input.lifetimeBudget : null, optimizationGoal: input.optimizationGoal, billingEvent: input.billingEvent, targeting: body.targeting, startTime: null, endTime: input.endTime || null };
      data.adsets = [row, ...data.adsets.filter((a) => a.id !== row.id)];
      resync(ctx);
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const metaAdsSetAdsetBudget = {
  name: 'meta_ads.set_adset_budget',
  description: 'Change a Meta Ads ad set\'s daily budget (money_out: the new daily budget counts against the cap).',
  inputSchema: { type: 'object', required: ['adsetId', 'dailyBudget'], additionalProperties: false, properties: { adsetId: { type: 'string', minLength: 1 }, dailyBudget: { type: 'number', exclusiveMinimum: 0 } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input) => input.dailyBudget,
  summarize: (input) => `set Meta Ads ad set ${input.adsetId} daily budget to ${input.dailyBudget.toFixed(2)}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const a = data.adsets.find((x) => x.id === input.adsetId);
    if (!a) return { ok: false, code: 'NOT_FOUND', error: `no ad set ${input.adsetId} in the last Meta Ads sync` };
    return withClient(ctx, async (client) => {
      await client.updateAdset(input.adsetId, { daily_budget: Math.round(input.dailyBudget * 100) });
      const before = a.dailyBudget;
      a.dailyBudget = input.dailyBudget;
      resync(ctx);
      return { ok: true, output: JSON.stringify({ id: a.id, name: a.name, dailyBudget: input.dailyBudget, before }) };
    });
  },
};

export const metaAdsSetAdsetStatus = {
  name: 'meta_ads.set_adset_status',
  description: 'Pause or activate a Meta Ads ad set. Activating is money_out (the set\'s daily budget counts against the cap, a lifetime budget in full; a set with no budget in the store cannot be activated from here); pausing moves no money.',
  inputSchema: { type: 'object', required: ['adsetId', 'status'], additionalProperties: false, properties: { adsetId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input, ctx) => (input.status === 'ACTIVE' ? adsetBudgetOf(ctx, input.adsetId) : 0),
  summarize: (input) => `${input.status === 'ACTIVE' ? 'activate' : 'pause'} Meta Ads ad set ${input.adsetId}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const a = data.adsets.find((x) => x.id === input.adsetId);
    if (!a) return { ok: false, code: 'NOT_FOUND', error: `no ad set ${input.adsetId} in the last Meta Ads sync` };
    if (input.status === 'ACTIVE' && adsetBudget(a) === null) return { ok: false, code: 'NO_BUDGET', error: `ad set ${input.adsetId} has no daily or lifetime budget in the store, so what activating it would spend cannot be proven` };
    return withClient(ctx, async (client) => {
      await client.updateAdset(input.adsetId, { status: input.status });
      a.status = input.status;
      a.effectiveStatus = input.status;
      resync(ctx);
      return { ok: true, output: JSON.stringify({ id: a.id, name: a.name, status: input.status, dailyBudget: a.dailyBudget, lifetimeBudget: a.lifetimeBudget }) };
    });
  },
};

export const metaAdsUploadImage = {
  name: 'meta_ads.upload_image',
  description: 'Upload an image from your workspace (PNG or JPEG, at most 8 MB) to the Meta ad account\'s image library (publishing). Returns the image hash to use in meta_ads.create_creative. Use your own images only (product law 8).',
  inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, description: 'Workspace-relative path' } } },
  confirm: false,
  domain: 'publishing',
  summarize: (input) => `upload the image ${input.path} to Meta Ads`,
  async run(input, ctx) {
    const { error } = need(ctx);
    if (error) return error;
    let abs;
    try {
      abs = await resolveInWorkspace(ctx.workspaceDir, input.path);
    } catch (err) {
      return { ok: false, code: err.code || 'SANDBOX', error: err.message };
    }
    const ext = path.extname(abs).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) return { ok: false, code: 'BAD_IMAGE', error: `${input.path} is not a PNG or JPEG` };
    let bytes;
    try {
      bytes = await fsp.readFile(abs);
    } catch (err) {
      return { ok: false, code: 'NOT_FOUND', error: `${input.path}: ${err.code || err.message}` };
    }
    if (bytes.length > IMAGE_LIMIT_BYTES) return { ok: false, code: 'TOO_LARGE', error: `${input.path} is ${bytes.length} bytes; the limit is ${IMAGE_LIMIT_BYTES}` };
    return withClient(ctx, async (client) => {
      const r = await client.uploadImage(bytes.toString('base64'), path.basename(abs));
      const images = r && r.images ? Object.values(r.images) : [];
      const img = images[0] || {};
      if (!img.hash) throw Object.assign(new Error('Meta returned no image hash'), { code: 'BAD_RESPONSE' });
      return { ok: true, output: JSON.stringify({ hash: img.hash, url: img.url || null, name: path.basename(abs), bytes: bytes.length }) };
    });
  },
};

export const metaAdsCreateCreative = {
  name: 'meta_ads.create_creative',
  description: 'Create a Meta ad creative from your own copy and an uploaded image (publishing): message (primary text), headline, description, link, call to action, image hash (from meta_ads.upload_image). The Page comes from the Superintendent\'s config (connectors.meta_ads.pageId or META_PAGE_ID).',
  inputSchema: { type: 'object', required: ['name', 'message', 'headline', 'link', 'imageHash'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, message: { type: 'string', minLength: 1, maxLength: 2000 }, headline: { type: 'string', minLength: 1, maxLength: 255 }, description: { type: 'string', maxLength: 255 }, link: { type: 'string', minLength: 1, pattern: '^https?://' }, imageHash: { type: 'string', minLength: 1 }, callToAction: { type: 'string', enum: [...META_CTA] } } },
  confirm: false,
  domain: 'publishing',
  summarize: (input) => `create the Meta ad creative "${input.name.slice(0, 60)}" (${input.headline.slice(0, 40)} → ${input.link})`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    return withClient(ctx, async (client) => {
      if (!client.pageId) return { ok: false, code: 'NO_PAGE', error: 'Meta Ads needs the Facebook Page id (connectors.meta_ads.pageId in config.json or META_PAGE_ID) before a creative can be made' };
      const linkData = { image_hash: input.imageHash, link: input.link, message: input.message, name: input.headline, ...(input.description ? { description: input.description } : {}), call_to_action: { type: input.callToAction || 'LEARN_MORE', value: { link: input.link } } };
      const r = await client.createCreative({ name: input.name, object_story_spec: { page_id: client.pageId, link_data: linkData } });
      const row = { id: r.id, name: input.name, status: 'ACTIVE', pageId: client.pageId, link: input.link, message: input.message, headline: input.headline, description: input.description || '', imageHash: input.imageHash, callToAction: linkData.call_to_action.type, thumbnailUrl: null };
      data.creatives = [row, ...data.creatives.filter((c) => c.id !== row.id)];
      resync(ctx);
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const metaAdsCreateAd = {
  name: 'meta_ads.create_ad',
  description: 'Create a Meta ad in an ad set from a creative, PAUSED (publishing: the copy goes to the platform; it spends nothing until the ad, its set and its campaign are active). Activate with meta_ads.set_ad_status.',
  inputSchema: { type: 'object', required: ['adsetId', 'name', 'creativeId'], additionalProperties: false, properties: { adsetId: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 200 }, creativeId: { type: 'string', minLength: 1 } } },
  confirm: false,
  domain: 'publishing',
  summarize: (input) => `create the Meta ad "${input.name.slice(0, 60)}" in ad set ${input.adsetId} with creative ${input.creativeId} (paused)`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const a = data.adsets.find((x) => x.id === input.adsetId);
    if (!a) return { ok: false, code: 'NOT_FOUND', error: `no ad set ${input.adsetId} in the last Meta Ads sync` };
    if (!data.creatives.some((c) => c.id === input.creativeId)) return { ok: false, code: 'NOT_FOUND', error: `no creative ${input.creativeId} in the last Meta Ads sync` };
    return withClient(ctx, async (client) => {
      const r = await client.createAd({ name: input.name, adset_id: input.adsetId, creative: { creative_id: input.creativeId }, status: 'PAUSED' });
      const row = { id: r.id, name: input.name, adsetId: input.adsetId, campaignId: a.campaignId, status: 'PAUSED', effectiveStatus: 'PAUSED', creativeId: input.creativeId };
      data.ads = [row, ...data.ads.filter((x) => x.id !== row.id)];
      resync(ctx);
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const metaAdsSetAdStatus = {
  name: 'meta_ads.set_ad_status',
  description: 'Pause or activate a Meta ad. Activating is money_out (an active ad spends its ad set\'s budget: that budget counts against the cap; an ad whose set has no budget in the store cannot be activated from here); pausing moves no money.',
  inputSchema: { type: 'object', required: ['adId', 'status'], additionalProperties: false, properties: { adId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input, ctx) => (input.status === 'ACTIVE' ? adBudgetOf(ctx, input.adId) : 0),
  summarize: (input) => `${input.status === 'ACTIVE' ? 'activate' : 'pause'} Meta ad ${input.adId}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const ad = data.ads.find((x) => x.id === input.adId);
    if (!ad) return { ok: false, code: 'NOT_FOUND', error: `no ad ${input.adId} in the last Meta Ads sync` };
    if (input.status === 'ACTIVE' && adBudgetOf(ctx, input.adId) === null) return { ok: false, code: 'NO_BUDGET', error: `ad ${input.adId}'s ad set has no budget in the store, so what activating it would spend cannot be proven` };
    return withClient(ctx, async (client) => {
      await client.updateAd(input.adId, { status: input.status });
      ad.status = input.status;
      ad.effectiveStatus = input.status;
      resync(ctx);
      return { ok: true, output: JSON.stringify({ id: ad.id, name: ad.name, status: input.status, adsetId: ad.adsetId }) };
    });
  },
};

export const META_ADSET_TOOLS = Object.freeze({
  'meta_ads.adsets': metaAdsAdsets,
  'meta_ads.ads': metaAdsAds,
  'meta_ads.creatives': metaAdsCreatives,
  'meta_ads.create_adset': metaAdsCreateAdset,
  'meta_ads.set_adset_budget': metaAdsSetAdsetBudget,
  'meta_ads.set_adset_status': metaAdsSetAdsetStatus,
  'meta_ads.upload_image': metaAdsUploadImage,
  'meta_ads.create_creative': metaAdsCreateCreative,
  'meta_ads.create_ad': metaAdsCreateAd,
  'meta_ads.set_ad_status': metaAdsSetAdStatus,
});
