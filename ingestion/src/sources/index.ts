import type { ProductCollector } from "./_collector.js";
import { mytimeFeedCollector } from "./mytime-feed.js";
import { webJsonLdCollector } from "./web-jsonld.js";
import { woocommerceCollector } from "./woocommerce.js";
import { ziaCollector } from "./zia.js";

/**
 * Product collector registry. Adding a source = one import + one entry here.
 * Each collector's `appliesTo` (routed by `web.platform` in config) decides
 * which targets it runs for.
 *
 * Steps D–F add: firecrawl web collectors (magento / nopcommerce / custom),
 * competitor social (Apify), and own-brand social (Meta/Google).
 */
export const productCollectors: ProductCollector[] = [
  mytimeFeedCollector,
  woocommerceCollector,
  webJsonLdCollector,
  ziaCollector,
];
