import { optionalEnv, type ProductObservation } from "@mytime/shared";
import { cleanText, deriveDiscount, toNumber } from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";
import { openCloudflareSession } from "./browser-fetch.js";

const MAX = Number(optionalEnv("WEB_MAX_PRODUCTS", "300"));
const LISTING = "/mk/proizvodi"; // Magento all-products category (24/page, ?p=N)

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Parse Magento product cards from a server-rendered category listing page. */
function parseListing(html: string): ProductObservation[] {
  const out: ProductObservation[] = [];
  // One chunk per product card.
  for (const chunk of html.split("product-item-info").slice(1)) {
    const link = chunk.match(/class="product-item-link"\s+href="([^"]+)"[^>]*>\s*([^<]+)</);
    if (!link?.[1]) continue;
    const url = link[1];
    const name = cleanText(decodeEntities(link[2] ?? ""));
    const price = toNumber(chunk.match(/data-price-amount="([0-9.]+)"/)?.[1]);
    if (price == null) continue;
    const id = chunk.match(/data-product-id="([0-9]+)"/)?.[1];
    const img = chunk.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null;
    const code = name?.match(/\b([A-Za-z]*\d[A-Za-z0-9]{3,})\b/)?.[1] ?? null;
    const oos = /(?:нема на залиха|out-of-stock|unavailable)/i.test(chunk);

    out.push({
      externalId: id ?? url.split("/").filter(Boolean).pop() ?? url,
      name: name ?? url,
      brand: "Pandora", // monobrand franchise
      modelRef: code?.toUpperCase() ?? null,
      category: null,
      gender: null,
      collection: null,
      attributes: null,
      url,
      imageUrl: cleanText(img),
      currency: "MKD",
      price,
      ...deriveDiscount(price, null),
      stockStatus: oos ? "out_of_stock" : "in_stock",
      stockQuantity: null,
      qtyBasis: "assumed",
      locationsCount: 0,
      inStockLocations: null,
    });
  }
  return out;
}

/**
 * Pandora (Magento) collector via the server-rendered all-products listing.
 * Monobrand — depletion reflects demand for the single brand only.
 *
 * pandorashop.mk sits behind a Cloudflare JS challenge (every plain fetch 403s), so the
 * listing pages are fetched through a headful-Chromium session (see ./browser-fetch.ts) —
 * the same mechanism as watch-club. The listing HTML stays server-rendered behind the
 * challenge, so the existing `parseListing` works unchanged on the fetched body.
 */
export const pandoraCollector: ProductCollector = {
  id: "pandora-magento",
  label: "Pandora Magento listing",
  appliesTo: (t) => t.id === "pandora" && !!t.web.url,
  async collect({ target }: CollectorContext): Promise<ProductObservation[]> {
    const base = new URL(target.web.url ?? "").origin;
    const out: ProductObservation[] = [];
    const seen = new Set<string>();
    const session = await openCloudflareSession(base);

    try {
      for (let page = 1; page <= 200 && out.length < MAX; page++) {
        const url = `${base}${LISTING}?p=${page}`;
        let html: string;
        try {
          html = await session.fetchText(url);
        } catch (err) {
          throw new Error(`Pandora page ${page} failed: ${(err as Error).message}`);
        }
        const items = parseListing(html);
        if (items.length === 0) break;
        let added = 0;
        for (const it of items) {
          if (!seen.has(it.externalId)) {
            seen.add(it.externalId);
            out.push(it);
            added++;
          }
        }
        if (added === 0) break; // pagination exhausted (repeating page)
      }
      return out.slice(0, MAX);
    } finally {
      await session.close();
    }
  },
};
