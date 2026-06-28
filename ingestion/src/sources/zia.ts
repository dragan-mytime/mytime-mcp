import { optionalEnv, type ProductObservation } from "@mytime/shared";
import { cleanText, deriveDiscount, normalizeGender } from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const UA = "MyTimeBI/1.0 (+https://mcp.mytimeprime.mk)";
const MAX = Number(optionalEnv("WEB_MAX_PRODUCTS", "300"));

interface ZiaItem {
  _id: string;
  name?: string;
  price?: number;
  stock?: number;
  status?: string;
  category?: { name?: string };
  images?: (string | { url?: string; src?: string })[];
  tags?: unknown;
  zodiac?: unknown;
}
interface ZiaPage {
  data?: ZiaItem[];
  nextCursor?: string | null;
}

function image(it: ZiaItem): string | null {
  const first = it.images?.[0];
  if (!first) return null;
  return typeof first === "string" ? first : (first.url ?? first.src ?? null);
}

function map(it: ZiaItem, base: string): ProductObservation {
  const price = Number(it.price) || 0;
  const stock = typeof it.stock === "number" ? it.stock : null;
  const name = cleanText(it.name);
  const attrs = it.zodiac || it.tags ? { zodiac: it.zodiac ?? null, tags: it.tags ?? null } : null;

  return {
    externalId: it._id,
    name: name ?? it._id,
    brand: "Zia",
    modelRef: name,
    category: cleanText(it.category?.name),
    gender: normalizeGender(it.category?.name) ?? normalizeGender(name),
    collection: null,
    attributes: attrs,
    url: `${base}/products/${it._id}`,
    imageUrl: image(it),
    currency: "MKD",
    price,
    ...deriveDiscount(price, null),
    stockStatus: it.status === "active" && (stock ?? 0) > 0 ? "in_stock" : "out_of_stock",
    stockQuantity: stock,
    qtyBasis: stock != null ? "exact" : "unknown",
    locationsCount: 0,
    inStockLocations: null,
  };
}

/**
 * Zia collector via its JSON API (`/api/products`, cursor-paginated, 2/page).
 * Richest of the custom sites — exposes exact `stock` and price directly, so no
 * page scraping is needed.
 */
export const ziaCollector: ProductCollector = {
  id: "zia-api",
  label: "Zia JSON API",
  appliesTo: (t) => t.id === "zia" && !!t.web.url,
  async collect({ target }: CollectorContext): Promise<ProductObservation[]> {
    const base = new URL(target.web.url ?? "").origin;
    const out: ProductObservation[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let i = 0; i < 5000 && out.length < MAX; i++) {
      const url = `${base}/api/products${cursor ? `?cursor=${cursor}` : ""}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Zia API HTTP ${res.status}`);
      const page = (await res.json()) as ZiaPage;
      const items = page.data ?? [];
      let added = 0;
      for (const it of items) {
        if (it._id && !seen.has(it._id)) {
          seen.add(it._id);
          out.push(map(it, base));
          added++;
        }
      }
      const next = page.nextCursor;
      if (!next || next === cursor || added === 0) break;
      cursor = next;
    }
    return out.slice(0, MAX);
  },
};
