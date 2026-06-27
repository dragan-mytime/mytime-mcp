import type { Collector } from "./_collector.js";

/**
 * The collector registry. Phase 3 registers concrete collectors here:
 *   - mytime-xml-feed         (own brand, Adform XML feed)
 *   - apify/firecrawl web     (per crawler-plan.md, one per site)
 *   - own-brand social        (Meta Graph + Google APIs)
 *   - competitor public social (Apify IG/FB/TikTok actors)
 *
 * Adding a source means adding ONE import + ONE array entry here — nothing in
 * any other source changes. The runner iterates this list with per-source
 * failure isolation.
 */
export const collectors: Collector[] = [];
