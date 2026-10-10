// The connectors Maka knows, one spec each for sidecar/connectors/registry.js: Stripe
// (step 15), Shopify and Etsy (step 16), Meta Ads and Google Ads (step 17).

import { stripeSpec } from './stripe.js';
import { shopifySpec } from './shopify.js';
import { etsySpec } from './etsy.js';
import { metaAdsSpec } from './meta-ads.js';
import { googleAdsSpec } from './google-ads.js';

export const CONNECTOR_SPECS = Object.freeze([stripeSpec(), shopifySpec(), etsySpec(), metaAdsSpec(), googleAdsSpec()]);
