// The connectors Maka knows, one spec each for sidecar/connectors/registry.js. Step 17
// adds Meta Ads and Google Ads here.

import { stripeSpec } from './stripe.js';
import { shopifySpec } from './shopify.js';
import { etsySpec } from './etsy.js';

export const CONNECTOR_SPECS = Object.freeze([stripeSpec(), shopifySpec(), etsySpec()]);
