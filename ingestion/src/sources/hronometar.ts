import { optionalEnv, type ProductObservation } from "@mytime/shared";
import { cleanText, deriveDiscount, normalizeGender } from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const UA = "MyTimeBI/1.0 (+https://mcp.my.mk)";
const MAX = Number(optionalEnv("WEB_MAX_PRODUCTS", "300"));
const CONCURRENCY = 6;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** All same-host page URLs via FireCrawl map (renders the JS site). */
async function fcMapAll(siteUrl: string, host: string): Promise<string[]> {
  const key = optionalEnv("FIRECRAWL_API_KEY");
  if (!key) throw new Error("FIRECRAWL_API_KEY required");
  const res = await fetch("https://api.firecrawl.dev/v2/map", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: siteUrl, limit: 5000 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`FireCrawl map HTTP ${res.status}`);
  const j = (await res.json()) as { links?: (string | { url?: string })[] };
  const urls = (j.links ?? []).map((l) => (typeof l === "string" ? l : (l.url ?? "")));
  return [
    ...new Set(urls.filter((u) => u.includes(host) && !/\.(?:jpg|png|css|js|svg|xml)/i.test(u))),
  ];
}

/** European number format: "5.750,00" → 5750.00. */
function parseEuPrice(s: string): number | null {
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Parse a nopCommerce product page; returns null for non-product pages (categories). */
function parseNop(html: string, url: string): ProductObservation | null {
  if (!/product-details-form/.test(html)) return null; // product-page marker
  const name = cleanText(html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]);
  const priceRaw = html.match(/(?:actual-price|price-value-\d+)[^>]*>\s*([0-9.,]+)/)?.[1];
  const price = priceRaw ? parseEuPrice(priceRaw) : null;
  // Skip price-on-request items (nopCommerce renders "0,00" when no public price).
  if (price == null || price <= 0 || name == null) return null;
  const id = html.match(/data-productid="(\d+)"/)?.[1];
  const img =
    html.match(/property="og:image"[^>]+content="([^"]+)"/)?.[1] ??
    html.match(/class="picture"[\s\S]{0,200}?<img[^>]+src="([^"]+)"/)?.[1] ??
    null;
  const oos = /(?:нема на залиха|out of stock|sold out)/i.test(html);
  const code = name.match(/\b([A-Za-z]*\d[A-Za-z0-9.-]{2,})\b/)?.[1] ?? null;

  return {
    externalId: id ?? url.split("/").filter(Boolean).pop() ?? url,
    name,
    brand: null,
    modelRef: code?.toUpperCase() ?? null,
    category: null,
    gender: normalizeGender(name),
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
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Hronometar (nopCommerce) collector. The catalog is JS/lazy-loaded with no
 * sitemap or JSON-LD, so enumerate every URL via FireCrawl map, then fetch and
 * keep only real product pages (parsed from nopCommerce markup).
 */
export const hronometarCollector: ProductCollector = {
  id: "hronometar-nopcommerce",
  label: "Hronometar nopCommerce",
  appliesTo: (t) => t.id === "hronometar" && !!t.web.url,
  async collect({ target }: CollectorContext): Promise<ProductObservation[]> {
    const base = new URL(target.web.url ?? "").origin;
    const candidates = (await fcMapAll(base, new URL(base).host)).slice(0, MAX * 2);
    const parsed = await mapPool(candidates, CONCURRENCY, async (url) => {
      try {
        return parseNop(await fetchText(url), url);
      } catch {
        return null;
      }
    });
    return parsed.filter((o): o is ProductObservation => o !== null).slice(0, MAX);
  },
};
