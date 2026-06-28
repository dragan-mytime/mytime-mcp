import type { ProductObservation } from "@mytime/shared";
import {
  cleanText,
  deriveDiscount,
  normalizeBrand,
  normalizeGender,
} from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const UA = "MyTimeBI/1.0 (+https://mcp.mytimeprime.mk)";
const PER_PAGE = 100;
const MAX_PAGES = 100; // safety cap

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
 */
export const woocommerceCollector: ProductCollector = {
  id: "woocommerce-store-api",
  label: "WooCommerce Store API",
  appliesTo: (t) => t.web.platform === "woocommerce" && !!t.web.url,
  async collect({ target }: CollectorContext): Promise<ProductObservation[]> {
    const base = new URL(target.web.url ?? "").origin;
    const out: ProductObservation[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${base}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${target.id} WC API HTTP ${res.status} (page ${page})`);
      const list = (await res.json()) as WcProduct[];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const p of list) out.push(mapProduct(p));
      if (list.length < PER_PAGE) break;
    }
    return out;
  },
};
