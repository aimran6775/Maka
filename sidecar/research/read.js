// Readable extraction for Scouts (phase 2 step 18): fetch a page and keep the article,
// not the chrome. Pure `extractReadable(html, url)`; the tool `web.read` fetches with the
// same limits as web.fetch and answers title, byline, date, text and the outgoing links.

import { FETCH_LIMIT_BYTES, FETCH_TIMEOUT_MS, htmlToText } from '../capability/tools.js';
import { guardedFetch, defaultNetGuard } from '../netguard.js';

export const READ_DEFAULT_CHARS = 12_000;

const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i');
    const m = re.exec(html) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').exec(html);
    if (m && m[1]) return decode(m[1]);
  }
  return null;
}

function stripChrome(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|iframe|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+(?:class|id)=["'][^"']*(?:sidebar|comment|cookie|banner|promo|newsletter|share|social|related|advert|menu|breadcrumb)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|ul|aside)>/gi, ' ');
}

// Picks the densest block: <article>, then <main>, then the <div>/<section> with the
// most paragraph text; falls back to the whole body.
function mainBlock(html) {
  const pick = (re) => {
    const m = re.exec(html);
    return m ? m[1] : null;
  };
  const article = pick(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article && htmlToText(article).length > 200) return article;
  const main = pick(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main && htmlToText(main).length > 200) return main;
  let best = null;
  let bestScore = 0;
  const re = /<(div|section)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 2000) {
    const paras = (m[2].match(/<p[\s>]/gi) || []).length;
    const len = htmlToText(m[2]).length;
    const score = paras * 200 + len;
    if (paras >= 2 && score > bestScore) {
      bestScore = score;
      best = m[2];
    }
  }
  if (best) return best;
  const body = pick(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return body || html;
}

export function extractReadable(html, url = '') {
  const raw = String(html || '');
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1] || '') || meta(raw, ['og:title', 'twitter:title']) || '';
  const description = meta(raw, ['description', 'og:description', 'twitter:description']);
  const byline = meta(raw, ['author', 'article:author', 'byl']) || decode(((/<[^>]+(?:class|rel)=["'][^"']*(?:byline|author)[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(raw) || [])[1] || '').replace(/<[^>]+>/g, ' ')) || null;
  const published = meta(raw, ['article:published_time', 'datePublished', 'date', 'pubdate', 'og:updated_time']) || (/<time[^>]+datetime=["']([^"']+)["']/i.exec(raw) || [])[1] || null;
  const canonical = (/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(raw) || [])[1] || null;
  const cleaned = stripChrome(raw);
  const block = mainBlock(cleaned);
  const text = htmlToText(block);
  const links = [];
  const seen = new Set();
  const lre = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = lre.exec(block)) && links.length < 60) {
    let href = lm[1];
    try {
      href = new URL(href, url || undefined).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const label = decode(lm[2].replace(/<[^>]+>/g, ' '));
    if (label) links.push({ text: label.slice(0, 120), url: href });
  }
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return { url: canonical || url || null, title, description: description || null, byline: byline || null, published: published || null, text, words, links };
}

// The kit's own fetch (the sidecar's global one), not the run's: the run's fetch is the
// Ollama probe's in tests and web.read reads the open web like the connectors do.
export function webReadTool({ fetch: kitFetch = globalThis.fetch } = {}) {
  return {
    name: 'web.read',
    description: 'Read a public page as an article: title, author, date, the main text (navigation and chrome removed) and its links. Use the URL as evidence in a venture brief. maxChars bounds the text.',
    inputSchema: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 1 }, maxChars: { type: 'integer', minimum: 500, maximum: 60000 } } },
    confirm: false,
    summarize: (input) => `read ${input.url.slice(0, 80)}`,
    async run(input, ctx) {
      let url;
      try {
        url = new URL(input.url);
      } catch {
        return { ok: false, error: `not a valid URL: ${input.url}` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: `only http and https are allowed, got ${url.protocol}` };
      // Safety H1: only the public internet, checked after DNS and on every redirect hop.
      const guard = ctx.netGuard || defaultNetGuard();
      const verdict = await guard.check(url);
      if (!verdict.ok) return { ok: false, code: 'NET_GUARD', error: verdict.reason };
      const fetchImpl = kitFetch;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (ctx.signal) {
        if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => ac.abort(), ctx.fetchTimeoutMs || FETCH_TIMEOUT_MS);
      try {
        const res = await guardedFetch(url.toString(), { method: 'GET', signal: ac.signal, headers: { 'user-agent': 'Maka/0.1 (+local agent harness)', accept: 'text/html, text/plain;q=0.9, */*;q=0.5' } }, { fetch: fetchImpl, guard });
        const type = (res.headers.get('content-type') || '').toLowerCase();
        const raw = Buffer.from(await res.arrayBuffer());
        const body = raw.subarray(0, FETCH_LIMIT_BYTES).toString('utf8');
        if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, error: `HTTP ${res.status} for ${url}` };
        const max = input.maxChars || READ_DEFAULT_CHARS;
        if (!type.includes('html')) {
          const text = body.length > max ? `${body.slice(0, max)}\n[truncated]` : body;
          return { ok: true, output: JSON.stringify({ url: res.url || url.toString(), title: '', contentType: type, text, words: text.split(/\s+/).filter(Boolean).length, links: [] }) };
        }
        const doc = extractReadable(body, res.url || url.toString());
        if (doc.text.length > max) doc.text = `${doc.text.slice(0, max)}\n[truncated: ${doc.text.length} characters in total]`;
        doc.fetchedAt = new Date().toISOString();
        doc.truncatedFetch = raw.length > FETCH_LIMIT_BYTES;
        return { ok: true, output: JSON.stringify(doc) };
      } catch (err) {
        if (ac.signal.aborted && ctx.signal && ctx.signal.aborted) return { ok: false, error: 'cancelled' };
        if (ac.signal.aborted) return { ok: false, error: `fetch timed out after ${ctx.fetchTimeoutMs || FETCH_TIMEOUT_MS} ms` };
        if (err && (err.code === 'NET_GUARD' || err.code === 'TOO_MANY_REDIRECTS' || err.code === 'BAD_REDIRECT')) return { ok: false, code: err.code, error: err.message };
        return { ok: false, error: `fetch failed: ${err && err.message ? err.message : err}` };
      } finally {
        clearTimeout(timer);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
