// Handoff heuristics (phase 2 step 13): given what the page says about itself, decide
// whether a human must take over. Pure, so it is tested without a browser.
//
//   detectHandoff(facts) -> { kind, reason } | null
//   facts: { url, title, password, otp, captcha, payment, text }  (sidecar/browser/cdp.js facts())
//
// Order matters: a captcha blocks everything else; 2FA sits behind a login; a payment page
// is more specific than a login form that happens to be on the same page.
//
// Safety 2026-10-11 H3: a payment page is not only one with card fields. A logged-in
// supplier with a saved card places the order on "Buy now" / "Confirm order" / "Buy with
// Shop Pay" with no card field in sight, so a page offering a one-click or saved-payment
// order (`RX.buy`) is a payment page by its words alone, and so is any page whose URL path
// is a checkout, cart, order, payment or purchase step (`isCheckoutUrl`), whatever it says.
// On a purchase run the browser control also refuses a click whose target reads like a
// buy / confirm / submit / pay / checkout control wherever it is (`purchaseClickRefusal`).

export const HANDOFF_KINDS = Object.freeze(['login', 'two_factor', 'captcha', 'payment']);

const RX = {
  captcha: /\b(captcha|prove you(?:'| a)?re (?:not a robot|human)|i'm not a robot|verify you are human|security check)\b/i,
  twoFactor: /\b(two[- ]factor|2fa|one[- ]time (?:code|password)|verification code|authenticator app|enter the code (?:we|that was) sent|security code we sent)\b/i,
  payment: /\b(card number|cvc|cvv|expiry|expiration date|billing address|pay now|place (?:your |the |this )?order|complete (?:your |the |this )?(?:purchase|order|payment)|buy (?:it )?now|confirm (?:your |the |this |and )?(?:order|purchase|payment|pay)|submit (?:your |the |this )?order|payment method|ending in|saved card|card on file|pay with|apple pay|google pay|shop pay|paypal|checkout|check out)\b/i,
  // One-click and saved-payment orders: enough on their own, no card word needed.
  buy: /\b(buy (?:it )?now|place (?:your |the |this )?order|confirm (?:your |the |this |and )?(?:order|purchase|payment)|submit (?:your |the |this )?order|complete (?:your |the |this )?(?:purchase|order|payment)|pay now|apple pay|google pay|shop pay|pay with paypal|(?:card |visa |mastercard |amex |american express )?ending in \d{4}|saved card|card on file|payment method)\b/i,
  // A checkout, cart, order, payment or purchase step by its URL path, as a path segment.
  checkoutUrl: /(?:^|\/)(checkouts?|cart|basket|bag|orders?|payments?|pay|purchases?|billing|buy)(?=$|[/?#._-])/i,
  loginText: /\b(sign in|log in|login|password)\b/i,
  loginUrl: /\/(login|signin|sign-in|sign_in|auth|authenticate|account\/login|session\/new)(?:[/?#]|$)/i,
};

// A click target that reads like an order / payment control. On a purchase run such a
// click is refused wherever the page is: the Superintendent places and pays every order.
export const PURCHASE_CLICK_RX = /\b(buy(?: it)? now|buy now|buy with|buy|confirm|submit|complete|place (?:your |the |this )?order|order now|pay|checkout|check out|purchase|proceed to (?:checkout|payment|pay)|continue to (?:checkout|payment|pay)|apple pay|google pay|shop pay|paypal|klarna|afterpay|one[- ]click)\b/i;

export function isCheckoutUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  let pathname = u;
  try {
    pathname = new URL(u).pathname;
  } catch {
    pathname = u.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  }
  return RX.checkoutUrl.test(pathname);
}

// { reason } when a purchase run's click must not happen, else null. `text` is the
// Ranger's target text; `element` is what the page says the located element reads
// (its text, value or aria-label) when the control located it first.
export function purchaseClickRefusal({ text = '', element = '' } = {}) {
  for (const [what, value] of [['target', text], ['element', element]]) {
    const v = String(value || '').trim();
    if (!v) continue;
    const m = PURCHASE_CLICK_RX.exec(v);
    if (m) return { reason: `the ${what} "${v.slice(0, 80)}" reads like an order or payment control ("${m[1]}"): on a purchase run the Superintendent places and pays the order, the Ranger never does` };
  }
  return null;
}

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
  if (facts.payment) return { kind: 'payment', reason: 'the page asks for card details' };
  if (!facts.password) {
    if (RX.buy.test(text)) return { kind: 'payment', reason: 'the page offers a one-click or saved-payment order' };
    if (RX.payment.test(text) && /\b(card|payment)\b/i.test(text)) return { kind: 'payment', reason: 'the page is a checkout step' };
    if (isCheckoutUrl(url)) return { kind: 'payment', reason: `the URL is a checkout, cart, order or payment page (${url.slice(0, 120)})` };
  }
  if (facts.password) return { kind: 'login', reason: 'the page asks for a password' };
  if (RX.loginUrl.test(url) && RX.loginText.test(text + ' ' + title)) return { kind: 'login', reason: 'the page is a sign-in page' };
  return null;
}
