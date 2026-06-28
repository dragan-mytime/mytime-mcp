import { optionalEnv, type ProductObservation } from "@mytime/shared";
import {
  cleanText,
  deriveDiscount,
  normalizeBrand,
  normalizeGender,
  parseModelFromName,
  toNumber,
} from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const UA = "MyTimeBI/1.0 (+https://mcp.mytimeprime.mk)";
const CONCURRENCY = 6;

/**
 * Per-site config for SSR storefronts whose pages carry schema.org JSON-LD.
 * Enumeration is via the site's sitemap (free); product data is parsed
 * deterministically from JSON-LD (accurate, unlike LLM extraction). FireCrawl
 * is the rendering fallback (see fetchHtml) for anything not in the raw HTML.
 */
interface SiteConfig {
  /** Product-URL enumeration source: a sitemap, or FireCrawl map (renders JS grids). */
  sitemap?: string;
  firecrawlMap?: boolean;
  /** Matches product (not category) URLs. */
  productUrl: RegExp;
}
const SITES: Record<string, SiteConfig> = {
  "saat-saat": { sitemap: "https://saatandsaat.mk/sitemap.xml", productUrl: /\/product\// },
  swarovski: { firecrawlMap: true, productUrl: /\/p\/\d+\// }, // royalhouse.mk — JS grid + OG pages
  // Remaining: hronometar (nopCommerce) + pandora (Magento) need category-listing
  // crawls; with no SITES entry they degrade to 0 rows until added.
};

const MAX = Number(optionalEnv("WEB_MAX_PRODUCTS", "300"));

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** FireCrawl fallback: fetch rendered raw HTML for JS-gated pages. */
async function fetchHtml(url: string): Promise<string> {
  try {
    return await fetchText(url);
  } catch (err) {
    const key = optionalEnv("FIRECRAWL_API_KEY");
    if (!key) throw err;
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json()) as { data?: { rawHtml?: string } };
    if (!j.data?.rawHtml) throw err;
    return j.data.rawHtml;
  }
}

/** Recursively expand a sitemap (handles sitemap-index) and return matching URLs. */
async function collectSitemapUrls(sitemap: string, match: RegExp, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const xml = await fetchText(sitemap);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1] as string);
  const sub = locs.filter((l) => /sitemap.*\.xml/i.test(l) && l !== sitemap);
  if (sub.length && !locs.some((l) => match.test(l))) {
    const nested = await Promise.all(
      sub.slice(0, 20).map((s) => collectSitemapUrls(s, match, depth + 1)),
    );
    return nested.flat();
  }
  return locs.filter((l) => match.test(l));
}

/** Enumerate product URLs via FireCrawl map (renders JS) — for JS-grid sites. */
async function fcMap(siteUrl: string, match: RegExp): Promise<string[]> {
  const key = optionalEnv("FIRECRAWL_API_KEY");
  if (!key) throw new Error("FIRECRAWL_API_KEY required for map enumeration");
  const res = await fetch("https://api.firecrawl.dev/v2/map", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: siteUrl, limit: 5000 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`FireCrawl map HTTP ${res.status}`);
  const j = (await res.json()) as { links?: (string | { url?: string })[] };
  const urls = (j.links ?? []).map((l) => (typeof l === "string" ? l : (l.url ?? "")));
  return [...new Set(urls.filter((u) => match.test(u)))];
}

interface JsonLd {
  "@type"?: string | string[];
  name?: string;
  sku?: string;
  mpn?: string;
  brand?: string | { name?: string };
  category?: string;
  image?: string | string[];
  offers?: Offer | Offer[];
}
interface Offer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
}

function jsonLdBlocks(html: string): JsonLd[] {
  const out: JsonLd[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse((m[1] as string).trim());
      const graph = parsed["@graph"];
      for (const node of Array.isArray(parsed) ? parsed : graph ? graph : [parsed]) {
        out.push(node as JsonLd);
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return out;
}

const isProduct = (n: JsonLd): boolean => {
  const t = n["@type"];
  return Array.isArray(t) ? t.includes("Product") : t === "Product";
};

function parseProduct(html: string, url: string): ProductObservation | null {
  const node = jsonLdBlocks(html).find(isProduct);
  if (!node) return null;
  const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  const price = toNumber(offer?.price);
  if (price == null) return null;

  const name = cleanText(node.name);
  const brand = normalizeBrand(typeof node.brand === "string" ? node.brand : node.brand?.name);
  const avail = (offer?.availability ?? "").toLowerCase();
  // Exact count when the page renders "N in stock" (e.g. Saat&Saat).
  const qtyMatch = html.match(/([0-9]+)\s+in stock/i);
  const stockQuantity = qtyMatch?.[1] ? Number(qtyMatch[1]) : null;
  const inStock = avail.includes("instock") || stockQuantity != null;
  const sku = cleanText(node.sku) ?? cleanText(node.mpn);
  // Prefer a manufacturer-style code from the name when the sku is purely numeric.
  const nameCode = name?.match(/\b([A-Za-z]{2,}-?[A-Za-z0-9]*\d[A-Za-z0-9-]*)\b/)?.[1] ?? null;
  const modelRef =
    sku && !/^\d+$/.test(sku)
      ? sku.toUpperCase()
      : (nameCode?.toUpperCase() ?? sku ?? parseModelFromName(name));

  return {
    externalId: sku ?? url.split("/").filter(Boolean).pop() ?? url,
    name: name ?? url,
    brand,
    modelRef,
    category: cleanText(node.category),
    gender: normalizeGender(node.category) ?? normalizeGender(name),
    collection: null,
    attributes: null,
    url,
    imageUrl: cleanText(Array.isArray(node.image) ? node.image[0] : node.image),
    currency: "MKD",
    price,
    ...deriveDiscount(price, null),
    stockStatus: inStock ? "in_stock" : "out_of_stock",
    stockQuantity,
    qtyBasis: stockQuantity != null ? "exact" : "assumed",
    locationsCount: 0,
    inStockLocations: null,
  };
}

/** Read an OpenGraph/meta `content` for a given property/name. */
function metaContent(html: string, prop: string): string | null {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m =
    html.match(
      new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, "i"),
    ) ??
    html.match(
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, "i"),
    );
  return m?.[1] ? m[1].trim() : null;
}

/** Fallback parser for OpenGraph product pages (e.g. Royal House / Swarovski). */
function parseOg(html: string, url: string): ProductObservation | null {
  const price = toNumber(
    metaContent(html, "product:price:amount") ?? metaContent(html, "og:price:amount"),
  );
  if (price == null) return null;
  // Strip an OG-title site suffix like " :: Royal House" / " | Site".
  const name = cleanText(
    metaContent(html, "og:title")?.replace(/\s*(?:::|\|)\s*[^:|]*$/, "") ?? null,
  );
  const avail = (
    metaContent(html, "product:availability") ??
    metaContent(html, "og:availability") ??
    ""
  ).toLowerCase();
  const nameCode = name?.match(/\b([A-Za-z]{2,}-?[A-Za-z0-9]*\d[A-Za-z0-9-]*)\b/)?.[1] ?? null;
  const idMatch = url.match(/\/p\/(\d+)/);

  return {
    externalId: idMatch?.[1] ?? url.split("/").filter(Boolean).pop() ?? url,
    name: name ?? url,
    brand: normalizeBrand(metaContent(html, "product:brand") ?? metaContent(html, "og:brand")),
    modelRef: nameCode?.toUpperCase() ?? parseModelFromName(name),
    category: null,
    gender: normalizeGender(name),
    collection: null,
    attributes: null,
    url,
    imageUrl: cleanText(metaContent(html, "og:image")),
    currency: metaContent(html, "product:price:currency") ?? "MKD",
    price,
    ...deriveDiscount(price, toNumber(metaContent(html, "product:sale_price:amount"))),
    stockStatus: avail.replace(/\s/g, "").includes("instock")
      ? "in_stock"
      : avail
        ? "out_of_stock"
        : "in_stock",
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
 * FireCrawl-assigned web collector for SSR storefronts (Saat&Saat, Swarovski,
 * Hronometar). Enumerates via sitemap, parses JSON-LD per product. Capped by
 * WEB_MAX_PRODUCTS per run.
 */
export const webJsonLdCollector: ProductCollector = {
  id: "web-jsonld",
  label: "Web JSON-LD (FireCrawl-assigned sites)",
  appliesTo: (t) => t.web.platform != null && t.id in SITES,
  async collect({ target }: CollectorContext): Promise<ProductObservation[]> {
    const cfg = SITES[target.id];
    if (!cfg) return [];
    const base = new URL(target.web.url ?? "").origin;
    const enumerated = cfg.firecrawlMap
      ? await fcMap(base, cfg.productUrl)
      : cfg.sitemap
        ? await collectSitemapUrls(cfg.sitemap, cfg.productUrl)
        : [];
    const urls = enumerated.slice(0, MAX);
    const results = await mapPool(urls, CONCURRENCY, async (url) => {
      try {
        const html = await fetchHtml(url);
        return parseProduct(html, url) ?? parseOg(html, url);
      } catch {
        return null;
      }
    });
    return results.filter((o): o is ProductObservation => o !== null);
  },
};
