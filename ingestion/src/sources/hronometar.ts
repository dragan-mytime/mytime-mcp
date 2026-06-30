import { optionalEnv, type ProductObservation } from "@mytime/shared";
import {
  cleanText,
  deriveDiscount,
  normalizeGender,
  normalizeType,
  parseModelRef,
} from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const UA = "MyTimeBI/1.0 (+https://mcp.mytimeprime.mk)";
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

const decodeEntities = (h: string): string =>
  h
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(Number.parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)));

/**
 * Read a nopCommerce spec-table value by its (decoded) label. The table has
 * entity-encoded Cyrillic labels and unclosed cells:
 *   <td class=spec-name>Пол<td class=spec-value>Машки<tr…>
 */
export function specValue(html: string, label: string): string | null {
  const m = decodeEntities(html).match(
    new RegExp(`spec-name>\\s*${label}\\s*<td[^>]*>([^<]+)`, "i"),
  );
  return cleanText(m?.[1] ?? null);
}

/** Parse a nopCommerce product page; returns null for non-product pages (categories). */
export function parseNop(html: string, url: string): ProductObservation | null {
  if (!/product-details-form/.test(html)) return null; // product-page marker
  const name = cleanText(html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]);
  const priceRaw = html.match(/(?:actual-price|price-value-\d+)[^>]*>\s*([0-9.,]+)/)?.[1];
  const currentPrice = priceRaw ? parseEuPrice(priceRaw) : null;
  // Skip price-on-request items (nopCommerce renders "0,00" when no public price).
  if (currentPrice == null || currentPrice <= 0 || name == null) return null;

  // Parse the struck old price from nopCommerce sale markup.
  const oldPriceRaw = html.match(/old-product-price[\s\S]*?([0-9][0-9.,]*)\s*MKD/i)?.[1];
  const oldPrice = oldPriceRaw ? parseEuPrice(oldPriceRaw) : null;

  // When an old (struck) price exists and is higher, it is the regular price.
  const price = oldPrice != null && oldPrice > currentPrice ? oldPrice : currentPrice;
  const saleCandidate = oldPrice != null && oldPrice > currentPrice ? currentPrice : null;

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
    modelRef: parseModelRef(name, code, null),
    category: null,
    productType: normalizeType(null, name, "watches"),
    gender: normalizeGender(specValue(html, "Пол")) ?? normalizeGender(name),
    collection: specValue(html, "Колекција"),
    attributes: null,
    url,
    imageUrl: cleanText(img),
    currency: "MKD",
    price,
    ...deriveDiscount(price, saleCandidate),
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
