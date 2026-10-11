// Trend signals for Scouts (phase 2 step 18) from official, keyless APIs: Wikipedia's
// pageviews (Wikimedia REST API) for the topic's article and Hacker News story activity
// (the Algolia HN Search API). Google Trends has no official API, so it is not here.
//
// Phase 4 step 16 (D147) adds Reddit's public JSON listings (one search request per lookup
// under Reddit's rules: a descriptive User-Agent, requests spaced at least
// REDDIT_MIN_INTERVAL_MS apart, a 429 reported as rate limited and never retried in a loop,
// no HTML) and Etsy's active listings for the keywords sorted by Etsy's own score through
// the Open API, which needs the app keystring ETSY_CLIENT_ID (no OAuth); without it the Etsy
// row says not wired. Etsy's API has no separate "trending" list; this is what it offers.
//
//   createTrends({ fetch, wikiApi, wikiRest, hnApi, redditApi, etsyApi, etsyKey, clock, sleep })
//     -> { wikipedia(), hackerNews(), reddit(), etsy(), topic(topic, { days }) }
//   webTrendsTool(trends)

export const WIKI_API = 'https://en.wikipedia.org/w/api.php';
export const WIKI_REST = 'https://wikimedia.org/api/rest_v1';
export const HN_API = 'https://hn.algolia.com/api/v1';
export const REDDIT_API = 'https://www.reddit.com';
export const ETSY_OPEN_API = 'https://api.etsy.com/v3/application';
export const TRENDS_DEFAULT_DAYS = 30;
export const REDDIT_MIN_INTERVAL_MS = 1100; // Reddit allows about one unauthenticated request a second
// Reddit's rule: a unique, descriptive User-Agent in the form platform:app:version (contact).
export const REDDIT_UA = 'nodejs:com.makapark.maka:v0.1 (local agent harness, one search per lookup)';
export const TRENDS_SOURCES = Object.freeze(['wikipedia', 'hacker_news', 'reddit', 'etsy']);
const UA = 'Maka/0.1 (+local agent harness; research tool)';

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

export function slope(series) {
  if (!series || series.length < 2) return 0;
  const half = Math.floor(series.length / 2);
  const first = series.slice(0, half).reduce((n, x) => n + x, 0) / half;
  const second = series.slice(series.length - half).reduce((n, x) => n + x, 0) / half;
  if (!first) return second ? 1 : 0;
  return Number(((second - first) / first).toFixed(3));
}

// Reddit's `t=` window for a day count.
export function redditWindow(days) {
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  return 'year';
}

// The middle price of Etsy listings, per currency (a listing's price is amount / divisor).
export function medianPrices(listings) {
  const byCurrency = new Map();
  for (const l of listings) {
    const p = l.price;
    if (!p || typeof p.amount !== 'number' || !p.divisor) continue;
    const cur = p.currency_code || 'USD';
    if (!byCurrency.has(cur)) byCurrency.set(cur, []);
    byCurrency.get(cur).push(p.amount / p.divisor);
  }
  const out = {};
  for (const [cur, prices] of byCurrency) {
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    out[cur] = Number((prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2).toFixed(2));
  }
  return out;
}

export function createTrends({ fetch: fetchImpl = globalThis.fetch, wikiApi = WIKI_API, wikiRest = WIKI_REST, hnApi = HN_API, redditApi = REDDIT_API, etsyApi = ETSY_OPEN_API, etsyKey = async () => null, clock = { now: () => Date.now() }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  async function getJson(url, label, headers = {}) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA, ...headers } });
    } catch (err) {
      throw fail('NETWORK', `${label} unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw fail('BAD_RESPONSE', `${label} answered ${res.status} with a non-JSON body`);
    }
    if (res.status === 429) throw fail('RATE_LIMITED', `${label} rate limited (429)${res.headers && res.headers.get && res.headers.get('retry-after') ? `, retry after ${res.headers.get('retry-after')} s` : ''}; not retried`, 429);
    if (!res.ok) throw fail(`HTTP_${res.status}`, `${label} ${res.status}: ${(json.detail || json.title || json.error || json.message || text).toString().slice(0, 200)}`, res.status);
    return json;
  }
  let redditNextAt = 0; // the earliest time the next Reddit request may go out
  return {
    async reddit(topic, { days = TRENDS_DEFAULT_DAYS } = {}) {
      const now = clock.now();
      if (now < redditNextAt) await sleep(redditNextAt - now);
      redditNextAt = clock.now() + REDDIT_MIN_INTERVAL_MS;
      const json = await getJson(`${redditApi}/search.json?q=${encodeURIComponent(topic)}&sort=top&t=${redditWindow(days)}&limit=25&raw_json=1`, 'Reddit search', { 'user-agent': REDDIT_UA });
      const posts = ((json.data && json.data.children) || []).map((c) => c.data || {}).map((d) => ({ title: d.title || '', subreddit: d.subreddit || '', score: d.score || 0, comments: d.num_comments || 0, createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null, url: d.permalink ? `https://www.reddit.com${d.permalink}` : null }));
      const bySub = new Map();
      for (const p of posts) bySub.set(p.subreddit, (bySub.get(p.subreddit) || 0) + 1);
      return { posts: posts.length, score: posts.reduce((n, p) => n + p.score, 0), comments: posts.reduce((n, p) => n + p.comments, 0), subreddits: [...bySub].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, posts: count })), top: [...posts].sort((a, b) => b.score - a.score).slice(0, 5), window: redditWindow(days) };
    },
    async etsy(topic) {
      const key = await etsyKey();
      if (!key) throw fail('NOT_WIRED', 'Etsy listings need ETSY_CLIENT_ID (the app keystring); not wired');
      const json = await getJson(`${etsyApi}/listings/active?keywords=${encodeURIComponent(topic)}&sort_on=score&sort_order=desc&limit=25`, 'Etsy listings', { 'x-api-key': key });
      const results = Array.isArray(json.results) ? json.results : [];
      const listings = results.map((l) => ({ listingId: l.listing_id, title: l.title || '', url: l.url || (l.listing_id ? `https://www.etsy.com/listing/${l.listing_id}` : null), price: l.price && typeof l.price.amount === 'number' && l.price.divisor ? { amount: Number((l.price.amount / l.price.divisor).toFixed(2)), currency: l.price.currency_code || 'USD' } : null, favourites: l.num_favorers || 0, views: l.views || 0, shopId: l.shop_id || null }));
      return { listings: listings.length, total: typeof json.count === 'number' ? json.count : listings.length, medianPrice: medianPrices(results), favourites: listings.reduce((n, l) => n + l.favourites, 0), top: [...listings].sort((a, b) => b.favourites - a.favourites).slice(0, 5), sortedBy: 'Etsy score (the API has no separate trending list)' };
    },
    async wikipedia(topic, { days = TRENDS_DEFAULT_DAYS } = {}) {
      const search = await getJson(`${wikiApi}?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(topic)}`, 'Wikipedia search');
      const hit = search.query && search.query.search && search.query.search[0];
      if (!hit) return { article: null, daily: [], total: 0, change: 0, url: null };
      const end = new Date(clock.now() - 86_400_000);
      const start = new Date(end.getTime() - (days - 1) * 86_400_000);
      const article = hit.title;
      const views = await getJson(`${wikiRest}/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(article.replace(/ /g, '_'))}/daily/${ymd(start)}/${ymd(end)}`, 'Wikimedia pageviews');
      const daily = (views.items || []).map((it) => ({ date: `${it.timestamp.slice(0, 4)}-${it.timestamp.slice(4, 6)}-${it.timestamp.slice(6, 8)}`, views: it.views }));
      return { article, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replace(/ /g, '_'))}`, daily, total: daily.reduce((n, d) => n + d.views, 0), change: slope(daily.map((d) => d.views)) };
    },
    async hackerNews(topic, { days = TRENDS_DEFAULT_DAYS } = {}) {
      const since = Math.floor((clock.now() - days * 86_400_000) / 1000);
      const json = await getJson(`${hnApi}/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=50&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`, 'Hacker News search');
      const hits = (json.hits || []).map((h) => ({ title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points || 0, comments: h.num_comments || 0, createdAt: h.created_at }));
      return { stories: hits.length, totalStories: json.nbHits || hits.length, points: hits.reduce((n, h) => n + h.points, 0), top: hits.sort((a, b) => b.points - a.points).slice(0, 5) };
    },
    async topic(topic, { days = TRENDS_DEFAULT_DAYS } = {}) {
      const [wiki, hn, reddit, etsy] = await Promise.allSettled([this.wikipedia(topic, { days }), this.hackerNews(topic, { days }), this.reddit(topic, { days }), this.etsy(topic)]);
      const out = { topic, days, sources: [] };
      if (wiki.status === 'fulfilled') {
        out.wikipedia = wiki.value;
        if (wiki.value.url) out.sources.push(wiki.value.url);
      } else out.wikipedia = { error: wiki.reason.message };
      if (hn.status === 'fulfilled') {
        out.hackerNews = hn.value;
        out.sources.push(`https://hn.algolia.com/?q=${encodeURIComponent(topic)}`);
      } else out.hackerNews = { error: hn.reason.message };
      if (reddit.status === 'fulfilled') {
        out.reddit = reddit.value;
        out.sources.push(`https://www.reddit.com/search/?q=${encodeURIComponent(topic)}&sort=top&t=${redditWindow(days)}`);
      } else out.reddit = { error: reddit.reason.message };
      if (etsy.status === 'fulfilled') {
        out.etsy = etsy.value;
        out.sources.push(`https://www.etsy.com/search?q=${encodeURIComponent(topic)}`);
      } else out.etsy = { error: etsy.reason.message, notWired: etsy.reason.code === 'NOT_WIRED' };
      const failed = [wiki, hn, reddit, etsy].filter((r) => r.status === 'rejected');
      if (failed.length === 4) throw fail('TRENDS_UNAVAILABLE', `no trend source answered: ${failed.map((r) => r.reason.message).join('; ')}`);
      return out;
    },
  };
}

export function webTrendsTool(trends) {
  return {
    name: 'web.trends',
    description: "Interest in a topic over the last N days from official sources: Wikipedia pageviews of the matching article (daily, total, change between halves), Hacker News stories and points, Reddit's top posts for the search (score, comments, subreddits; one request, rate limited by Reddit's rules) and, when ETSY_CLIENT_ID is set, Etsy's active listings for the keywords sorted by Etsy's own score (count, median price per currency, favourites). Cite the URLs returned as evidence; a source that failed says so in its row. Google Trends has no official API and is not included.",
    inputSchema: { type: 'object', required: ['topic'], additionalProperties: false, properties: { topic: { type: 'string', minLength: 1, maxLength: 200 }, days: { type: 'integer', minimum: 7, maximum: 365 } } },
    confirm: false,
    summarize: (input) => `look up interest in "${input.topic.slice(0, 60)}"`,
    async run(input, ctx) {
      try {
        const t = ctx.trends || trends;
        const out = await t.topic(input.topic, { days: input.days || TRENDS_DEFAULT_DAYS });
        return { ok: true, output: JSON.stringify(out) };
      } catch (err) {
        return { ok: false, code: err.code || 'TRENDS', error: err.message };
      }
    },
  };
}
