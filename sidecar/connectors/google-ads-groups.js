// Google Ads, below the campaign (phase 4 step 7): ad groups, responsive search ads and
// image assets.
//
// Synced into the connector store beside the campaigns: `adGroups` (campaign, status,
// type, CPC bid), `ads` (responsive search ads with their headlines, descriptions and
// final URLs) and `assets` (image assets). Tools, all behind the Notice board:
//   google_ads.ad_groups / google_ads.ads / google_ads.assets   research (from the store)
//   google_ads.create_ad_group    publishing: an ad group in a campaign, PAUSED (it has no
//                                 budget of its own; the campaign's budget is what spends)
//   google_ads.set_ad_group_status  money_out when enabling: the campaign's daily budget
//                                 (an enabled group spends it; unknown → the Gate, then
//                                 NO_BUDGET); pausing moves 0
//   google_ads.create_rsa         publishing: a responsive search ad (3–15 headlines of at
//                                 most 30 characters, 2–4 descriptions of at most 90),
//                                 PAUSED
//   google_ads.set_ad_status      money_out when enabling: the campaign's daily budget;
//                                 pausing moves 0
//   google_ads.upload_image_asset publishing: an image from the Ranger's workspace
// Every create is PAUSED. Product law 8: the copy and the images are the Ranger's own.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { resolveInWorkspace } from '../capability/tools.js';

export const AD_GROUP_QUERY = "SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.campaign, ad_group.cpc_bid_micros FROM ad_group WHERE ad_group.status != 'REMOVED' ORDER BY ad_group.id";
export const AD_QUERY = "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' ORDER BY ad_group_ad.ad.id";
export const ASSET_QUERY = "SELECT asset.id, asset.name, asset.type, asset.image_asset.full_size.url, asset.image_asset.file_size FROM asset WHERE asset.type = 'IMAGE' ORDER BY asset.id";
export const RSA_LIMITS = Object.freeze({ headlines: { min: 3, max: 15, chars: 30 }, descriptions: { min: 2, max: 4, chars: 90 }, path: 15 });
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const microsToMajor = (m) => (m === undefined || m === null ? null : Number(m) / 1_000_000);
const majorToMicros = (n) => Math.round(Number(n) * 1_000_000);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const idOf = (resource) => String(resource || '').split('/').pop();

export const adGroupRow = (r) => ({ id: String(r.adGroup.id), name: r.adGroup.name, status: r.adGroup.status, type: r.adGroup.type || '', campaignId: idOf(r.adGroup.campaign), cpcBid: microsToMajor(r.adGroup.cpcBidMicros) });
export const adRow = (r) => {
  const ad = r.adGroupAd.ad || {};
  const rsa = ad.responsiveSearchAd || {};
  return { id: String(ad.id), name: ad.name || '', status: r.adGroupAd.status, type: ad.type || '', adGroupId: String(r.adGroup.id), campaignId: String(r.campaign.id), finalUrls: ad.finalUrls || [], headlines: (rsa.headlines || []).map((h) => h.text), descriptions: (rsa.descriptions || []).map((d) => d.text), path1: rsa.path1 || '', path2: rsa.path2 || '' };
};
export const assetRow = (r) => ({ id: String(r.asset.id), name: r.asset.name || '', type: r.asset.type, url: r.asset.imageAsset && r.asset.imageAsset.fullSize ? r.asset.imageAsset.fullSize.url || null : null, bytes: r.asset.imageAsset && r.asset.imageAsset.fileSize ? Number(r.asset.imageAsset.fileSize) : null });

export function adGroupClientCalls(client) {
  return {
    mutateAdGroups: (operations) => client.call('/adGroups:mutate', { operations }),
    mutateAdGroupAds: (operations) => client.call('/adGroupAds:mutate', { operations }),
    mutateAssets: (operations) => client.call('/assets:mutate', { operations }),
  };
}

// What enabling an ad group or an ad would spend (safety H2): its campaign's daily budget
// from the store; none provable → null.
const dataOf = (ctx) => (ctx && ctx.connectors && ctx.connectors.status('google_ads') ? ctx.connectors.data('google_ads') : null);
export function campaignDaily(data, campaignId) {
  const c = data ? data.campaigns.find((x) => x.id === campaignId) : null;
  return c && typeof c.dailyBudget === 'number' && Number.isFinite(c.dailyBudget) && c.dailyBudget > 0 ? c.dailyBudget : null;
}
export const adGroupBudgetOf = (ctx, adGroupId) => {
  const d = dataOf(ctx);
  const g = d ? (d.adGroups || []).find((x) => x.id === adGroupId) : null;
  return g ? campaignDaily(d, g.campaignId) : null;
};
export const adBudgetOf = (ctx, adId) => {
  const d = dataOf(ctx);
  const a = d ? (d.ads || []).find((x) => x.id === adId) : null;
  return a ? campaignDaily(d, a.campaignId) : null;
};

function need(ctx) {
  if (!ctx.connectors) return { error: { ok: false, error: 'the connector framework is not available in this run' } };
  const st = ctx.connectors.status('google_ads');
  if (!st) return { error: { ok: false, code: 'UNKNOWN_CONNECTOR', error: 'Google Ads is not defined in this build' } };
  const data = ctx.connectors.data('google_ads');
  if (!st.connected && !data.syncedAt) return { error: { ok: false, code: 'NOT_CONNECTED', error: 'Google Ads is not connected; ask the Superintendent to sign in at the Peak' } };
  for (const k of ['adGroups', 'ads', 'assets']) if (!Array.isArray(data[k])) data[k] = [];
  return { data, status: st };
}
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
const resync = (ctx) => ctx.connectors.sync('google_ads', 'after-write').catch(() => {});

// Checks a responsive search ad's copy against Google's limits; null when fine.
export function rsaProblem({ headlines, descriptions, path1, path2 }) {
  const L = RSA_LIMITS;
  if (!Array.isArray(headlines) || headlines.length < L.headlines.min || headlines.length > L.headlines.max) return `a responsive search ad needs ${L.headlines.min} to ${L.headlines.max} headlines`;
  if (!Array.isArray(descriptions) || descriptions.length < L.descriptions.min || descriptions.length > L.descriptions.max) return `a responsive search ad needs ${L.descriptions.min} to ${L.descriptions.max} descriptions`;
  for (const h of headlines) if (typeof h !== 'string' || !h.trim() || h.length > L.headlines.chars) return `headline "${String(h).slice(0, 40)}" is empty or over ${L.headlines.chars} characters`;
  for (const d of descriptions) if (typeof d !== 'string' || !d.trim() || d.length > L.descriptions.chars) return `description "${String(d).slice(0, 40)}" is empty or over ${L.descriptions.chars} characters`;
  if (new Set(headlines.map((h) => h.trim().toLowerCase())).size !== headlines.length) return 'headlines must be distinct';
  for (const p of [path1, path2]) if (p !== undefined && p !== '' && (typeof p !== 'string' || p.length > L.path || /[^A-Za-z0-9-]/.test(p))) return `path "${p}" must be at most ${L.path} letters, digits or dashes`;
  if (path2 && !path1) return 'path2 needs path1';
  return null;
}

export const googleAdsAdGroups = {
  name: 'google_ads.ad_groups',
  description: 'Ad groups of the Google Ads customer from the last sync: id, name, campaign, status (ENABLED | PAUSED), type, CPC bid. Filter: campaignId.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { campaignId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Google Ads ad groups',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.adGroups.filter((g) => !input.campaignId || g.campaignId === input.campaignId);
    return { ok: true, output: JSON.stringify({ count: rows.length, syncedAt: iso(data.syncedAt), adGroups: rows.slice(0, input.limit || 50) }) };
  },
};
export const googleAdsAds = {
  name: 'google_ads.ads',
  description: 'Ads of the Google Ads customer from the last sync (responsive search ads with headlines, descriptions, final URLs): id, ad group, campaign, status. Filters: adGroupId, campaignId.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { adGroupId: { type: 'string' }, campaignId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Google Ads ads',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const rows = data.ads.filter((a) => (!input.adGroupId || a.adGroupId === input.adGroupId) && (!input.campaignId || a.campaignId === input.campaignId));
    return { ok: true, output: JSON.stringify({ count: rows.length, syncedAt: iso(data.syncedAt), ads: rows.slice(0, input.limit || 50) }) };
  },
};
export const googleAdsAssets = {
  name: 'google_ads.assets',
  description: 'Image assets of the Google Ads customer from the last sync: id, name, URL, size.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  confirm: false,
  summarize: () => 'read the Google Ads image assets',
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    return { ok: true, output: JSON.stringify({ count: data.assets.length, syncedAt: iso(data.syncedAt), assets: data.assets.slice(0, input.limit || 50) }) };
  },
};

export const googleAdsCreateAdGroup = {
  name: 'google_ads.create_ad_group',
  description: 'Create a Google Ads ad group in a campaign, PAUSED, with a CPC bid (publishing: structure on the platform; it spends nothing until enabled, and spending comes from the campaign budget). Enable it with google_ads.set_ad_group_status.',
  inputSchema: { type: 'object', required: ['campaignId', 'name', 'cpcBid'], additionalProperties: false, properties: { campaignId: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 255 }, cpcBid: { type: 'number', exclusiveMinimum: 0, description: 'Max CPC in major units' } } },
  confirm: false,
  domain: 'publishing',
  summarize: (input) => `create the Google Ads ad group "${input.name.slice(0, 60)}" in campaign ${input.campaignId} (CPC ${input.cpcBid.toFixed(2)}, paused)`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    if (!data.campaigns.some((c) => c.id === input.campaignId)) return { ok: false, code: 'NOT_FOUND', error: `no campaign ${input.campaignId} in the last Google Ads sync` };
    return withClient(ctx, async (client) => {
      const r = await client.mutateAdGroups([{ create: { name: input.name, status: 'PAUSED', campaign: `customers/${client.customer}/campaigns/${input.campaignId}`, type: 'SEARCH_STANDARD', cpcBidMicros: String(majorToMicros(input.cpcBid)) } }]);
      const resource = r.results && r.results[0] ? r.results[0].resourceName : '';
      const row = { id: idOf(resource), name: input.name, status: 'PAUSED', type: 'SEARCH_STANDARD', campaignId: input.campaignId, cpcBid: input.cpcBid };
      data.adGroups = [row, ...data.adGroups.filter((g) => g.id !== row.id)];
      resync(ctx);
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const googleAdsSetAdGroupStatus = {
  name: 'google_ads.set_ad_group_status',
  description: 'Pause or enable a Google Ads ad group. Enabling is money_out (an enabled group spends its campaign\'s daily budget, which counts against the cap; a group whose campaign budget the store does not know cannot be enabled from here); pausing moves no money.',
  inputSchema: { type: 'object', required: ['adGroupId', 'status'], additionalProperties: false, properties: { adGroupId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['ENABLED', 'PAUSED'] } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input, ctx) => (input.status === 'ENABLED' ? adGroupBudgetOf(ctx, input.adGroupId) : 0),
  summarize: (input) => `${input.status === 'ENABLED' ? 'enable' : 'pause'} Google Ads ad group ${input.adGroupId}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const g = data.adGroups.find((x) => x.id === input.adGroupId);
    if (!g) return { ok: false, code: 'NOT_FOUND', error: `no ad group ${input.adGroupId} in the last Google Ads sync` };
    if (input.status === 'ENABLED' && campaignDaily(data, g.campaignId) === null) return { ok: false, code: 'NO_BUDGET', error: `ad group ${input.adGroupId}'s campaign has no daily budget in the store, so what enabling it would spend cannot be proven` };
    return withClient(ctx, async (client) => {
      await client.mutateAdGroups([{ update: { resourceName: `customers/${client.customer}/adGroups/${g.id}`, status: input.status }, updateMask: 'status' }]);
      g.status = input.status;
      resync(ctx);
      return { ok: true, output: JSON.stringify({ id: g.id, name: g.name, status: input.status, campaignId: g.campaignId }) };
    });
  },
};

export const googleAdsCreateRsa = {
  name: 'google_ads.create_rsa',
  description: 'Create a responsive search ad in an ad group, PAUSED (publishing: your own copy goes to the platform). 3 to 15 distinct headlines of at most 30 characters, 2 to 4 descriptions of at most 90, one or more final URLs, optional display paths. Enable it with google_ads.set_ad_status.',
  inputSchema: { type: 'object', required: ['adGroupId', 'headlines', 'descriptions', 'finalUrls'], additionalProperties: false, properties: { adGroupId: { type: 'string', minLength: 1 }, name: { type: 'string', maxLength: 255 }, headlines: { type: 'array', minItems: 3, maxItems: 15, items: { type: 'string', minLength: 1, maxLength: 30 } }, descriptions: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 90 } }, finalUrls: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', pattern: '^https?://' } }, path1: { type: 'string', maxLength: 15 }, path2: { type: 'string', maxLength: 15 } } },
  confirm: false,
  domain: 'publishing',
  summarize: (input) => `create a Google responsive search ad in ad group ${input.adGroupId} ("${input.headlines[0].slice(0, 30)}" → ${input.finalUrls[0]}, paused)`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const problem = rsaProblem(input);
    if (problem) return { ok: false, code: 'BAD_COPY', error: problem };
    const g = data.adGroups.find((x) => x.id === input.adGroupId);
    if (!g) return { ok: false, code: 'NOT_FOUND', error: `no ad group ${input.adGroupId} in the last Google Ads sync` };
    return withClient(ctx, async (client) => {
      const ad = { finalUrls: input.finalUrls, responsiveSearchAd: { headlines: input.headlines.map((text) => ({ text })), descriptions: input.descriptions.map((text) => ({ text })), ...(input.path1 ? { path1: input.path1 } : {}), ...(input.path2 ? { path2: input.path2 } : {}) }, ...(input.name ? { name: input.name } : {}) };
      const r = await client.mutateAdGroupAds([{ create: { adGroup: `customers/${client.customer}/adGroups/${g.id}`, status: 'PAUSED', ad } }]);
      const resource = r.results && r.results[0] ? r.results[0].resourceName : '';
      const id = idOf(resource).split('~').pop();
      const row = { id, name: input.name || '', status: 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', adGroupId: g.id, campaignId: g.campaignId, finalUrls: input.finalUrls, headlines: input.headlines, descriptions: input.descriptions, path1: input.path1 || '', path2: input.path2 || '' };
      data.ads = [row, ...data.ads.filter((a) => a.id !== row.id)];
      resync(ctx);
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const googleAdsSetAdStatus = {
  name: 'google_ads.set_ad_status',
  description: 'Pause or enable a Google ad. Enabling is money_out (an enabled ad spends its campaign\'s daily budget, which counts against the cap; unknown budget → cannot be enabled from here); pausing moves no money.',
  inputSchema: { type: 'object', required: ['adId', 'status'], additionalProperties: false, properties: { adId: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['ENABLED', 'PAUSED'] } } },
  confirm: false,
  domain: 'money_out',
  amountUsd: (input, ctx) => (input.status === 'ENABLED' ? adBudgetOf(ctx, input.adId) : 0),
  summarize: (input) => `${input.status === 'ENABLED' ? 'enable' : 'pause'} Google ad ${input.adId}`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
    if (error) return error;
    const a = data.ads.find((x) => x.id === input.adId);
    if (!a) return { ok: false, code: 'NOT_FOUND', error: `no ad ${input.adId} in the last Google Ads sync` };
    if (input.status === 'ENABLED' && campaignDaily(data, a.campaignId) === null) return { ok: false, code: 'NO_BUDGET', error: `ad ${input.adId}'s campaign has no daily budget in the store, so what enabling it would spend cannot be proven` };
    return withClient(ctx, async (client) => {
      await client.mutateAdGroupAds([{ update: { resourceName: `customers/${client.customer}/adGroupAds/${a.adGroupId}~${a.id}`, status: input.status }, updateMask: 'status' }]);
      a.status = input.status;
      resync(ctx);
      return { ok: true, output: JSON.stringify({ id: a.id, status: input.status, adGroupId: a.adGroupId, campaignId: a.campaignId }) };
    });
  },
};

export const googleAdsUploadImageAsset = {
  name: 'google_ads.upload_image_asset',
  description: 'Upload an image from your workspace (PNG or JPEG, at most 5 MB) as a Google Ads image asset (publishing). Use your own images only (product law 8).',
  inputSchema: { type: 'object', required: ['path', 'name'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, description: 'Workspace-relative path' }, name: { type: 'string', minLength: 1, maxLength: 255 } } },
  confirm: false,
  domain: 'publishing',
  summarize: (input) => `upload the image ${input.path} to Google Ads as "${input.name.slice(0, 40)}"`,
  async run(input, ctx) {
    const { data, error } = need(ctx);
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
      const r = await client.mutateAssets([{ create: { name: input.name, type: 'IMAGE', imageAsset: { data: bytes.toString('base64') } } }]);
      const resource = r.results && r.results[0] ? r.results[0].resourceName : '';
      const row = { id: idOf(resource), name: input.name, type: 'IMAGE', url: null, bytes: bytes.length };
      data.assets = [row, ...data.assets.filter((a) => a.id !== row.id)];
      resync(ctx);
      return { ok: true, output: JSON.stringify(row) };
    });
  },
};

export const GOOGLE_AD_GROUP_TOOLS = Object.freeze({
  'google_ads.ad_groups': googleAdsAdGroups,
  'google_ads.ads': googleAdsAds,
  'google_ads.assets': googleAdsAssets,
  'google_ads.create_ad_group': googleAdsCreateAdGroup,
  'google_ads.set_ad_group_status': googleAdsSetAdGroupStatus,
  'google_ads.create_rsa': googleAdsCreateRsa,
  'google_ads.set_ad_status': googleAdsSetAdStatus,
  'google_ads.upload_image_asset': googleAdsUploadImageAsset,
});
