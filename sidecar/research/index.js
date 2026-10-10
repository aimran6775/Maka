// The Scout's research kit (phase 2 step 18), composed once per sidecar:
//
//   createResearch({ env, keystorePath, fetch, judge, workspaceRoot, endpoints })
//     -> { tools, status(), listBriefs(), trends }
//
// tools: web.search (Brave API or the browser), web.read (readable extraction),
// web.trends (Wikipedia pageviews + Hacker News), brief.submit (the venture brief, judge
// reviewed). All research except the brief, which has no domain: it writes to the
// workspace outbox only.

import { resolveKey } from '../providers/keys.js';
import { webSearchTool, BRAVE_BASE_URL, DUCK_BASE_URL } from './search.js';
import { webReadTool } from './read.js';
import { createTrends, webTrendsTool, WIKI_API, WIKI_REST, HN_API } from './trends.js';
import { briefSubmitTool, listBriefs } from './brief.js';

export function createResearch({ env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, judge = null, workspaceRoot, endpoints = {}, clock } = {}) {
  const keyFor = (name) => resolveKey(name, { env, keystorePath });
  const trends = createTrends({ fetch: fetchImpl, wikiApi: endpoints.wikiApi || WIKI_API, wikiRest: endpoints.wikiRest || WIKI_REST, hnApi: endpoints.hnApi || HN_API, clock });
  const tools = Object.freeze({
    'web.search': webSearchTool({ keyFor, fetch: fetchImpl, braveBaseUrl: endpoints.braveBaseUrl || BRAVE_BASE_URL, duckBaseUrl: endpoints.duckBaseUrl || DUCK_BASE_URL }),
    'web.read': webReadTool({ fetch: fetchImpl }),
    'web.trends': webTrendsTool(trends),
    'brief.submit': briefSubmitTool({ judge }),
  });
  return {
    tools,
    trends,
    async status() {
      const key = await keyFor('braveSearch');
      return { search: key ? 'brave' : 'browser fallback (no BRAVE_SEARCH_API_KEY)', searchKey: Boolean(key), trends: ['wikipedia', 'hacker_news'], judge: Boolean(judge) };
    },
    listBriefs: (opts) => listBriefs(workspaceRoot, opts),
  };
}
