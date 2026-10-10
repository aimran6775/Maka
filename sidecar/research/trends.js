// Trend signals for Scouts (phase 2 step 18) from official, keyless APIs: Wikipedia's
// pageviews (Wikimedia REST API) for the topic's article and Hacker News story activity
// (the Algolia HN Search API). Google Trends has no official API, so it is not here.
//
//   createTrends({ fetch, wikiApi, wikiRest, hnApi, clock }) -> { topic(topic, { days }) }
//   webTrendsTool(trends)

export const WIKI_API = 'https://en.wikipedia.org/w/api.php';
export const WIKI_REST = 'https://wikimedia.org/api/rest_v1';
export const HN_API = 'https://hn.algolia.com/api/v1';
export const TRENDS_DEFAULT_DAYS = 30;
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

export function createTrends({ fetch: fetchImpl = globalThis.fetch, wikiApi = WIKI_API, wikiRest = WIKI_REST, hnApi = HN_API, clock = { now: () => Date.now() } } = {}) {
  async function getJson(url, label) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA } });
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
    if (!res.ok) throw fail(`HTTP_${res.status}`, `${label} ${res.status}: ${(json.detail || json.title || json.error || text).toString().slice(0, 200)}`, res.status);
    return json;
  }
  return {
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
      const [wiki, hn] = await Promise.allSettled([this.wikipedia(topic, { days }), this.hackerNews(topic, { days })]);
      const out = { topic, days, sources: [] };
      if (wiki.status === 'fulfilled') {
        out.wikipedia = wiki.value;
        if (wiki.value.url) out.sources.push(wiki.value.url);
      } else out.wikipedia = { error: wiki.reason.message };
      if (hn.status === 'fulfilled') {
        out.hackerNews = hn.value;
        out.sources.push(`https://hn.algolia.com/?q=${encodeURIComponent(topic)}`);
      } else out.hackerNews = { error: hn.reason.message };
      if (wiki.status === 'rejected' && hn.status === 'rejected') throw fail('TRENDS_UNAVAILABLE', `no trend source answered: ${wiki.reason.message}; ${hn.reason.message}`);
      return out;
    },
  };
}

export function webTrendsTool(trends) {
  return {
    name: 'web.trends',
    description: 'Interest in a topic over the last N days from official sources: Wikipedia pageviews of the matching article (daily, total, change between halves) and Hacker News stories and points. Cite the URLs returned as evidence. Google Trends has no official API and is not included.',
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
