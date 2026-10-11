// Redaction before anything enters a Ranger's memory (phase 4 step 11). Pure.
//
//   redact(text) -> { text, redactions: [{ kind, count }] }
//
// Secrets (provider keys, bearer tokens, JWTs, cloud access keys, webhook secrets, long
// opaque tokens) and personal data (email addresses, phone numbers, card numbers, national
// id patterns, IBANs) are replaced by a bracketed label. The rules are patterns, so they
// catch the shapes Maka itself handles (sk-…, sk_live_…, whsec_…, xoxb-…, ghp_…, AKIA…,
// EAAB…, hf_…) and the common personal forms; they are not a proof that nothing slipped,
// and the memory tells the Ranger what it removed so the Ranger can rephrase.

const RULES = [
  // Secrets first: a key must never survive as part of a "personal data" match.
  { kind: 'api key', re: /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|rk_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|hf_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|EAA[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|shpat_[a-f0-9]{16,}|shpca_[a-f0-9]{16,}|re_[A-Za-z0-9_]{16,})\b/g },
  { kind: 'bot token', re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer token', re: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  // `password=…`, `api_key: "…"`, or `password …` when the value looks like one (a digit or a symbol in it).
  { kind: 'secret assignment', re: /\b((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)(?:\s*[:=]\s*|\s+(?=[^\s"',;]*[\d_\-!@#$%^&*~+])))["']?[^\s"',;]{6,}["']?/gi, keepGroup: 1 },
  { kind: 'opaque token', re: /\b[A-Za-z0-9_-]{40,}\b/g, unless: /^[a-z-]+$/ },
  // Personal data.
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'card number', re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => luhn(m.replace(/\D/g, '')) },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g },
  { kind: 'national id', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Phone numbers in the shapes people write them: +cc …, (415) 555-2671, 415-555-2671, 020 7946 0958.
  { kind: 'phone number', re: /(?:\+\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}|\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\b\d{3}[ .-]\d{3}[ .-]\d{4}|\b0\d{2,4}[ .-]\d{3,4}[ .-]\d{3,4})\b/g, check: (m) => m.replace(/\D/g, '').length >= 9 && m.replace(/\D/g, '').length <= 15 },
];

function luhn(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redact(input) {
  let text = String(input ?? '');
  const counts = new Map();
  for (const rule of RULES) {
    text = text.replace(rule.re, (m, ...groups) => {
      if (rule.unless && rule.unless.test(m)) return m;
      if (rule.check && !rule.check(m)) return m;
      if (/\[redacted [a-z ]+\]/.test(m)) return m;
      counts.set(rule.kind, (counts.get(rule.kind) || 0) + 1);
      const keep = rule.keepGroup ? groups[rule.keepGroup - 1] || '' : '';
      return `${keep}[redacted ${rule.kind}]`;
    });
  }
  return { text, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

export function hasSecrets(text) {
  return redact(text).redactions.some((r) => ['api key', 'bot token', 'jwt', 'bearer token', 'secret assignment', 'opaque token'].includes(r.kind));
}
