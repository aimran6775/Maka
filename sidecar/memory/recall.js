// Lexical recall (phase 4 step 11). Pure, no embeddings: tokens, a light stem, idf over
// the candidate set, a small recency term and the Superintendent's feedback.
//
//   tokenize(text) -> [term]
//   score(item, queryTerms, idf, now) -> number
//   recall(items, query, { k, now }) -> [{ item, score, matched }]   (muted items excluded)

const STOP = new Set('a an and are as at be but by for from has have if in into is it its of on or that the their then there these this to was were will with you your we our us i me my not no do does did so than too very can could should would about after before over under again more most such only own same just also'.split(' '));

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s,;:!?()[\]{}"'/\\|<>]+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9%]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// A light stem, two passes: the plural (policies → policy, boxes → box, charges → charge,
// listings → listing), then one of -ing / -ed / -ly with a doubled consonant collapsed
// (listing → list, shipped → ship, running → run). Short words and numbers are left alone.
export function stem(t) {
  if (t.length <= 3 || /\d/.test(t)) return t;
  let w = t;
  if (w.endsWith('ies') && w.length >= 5) w = `${w.slice(0, -3)}y`;
  else if (/(?:s|x|z|ch|sh)es$/.test(w) && w.length >= 5) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length >= 4) w = w.slice(0, -1);
  for (const [suffix, min] of [['ing', 6], ['ed', 5], ['ly', 5]]) {
    if (w.endsWith(suffix) && w.length >= min) {
      const base = w.slice(0, -suffix.length);
      return /([^aeiou])\1$/.test(base) ? base.slice(0, -1) : base;
    }
  }
  return w;
}

export function idfOf(items) {
  const df = new Map();
  for (const it of items) for (const t of new Set(termsOf(it))) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(items.length, 1);
  return (t) => Math.log(1 + n / (1 + (df.get(t) || 0)));
}

export function termsOf(item) {
  return item._terms || (item._terms = tokenize(`${item.text} ${(item.tags || []).join(' ')} ${item.kind || ''}`));
}

export function netFeedback(item) {
  const f = item.feedback || { up: 0, down: 0 };
  return (f.up || 0) - (f.down || 0);
}

// Net feedback at or below −1 mutes an item: it stays listed, it is never recalled.
export const isMuted = (item) => netFeedback(item) <= -1;

export function score(item, queryTerms, idf, now = Date.now()) {
  const terms = new Set(termsOf(item));
  let s = 0;
  const matched = [];
  for (const q of new Set(queryTerms)) {
    if (terms.has(q)) {
      s += idf(q);
      matched.push(q);
    }
  }
  if (!matched.length) return { score: 0, matched };
  const ageDays = Math.max(0, (now - (item.createdAt || now)) / 86_400_000);
  s += 0.2 / (1 + ageDays / 30); // a little recency, never enough to outrank a match
  s += 0.3 * Math.max(0, Math.min(3, netFeedback(item))); // a thumbs-up helps, bounded
  return { score: s, matched };
}

export function recall(items, query, { k = 5, now = Date.now() } = {}) {
  const q = tokenize(query);
  if (!q.length) return [];
  const live = items.filter((it) => !it.forgotten && !isMuted(it));
  const idf = idfOf(live);
  return live
    .map((item) => ({ item, ...score(item, q, idf, now) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.createdAt || 0) - (a.item.createdAt || 0))
    .slice(0, k);
}
