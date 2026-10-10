// Handoff heuristics (phase 2 step 13): given what the page says about itself, decide
// whether a human must take over. Pure, so it is tested without a browser.
//
//   detectHandoff(facts) -> { kind, reason } | null
//   facts: { url, title, password, otp, captcha, payment, text }  (sidecar/browser/cdp.js facts())
//
// Order matters: a captcha blocks everything else; 2FA sits behind a login; a payment page
// is more specific than a login form that happens to be on the same page.

export const HANDOFF_KINDS = Object.freeze(['login', 'two_factor', 'captcha', 'payment']);

const RX = {
  captcha: /\b(captcha|prove you(?:'| a)?re (?:not a robot|human)|i'm not a robot|verify you are human|security check)\b/i,
  twoFactor: /\b(two[- ]factor|2fa|one[- ]time (?:code|password)|verification code|authenticator app|enter the code (?:we|that was) sent|security code we sent)\b/i,
  payment: /\b(card number|cvc|cvv|expiry|expiration date|billing address|pay now|place (?:your )?order|complete purchase)\b/i,
  loginText: /\b(sign in|log in|login|password)\b/i,
  loginUrl: /\/(login|signin|sign-in|sign_in|auth|authenticate|account\/login|session\/new)(?:[/?#]|$)/i,
};

export function detectHandoff(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const text = String(facts.text || '');
  const url = String(facts.url || '');
  const title = String(facts.title || '');
  if (facts.captcha || RX.captcha.test(text) || RX.captcha.test(title)) {
    return { kind: 'captcha', reason: facts.captcha ? 'the page shows a captcha widget' : 'the page asks to prove you are human' };
  }
  if (facts.otp || (RX.twoFactor.test(text) && !facts.password)) {
    return { kind: 'two_factor', reason: facts.otp ? 'the page asks for a one-time code' : 'the page asks for a verification code' };
  }
  if (facts.payment || (RX.payment.test(text) && /\b(card|payment)\b/i.test(text) && !facts.password)) {
    return { kind: 'payment', reason: facts.payment ? 'the page asks for card details' : 'the page is a checkout step' };
  }
  if (facts.password) return { kind: 'login', reason: 'the page asks for a password' };
  if (RX.loginUrl.test(url) && RX.loginText.test(text + ' ' + title)) return { kind: 'login', reason: 'the page is a sign-in page' };
  return null;
}
