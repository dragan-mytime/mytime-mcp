import type { ProductObservation } from "@mytime/shared";
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

/**
 * Parse WooCommerce sale price from a rendered product page HTML.
 *
 * WooCommerce price markup for on-sale products:
 *   <p class="price ..."><del>...<bdi>12.690 ден</bdi>...</del> <ins>...<bdi>6.345 ден</bdi>...</ins></p>
 *
 * MKD numbers use "." as a thousands separator (12.690 = 12690, no decimals).
 * Strips all non-digit characters to parse.
 *
 * Returns { regular, sale } where:
 *   - regular = amount inside <del>...<bdi>...</bdi>...</del>
 *   - sale    = amount inside <ins>...<bdi>...</bdi>...</ins>
 *   - If no <del>/<ins> pair, returns { regular: <single amount or null>, sale: null }
 */
export function parseWooSalePrice(html: string): {
  regular: number | null;
  sale: number | null;
} {
  try {
    // Find the first <p> with "price" in its class attribute (non-greedy body)
    const pBlock = html.match(/<p\b[^>]*class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (!pBlock) return { regular: null, sale: null };
    const block = pBlock[1] ?? "";

    // Helper: extract first <bdi> text content from a substring, strip non-digits
    const parseBdi = (s: string): number | null => {
      const m = s.match(/<bdi[^>]*>([\s\S]*?)<\/bdi>/);
      if (!m) return null;
      // Remove HTML tags, then strip non-digit characters (dots are thousands separators)
      const digits = (m[1] ?? "").replace(/<[^>]+>/g, "").replace(/\D/g, "");
      if (!digits) return null;
      return Number(digits);
    };

    // Try del (regular) + ins (sale)
    const delMatch = block.match(/<del\b[^>]*>([\s\S]*?)<\/del>/);
    const insMatch = block.match(/<ins\b[^>]*>([\s\S]*?)<\/ins>/);

    if (delMatch && insMatch) {
      const regular = parseBdi(delMatch[1] ?? "");
      const sale = parseBdi(insMatch[1] ?? "");
      return { regular, sale };
    }

    // No del/ins — single price
    const single = parseBdi(block);
    return { regular: single, sale: null };
  } catch {
    return { regular: null, sale: null };
  }
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

    // Phase 1: page through the Store API and build observations synchronously
    const rawProducts: WcProduct[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${base}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${target.id} WC API HTTP ${res.status} (page ${page})`);
      const list = (await res.json()) as WcProduct[];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const p of list) rawProducts.push(p);
      if (list.length < PER_PAGE) break;
    }

    const out: ProductObservation[] = rawProducts.map(mapProduct);

    // Phase 2: enrich on-sale products by scraping their permalink for real prices.
    // The Store API incorrectly reports sale_price == regular_price for on-sale items.
    for (let i = 0; i < rawProducts.length; i++) {
      const p = rawProducts[i];
      const obs = out[i];
      if (!p || !obs || !p.on_sale || !p.permalink) continue;
      try {
        const pageRes = await fetch(p.permalink, {
          headers: { "User-Agent": BROWSER_UA },
          signal: AbortSignal.timeout(30_000),
        });
        if (!pageRes.ok) continue;
        const html = await pageRes.text();
        const { regular, sale } = parseWooSalePrice(html);
        // Only override if we got a genuine discount from the page
        if (regular != null && sale != null && sale < regular) {
          const discount = deriveDiscount(regular, sale);
          obs.price = regular;
          obs.salePrice = discount.salePrice;
          obs.discountAmount = discount.discountAmount;
          obs.discountPct = discount.discountPct;
        }
      } catch {
        // One page failure must not abort the whole run — skip silently
      }
    }

    return out;
  },
};
