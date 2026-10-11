// Fakes for the Scout's kit: a Brave Search API (x-subscription-token), a DuckDuckGo HTML
// results page, Wikipedia's search API and Wikimedia's pageviews REST, the Algolia Hacker
// News search, Reddit's public search listing and Etsy's active listings (x-api-key), and
// an article site for web.read. One server, path-routed. Test-only.
import http from 'node:http';

export const ARTICLE_HTML = `<!doctype html><html><head><title>Paper lanterns are back · Trail Times</title>
<meta name="description" content="Why paper lanterns sell again"><meta name="author" content="R. Ranger">
<meta property="article:published_time" content="2026-09-30T10:00:00Z"><link rel="canonical" href="https://trailtimes.example/lanterns">
<script>window.x = 1;</script><style>.a{}</style></head>
<body><nav><a href="/">Home</a><a href="/about">About</a></nav>
<header><h1>Trail Times</h1></header>
<div class="sidebar"><p>Subscribe to our newsletter</p><p>Sponsored: boots</p></div>
<article><h1>Paper lanterns are back</h1><p class="byline">By R. Ranger</p>
<p>Paper lanterns sold 40 % more on handmade marketplaces this year, according to the <a href="https://stats.example/report-2026">Handmade Market Report 2026</a>.</p>
<p>Sellers quote a unit cost near $6 and a typical price of $25, leaving room for ads and shipping.</p>
<p>The trend started in autumn festivals and spread to weddings and garden parties. Three makers interviewed for this piece said their waiting lists run into weeks.</p>
<p>Shipping is the hard part: a lantern is light but bulky, so makers batch orders by region and use flat boxes; two of the three said breakage fell below two per cent once they switched packaging.</p>
<p>Ads are modest. The makers interviewed spend between five and ten dollars a day on a single marketplace campaign and stop it when the waiting list passes three weeks.</p>
<p>Read the <a href="/methodology">methodology</a> for how the figures were gathered.</p></article>
<aside><p>Related: ten boots for autumn</p></aside>
<footer><p>© Trail Times</p></footer></body></html>`;

export async function startFakeResearch({ braveKey = 'brave-key', etsyKey = 'etsy-keystring', now = Date.now() } = {}) {
  const state = { calls: [], braveResults: [{ title: 'Paper lantern trends 2026', url: 'https://trailtimes.example/lanterns', description: 'Why paper lanterns sell again', age: '2 weeks ago' }, { title: 'Handmade Market Report', url: 'https://stats.example/report-2026', description: 'Marketplace figures', page_age: '2026-09-01' }], failBrave: null, failWiki: null, failHn: null, failReddit: null, failEtsy: null, wikiViews: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    state.calls.push({ method: req.method, path: url.pathname + url.search, headers: req.headers });
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const p = url.pathname;
    if (p === '/brave/web/search') {
      if (req.headers['x-subscription-token'] !== braveKey) return send(401, { type: 'ErrorResponse', error: { detail: 'Invalid API key' } });
      if (state.failBrave) return send(state.failBrave.status || 500, { error: { detail: state.failBrave.message || 'down' } });
      const n = Number(url.searchParams.get('count')) || 10;
      return send(200, { query: { original: url.searchParams.get('q') }, web: { results: state.braveResults.slice(0, n) } });
    }
    if (p === '/duck/') {
      const q = url.searchParams.get('q') || '';
      return send(200, `<!doctype html><html><body><div id="links">${state.braveResults.map((r) => `<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&rut=x">${r.title}</a></h2><a class="result__snippet" href="${r.url}">${r.description}</a></div>`).join('')}<div class="result"><a class="result__a" href="https://other.example/${encodeURIComponent(q)}">Other: ${q}</a></div></div></body></html>`, 'text/html; charset=utf-8');
    }
    if (p === '/wiki/api.php') {
      if (state.failWiki) return send(state.failWiki.status || 500, { error: state.failWiki.message || 'down' });
      const q = url.searchParams.get('srsearch') || '';
      return send(200, { query: { search: q.toLowerCase().includes('nothing') ? [] : [{ title: 'Paper lantern', pageid: 1 }] } });
    }
    const pv = /^\/wikirest\/metrics\/pageviews\/per-article\/en\.wikipedia\/all-access\/all-agents\/([^/]+)\/daily\/(\d{8})\/(\d{8})$/.exec(p);
    if (pv) {
      if (state.failWiki) return send(state.failWiki.status || 500, { detail: state.failWiki.message || 'down' });
      const start = pv[2];
      const days = [];
      const d = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8))));
      const end = new Date(Date.UTC(Number(pv[3].slice(0, 4)), Number(pv[3].slice(4, 6)) - 1, Number(pv[3].slice(6, 8))));
      let i = 0;
      while (d <= end) {
        const ts = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}00`;
        days.push({ project: 'en.wikipedia', article: decodeURIComponent(pv[1]), granularity: 'daily', timestamp: ts, access: 'all-access', agent: 'all-agents', views: state.wikiViews ? state.wikiViews(i) : 100 + i * 10 });
        d.setUTCDate(d.getUTCDate() + 1);
        i += 1;
      }
      return send(200, { items: days });
    }
    if (p === '/hn/search') {
      if (state.failHn) return send(state.failHn.status || 500, { error: state.failHn.message || 'down' });
      return send(200, { nbHits: 2, hits: [{ objectID: '1', title: 'Show HN: a paper lantern kit', url: 'https://lanternkit.example', points: 120, num_comments: 40, created_at: new Date(now - 3 * 86400e3).toISOString() }, { objectID: '2', title: 'Ask HN: handmade marketplaces in 2026?', points: 35, num_comments: 12, created_at: new Date(now - 10 * 86400e3).toISOString() }] });
    }
    if (p === '/reddit/search.json') {
      if (!/^[a-z]+:[\w.-]+:v[\d.]+ \(/.test(req.headers['user-agent'] || '')) return send(429, { message: 'Too Many Requests', error: 429 });
      if (state.failReddit) {
        if (state.failReddit.status === 429) res.setHeader('retry-after', '30');
        return send(state.failReddit.status || 500, { message: state.failReddit.message || 'down', error: state.failReddit.status || 500 });
      }
      const q = url.searchParams.get('q') || '';
      const children = q.toLowerCase().includes('nothing') ? [] : [
        { kind: 't3', data: { title: 'I made 200 paper lanterns for a wedding', subreddit: 'crafts', score: 840, num_comments: 96, created_utc: Math.floor((now - 5 * 86400e3) / 1000), permalink: '/r/crafts/comments/abc/i_made_200_paper_lanterns/' } },
        { kind: 't3', data: { title: 'Where do you source lantern paper?', subreddit: 'Etsy', score: 120, num_comments: 44, created_utc: Math.floor((now - 12 * 86400e3) / 1000), permalink: '/r/Etsy/comments/def/where_do_you_source/' } },
        { kind: 't3', data: { title: 'Lantern festival photos', subreddit: 'crafts', score: 300, num_comments: 10, created_utc: Math.floor((now - 20 * 86400e3) / 1000), permalink: '/r/crafts/comments/ghi/lantern_festival/' } },
      ];
      return send(200, { kind: 'Listing', data: { dist: children.length, children } });
    }
    if (p === '/etsy/listings/active') {
      if (req.headers['x-api-key'] !== etsyKey) return send(401, { error: 'Invalid API key' });
      if (state.failEtsy) return send(state.failEtsy.status || 500, { error: state.failEtsy.message || 'down' });
      const q = url.searchParams.get('keywords') || '';
      const results = q.toLowerCase().includes('nothing') ? [] : [
        { listing_id: 101, title: 'Handmade paper lantern, white', url: 'https://www.etsy.com/listing/101', price: { amount: 2500, divisor: 100, currency_code: 'USD' }, num_favorers: 410, views: 9000, shop_id: 7 },
        { listing_id: 102, title: 'Paper lantern set of 10', url: 'https://www.etsy.com/listing/102', price: { amount: 4800, divisor: 100, currency_code: 'USD' }, num_favorers: 95, views: 2100, shop_id: 8 },
        { listing_id: 103, title: 'Lanterne en papier', url: 'https://www.etsy.com/listing/103', price: { amount: 1900, divisor: 100, currency_code: 'EUR' }, num_favorers: 12, views: 300, shop_id: 9 },
      ];
      return send(200, { count: results.length ? 1234 : 0, results });
    }
    if (p === '/site/lanterns') return send(200, ARTICLE_HTML, 'text/html; charset=utf-8');
    if (p === '/site/plain.txt') return send(200, 'just text\nline two', 'text/plain');
    if (p === '/site/missing') return send(404, '<html><body>no</body></html>', 'text/html');
    send(404, { error: 'no route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    braveKey,
    state,
    etsyKey,
    endpoints: { braveBaseUrl: `${url}/brave`, duckBaseUrl: `${url}/duck/`, wikiApi: `${url}/wiki/api.php`, wikiRest: `${url}/wikirest`, hnApi: `${url}/hn`, redditApi: `${url}/reddit`, etsyApi: `${url}/etsy` },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
