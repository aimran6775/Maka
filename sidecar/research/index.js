// The Scout's research kit (phase 2 step 18), composed once per sidecar:
//
//   createResearch({ env, keystorePath, fetch, judge, workspaceRoot, endpoints })
//     -> { tools, status(), listBriefs(), trends }
//
// tools: web.search (Brave API or the browser), web.read (readable extraction),
// web.trends (Wikipedia pageviews + Hacker News + Reddit + Etsy listings when the keystring
// is set; phase 4 step 16), brief.submit (the venture brief, judge reviewed). All research except the brief, which has no domain: it writes to the
// workspace outbox only.

import { resolveKey } from '../providers/keys.js';
import { webSearchTool, BRAVE_BASE_URL, DUCK_BASE_URL } from './search.js';
import { webReadTool } from './read.js';
import { createTrends, webTrendsTool, WIKI_API, WIKI_REST, HN_API, REDDIT_API, ETSY_OPEN_API, TRENDS_SOURCES } from './trends.js';
import { briefSubmitTool, listBriefs } from './brief.js';

// `memory` (phase 4 step 10): the Scout's memory; brief.submit records every brief there and
// the judge's review of a brief reads its scored history.
export function createResearch({ env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, judge = null, memory = null, workspaceRoot, endpoints = {}, clock } = {}) {
  const keyFor = (name) => resolveKey(name, { env, keystorePath });
  const trends = createTrends({ fetch: fetchImpl, wikiApi: endpoints.wikiApi || WIKI_API, wikiRest: endpoints.wikiRest || WIKI_REST, hnApi: endpoints.hnApi || HN_API, redditApi: endpoints.redditApi || REDDIT_API, etsyApi: endpoints.etsyApi || ETSY_OPEN_API, etsyKey: () => keyFor('etsyClientId'), clock, sleep: endpoints.sleep });
  const tools = Object.freeze({
    'web.search': webSearchTool({ keyFor, fetch: fetchImpl, braveBaseUrl: endpoints.braveBaseUrl || BRAVE_BASE_URL, duckBaseUrl: endpoints.duckBaseUrl || DUCK_BASE_URL }),
    'web.read': webReadTool({ fetch: fetchImpl }),
    'web.trends': webTrendsTool(trends),
    'brief.submit': briefSubmitTool({ judge, memory }),
  });
  return {
    tools,
    trends,
    async status() {
      const key = await keyFor('braveSearch');
      const etsy = await keyFor('etsyClientId');
      return { search: key ? 'brave' : 'browser fallback (no BRAVE_SEARCH_API_KEY)', searchKey: Boolean(key), trends: TRENDS_SOURCES.map((t) => (t === 'etsy' && !etsy ? 'etsy (not wired: ETSY_CLIENT_ID)' : t)), judge: Boolean(judge) };
    },
    listBriefs: (opts) => listBriefs(workspaceRoot, opts),
  };
}
