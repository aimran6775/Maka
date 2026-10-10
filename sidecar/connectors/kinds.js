// The connectors Maka knows, one spec each for sidecar/connectors/registry.js. Steps 16
// and 17 add Shopify, Etsy, Meta Ads and Google Ads here.

import { stripeSpec } from './stripe.js';

export const CONNECTOR_SPECS = Object.freeze([stripeSpec()]);
