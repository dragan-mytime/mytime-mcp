import { optionalEnv, type ProductObservation } from "@mytime/shared";
import {
  cleanText,
  deriveDiscount,
  normalizeBrand,
  normalizeGender,
} from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const UA = "MyTimeBI/1.0 (+https://mcp.mytimeprime.mk)";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PER_PAGE = 100;
const MAX_PAGES = 100; // safety cap
const ENRICH_CONCURRENCY = 8; // parallel product-page fetches for on-sale enrichment

/**
 * WooCommerce sites whose origin is behind a Cloudflare JS challenge (the whole site
 * 403s a plain fetch with a "Just a moment…" page). Their Store API + pages are fetched
 * through Firecrawl, which renders the challenge in a real browser and returns the body.
 */
const CLOUDFLARE_SITES = new Set<string>(["watch-club"]);

/** Scrape a URL's raw body via Firecrawl (passes Cloudflare's JS challenge). */
async function firecrawlText(url: string): Promise<string> {
  const key = optionalEnv("FIRECRAWL_API_KEY");
  if (!key) throw new Error("FIRECRAWL_API_KEY required for a Cloudflare-protected site");
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = (await res.json()) as { success?: boolean; data?: { rawHtml?: string } };
  if (!j.success || !j.data?.rawHtml) throw new Error(`Firecrawl scrape failed for ${url}`);
  return j.data.rawHtml;
}

/** Fetch a URL's text either directly or, for Cloudflare-protected sites, via Firecrawl. */
async function wooFetchText(url: string, viaFirecrawl: boolean, ua: string): Promise<string> {
  if (viaFirecrawl) return firecrawlText(url);
  const res = await fetch(url, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * First monetary amount in an HTML fragment: the leading digit run that follows a
 * `woocommerce-Price-amount` span or a `<bdi>` (the price), excluding the currency
 * symbol that follows. The "ден" symbol may render as text ("денари") or hex entities
 * (`&#x434;…`) whose digits must NOT be parsed. MKD uses "." as a thousands separator
 * (12.690 = 12690), so all non-digit characters are stripped from the captured run.
 */
function priceAmount(fragment: string): number | null {
  const m = fragment.match(/(?:woocommerce-Price-amount[^>]*>|<bdi[^>]*>)\s*([\d.,]+)/i);
  if (!m) return null;
  const digits = (m[1] ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/**
 * Markup-agnostic sale extraction from a price fragment:
 *   - regular = the amount inside `<del>…</del>`
 *   - sale    = the first amount AFTER `</del>` (covers `<ins>`, `<bdi>`, or a plain
 *               `<span class="woocommerce-Price-amount">` — Bozinovski's catalog-sale form)
 *   - no `<del>` → single price as `regular`, `sale: null`
 */
function extractSale(fragment: string): { regular: number | null; sale: number | null } {
  const del = fragment.match(/<del\b[^>]*>([\s\S]*?)<\/del>/i);
  if (del && del.index != null) {
    const regular = priceAmount(del[1] ?? "");
    const sale = priceAmount(fragment.slice(del.index + del[0].length));
    return { regular, sale };
  }
  return { regular: priceAmount(fragment), sale: null };
}

/**
 * Parse the sale price from a rendered WooCommerce **product page** — extracts the
 * `<p class="price">` block and reads it markup-agnostically (handles both B-Watch's
 * `<del><bdi>/<ins><bdi>` and Bozinovski's `<del><span>…</span></del> <span>` forms).
 */
export function parseWooSalePrice(html: string): { regular: number | null; sale: number | null } {
  try {
    const block = html.match(/<p\b[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (!block) return { regular: null, sale: null };
    return extractSale(block[1] ?? "");
  } catch {
    return { regular: null, sale: null };
  }
}

/**
 * Parse WooCommerce shop/category **listing** tiles → `{ permalink, regular, sale }` per
 * product. Each `<li class="product …">` carries the product link plus the same
 * `get_price_html()` markup as the product page. Used to detect catalog sales the Store
 * API hides (e.g. Bozinovski's Evergreen 30% promo).
 */
export function parseListingTiles(
  html: string,
): { permalink: string; regular: number | null; sale: number | null }[] {
  const out: { permalink: string; regular: number | null; sale: number | null }[] = [];
  const tiles = html.match(/<li\b[^>]*class="[^"]*\bproduct\b[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  for (const tile of tiles) {
    const href = tile.match(/<a\b[^>]*href="([^"]+)"/i)?.[1];
    if (!href) continue;
    const priceIdx = tile.search(/<(?:span|p)\b[^>]*class="[^"]*\bprice\b[^"]*"/i);
    const frag = priceIdx >= 0 ? tile.slice(priceIdx) : tile;
    const { regular, sale } = extractSale(frag);
    out.push({ permalink: href, regular, sale });
  }
  return out;
}

interface WcTerm {
  name?: string;
}
interface WcAttr {
  taxonomy?: string;
  name?: string;
  terms?: WcTerm[];
}
interface WcProduct {
  id: number;
  sku?: string;
  slug?: string;
  name: string;
  permalink?: string;
  on_sale?: boolean;
  is_in_stock?: boolean;
  low_stock_remaining?: number | null;
  prices?: {
    regular_price?: string;
    sale_price?: string;
    price?: string;
    currency_code?: string;
    currency_minor_unit?: number;
  };
  images?: { src?: string }[];
  categories?: { name?: string }[];
  attributes?: WcAttr[];
}

/**
 * Sites whose WooCommerce Store API hides catalog/category sales (`on_sale: false`,
 * `regular_price === price`). For these we derive discounts by scraping the rendered
 * `/shop/` listing pages instead of trusting the API flag. Bozinovski runs a 30%
 * Evergreen catalog sale the API doesn't expose. Add a site id here when its API is
 * found to under-report sales.
 */
const LISTING_SALE_SITES = new Set<string>(["bozinovski"]);

const normPermalink = (u: string): string =>
  (u.split(/[?#]/)[0] ?? u).toLowerCase().replace(/\/+$/, "");

/**
 * Build a `permalink → {regular, sale}` map of on-sale products by scraping every
 * `/shop/` listing page (the catalog-sale source of truth when the Store API hides it).
 * Bounded concurrency, per-page timeout, failure-isolated; a page cap guards runaways.
 */
async function scrapeListingSaleMap(
  base: string,
): Promise<Map<string, { regular: number; sale: number }>> {
  const map = new Map<string, { regular: number; sale: number }>();
  const fetchPage = async (n: number): Promise<string | null> => {
    try {
      const res = await fetch(`${base}/shop/page/${n}/`, {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(30_000),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const ingest = (html: string): void => {
    for (const t of parseListingTiles(html)) {
      if (t.regular != null && t.sale != null && t.sale < t.regular) {
        map.set(normPermalink(t.permalink), { regular: t.regular, sale: t.sale });
      }
    }
  };

  const first = await fetchPage(1);
  if (first == null) return map;
  ingest(first);
  const nums = [...first.matchAll(/\/shop\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  const lastPage = Math.min(nums.length ? Math.max(...nums) : 1, 400);

  let cursor = 2;
  const worker = async (): Promise<void> => {
    while (cursor <= lastPage) {
      const html = await fetchPage(cursor++);
      if (html) ingest(html);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, lastPage - 1)) }, worker));
  return map;
}

const termOf = (p: WcProduct, taxonomy: string): string | null => {
  const a = p.attributes?.find((x) => x.taxonomy === taxonomy);
  return cleanText(a?.terms?.[0]?.name);
};

function mapProduct(p: WcProduct): ProductObservation {
  const minor = p.prices?.currency_minor_unit ?? 0;
  const major = (s?: string): number => Number(s ?? "0") / 10 ** minor;
  const regular = major(p.prices?.regular_price);
  const sale = p.on_sale ? major(p.prices?.sale_price) : null;
  const brand = normalizeBrand(termOf(p, "pa_brend"));
  const category =
    cleanText(p.categories?.find((c) => cleanText(c.name) !== brand)?.name) ??
    cleanText(p.categories?.[0]?.name);

  const inStock = p.is_in_stock !== false;
  const low = p.low_stock_remaining ?? null;

  return {
    externalId: String(p.sku || p.id),
    name: cleanText(p.name) ?? String(p.id),
    brand,
    modelRef: p.slug ? p.slug.toUpperCase() : null,
    category,
    gender: normalizeGender(termOf(p, "pa_pol")),
    collection: null,
    attributes: null,
    url: cleanText(p.permalink),
    imageUrl: cleanText(p.images?.[0]?.src),
    currency: p.prices?.currency_code ?? "MKD",
    price: regular,
    ...deriveDiscount(regular, sale),
    stockStatus: inStock ? (low != null ? "low_stock" : "in_stock") : "out_of_stock",
    stockQuantity: low, // exact count only when the store flags low stock
    qtyBasis: low != null ? "exact" : "unknown",
    locationsCount: 0,
    inStockLocations: null,
  };
}

/**
 * WooCommerce collector via the public Store REST API
 * (`/wp-json/wc/store/v1/products`). Serves B-Watch, Bozinovski, Watch Club.
 * One collector handles all Woo targets; it reads the site base from config.
 *
 * The Store API hides real sale prices: `prices.sale_price === prices.regular_price`
 * for on-sale products. We fix this by scraping the product permalink for the
 * standard WooCommerce <del>/<ins> price markup after building the initial list.
 */
export const woocommerceCollector: ProductCollector = {
  id: "woocommerce-store-api",
  label: "WooCommerce Store API",
  appliesTo: (t) => t.web.platform === "woocommerce" && !!t.web.url,
  async collect({ target }: CollectorContext): Promise<ProductObservation[]> {
    const base = new URL(target.web.url ?? "").origin;
    const viaFc = CLOUDFLARE_SITES.has(target.id);

    // Phase 1: page through the Store API and build observations synchronously.
    // Cloudflare-protected sites (viaFc) are routed through Firecrawl.
    const rawProducts: WcProduct[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${base}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;
      let list: WcProduct[];
      try {
        list = JSON.parse(await wooFetchText(url, viaFc, UA)) as WcProduct[];
      } catch (err) {
        throw new Error(`${target.id} WC API failed (page ${page}): ${(err as Error).message}`);
      }
      if (!Array.isArray(list) || list.length === 0) break;
      for (const p of list) rawProducts.push(p);
      if (list.length < PER_PAGE) break;
    }

    const out: ProductObservation[] = rawProducts.map(mapProduct);

    // Phase 2a: for sites whose Store API hides catalog sales (LISTING_SALE_SITES),
    // derive discounts from the rendered /shop/ listing pages and apply by permalink.
    // This replaces the on_sale-gated per-product scrape below (their on_sale is unreliable).
    if (LISTING_SALE_SITES.has(target.id)) {
      const saleMap = await scrapeListingSaleMap(base);
      for (let i = 0; i < rawProducts.length; i++) {
        const p = rawProducts[i];
        const obs = out[i];
        if (!p?.permalink || !obs) continue;
        const hit = saleMap.get(normPermalink(p.permalink));
        if (hit) {
          const d = deriveDiscount(hit.regular, hit.sale);
          obs.price = hit.regular;
          obs.salePrice = d.salePrice;
          obs.discountAmount = d.discountAmount;
          obs.discountPct = d.discountPct;
        }
      }
      return out;
    }

    // Phase 2: enrich on-sale products by scraping their permalink for real prices.
    // The Store API incorrectly reports sale_price == regular_price for on-sale items.
    // Fetched with bounded concurrency — a busy store can have 1000+ on-sale items,
    // and sequential fetching dominates the whole run.
    const onSale: { obs: ProductObservation; permalink: string }[] = [];
    for (let i = 0; i < rawProducts.length; i++) {
      const p = rawProducts[i];
      const obs = out[i];
      if (p?.on_sale && p.permalink && obs) onSale.push({ obs, permalink: p.permalink });
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < onSale.length) {
        const item = onSale[cursor++];
        if (!item) continue;
        try {
          const { regular, sale } = parseWooSalePrice(
            await wooFetchText(item.permalink, viaFc, BROWSER_UA),
          );
          // Only override if we got a genuine discount from the page
          if (regular != null && sale != null && sale < regular) {
            const discount = deriveDiscount(regular, sale);
            item.obs.price = regular;
            item.obs.salePrice = discount.salePrice;
            item.obs.discountAmount = discount.discountAmount;
            item.obs.discountPct = discount.discountPct;
          }
        } catch {
          // One page failure must not abort the whole run — skip silently
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, onSale.length) }, worker));

    return out;
  },
};
