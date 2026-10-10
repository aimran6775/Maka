// Web search for Scouts (phase 2 step 18): the Brave Search API when the Superintendent
// configured a key (BRAVE_SEARCH_API_KEY or keystore `braveSearch`); otherwise the
// Ranger's own browser on DuckDuckGo's HTML results as the fallback, traced like any
// browser action. Research domain either way (docs/DECISIONS.md D85).
//
//   createBraveSearch({ apiKey, fetch, baseUrl }) -> { search(query, { count }) }
//   browserSearch({ browser, agentId, runId, signal, query, count, baseUrl })
//   webSearchTool({ keyFor, braveBaseUrl, duckBaseUrl })

export const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1';
export const DUCK_BASE_URL = 'https://html.duckduckgo.com/html/';
export const SEARCH_DEFAULT_COUNT = 8;

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export function createBraveSearch({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = BRAVE_BASE_URL } = {}) {
  if (!apiKey) throw new TypeError('createBraveSearch needs apiKey');
  return {
    async search(query, { count = SEARCH_DEFAULT_COUNT, freshness } = {}) {
      const url = new URL(`${baseUrl}/web/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(20, Math.max(1, count))));
      if (freshness) url.searchParams.set('freshness', freshness);
      let res;
      try {
        res = await fetchImpl(url.toString(), { headers: { accept: 'application/json', 'x-subscription-token': apiKey } });
      } catch (err) {
        throw fail('NETWORK', `Brave Search unreachable: ${err.message}`);
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw fail('BAD_RESPONSE', `Brave Search answered ${res.status} with a non-JSON body`);
      }
      if (!res.ok) throw fail(`HTTP_${res.status}`, `Brave Search ${res.status}: ${(json.error && (json.error.detail || json.error.message)) || text.slice(0, 200)}`, res.status);
      const rows = ((json.web && json.web.results) || []).map((r) => ({ title: r.title || '', url: r.url, snippet: r.description || '', age: r.age || r.page_age || null, source: 'brave' }));
      return { query, results: rows, via: 'brave' };
    },
  };
}

// Browser-side: DuckDuckGo's HTML results page, read from the DOM.
const DUCK_RESULTS_JS = `(function (n) {
  const out = [];
  for (const r of document.querySelectorAll('.result')) {
    const a = r.querySelector('a.result__a');
    const s = r.querySelector('.result__snippet');
    if (!a) continue;
    let href = a.getAttribute('href') || '';
    try { const u = new URL(href, location.href); const uddg = u.searchParams.get('uddg'); if (uddg) href = uddg; else href = u.toString(); } catch {}
    out.push({ title: (a.innerText || '').trim(), url: href, snippet: s ? (s.innerText || '').trim() : '' });
    if (out.length >= n) break;
  }
  return out;
})`;

export async function browserSearch({ browser, agentId, runId, signal, query, count = SEARCH_DEFAULT_COUNT, baseUrl = DUCK_BASE_URL }) {
  const target = `${baseUrl}?q=${encodeURIComponent(query)}`;
  const out = await browser.act({ agentId, runId, signal, action: 'search', input: { query }, checkHandoff: true, run: async (page) => {
    await page.navigate(target);
    const rows = await page.evaluate(`${DUCK_RESULTS_JS}(${count})`);
    return Array.isArray(rows) ? rows : [];
  } });
  return { query, results: (out.result || []).map((r) => ({ ...r, age: null, source: 'duckduckgo' })), via: 'browser', handoff: out.handoff || null };
}

export function webSearchTool({ keyFor, fetch: fetchImpl = globalThis.fetch, braveBaseUrl = BRAVE_BASE_URL, duckBaseUrl = DUCK_BASE_URL } = {}) {
  return {
    name: 'web.search',
    description: 'Search the web. Returns titles, URLs and snippets (the Superintendent\'s search API key when configured, else your browser on DuckDuckGo). Read a result with web.read; cite URLs as evidence.',
    inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 400 }, count: { type: 'integer', minimum: 1, maximum: 20 }, freshness: { type: 'string', enum: ['pd', 'pw', 'pm', 'py'], description: 'past day / week / month / year (API only)' } } },
    confirm: false,
    summarize: (input) => `search the web for "${input.query.slice(0, 60)}"`,
    async run(input, ctx) {
      const count = input.count || SEARCH_DEFAULT_COUNT;
      let apiKey = null;
      try {
        apiKey = keyFor ? await keyFor('braveSearch') : null;
      } catch {
        apiKey = null;
      }
      try {
        if (apiKey) {
          const r = await createBraveSearch({ apiKey, fetch: fetchImpl, baseUrl: braveBaseUrl }).search(input.query, { count, freshness: input.freshness });
          return { ok: true, output: JSON.stringify(r) };
        }
        if (!ctx.browser) return { ok: false, code: 'NO_SEARCH', error: 'no search is wired: set BRAVE_SEARCH_API_KEY (or the keystore key braveSearch), or give this camp a Field office so the browser can search' };
        const r = await browserSearch({ browser: ctx.browser, agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, query: input.query, count, baseUrl: duckBaseUrl });
        if (r.handoff && r.handoff.status === 'abandoned') return { ok: false, code: 'HANDOFF_ABANDONED', error: 'the search page needed the Superintendent and the run ended first' };
        return { ok: true, output: JSON.stringify({ query: r.query, results: r.results, via: r.via, note: 'no search API key is configured; these results came from your browser on DuckDuckGo' }) };
      } catch (err) {
        return { ok: false, code: err.code || 'SEARCH', error: err.message };
      }
    },
  };
}
