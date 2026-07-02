import { type ProductObservation, requireEnv } from "@mytime/shared";
import { XMLParser } from "fast-xml-parser";
import {
  cleanText,
  deriveDiscount,
  normalizeBrand,
  normalizeType,
  parseModelRef,
  parsePercent,
  toNumber,
} from "../pipeline/normalize.js";
import type { CollectorContext, ProductCollector } from "./_collector.js";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: true,
});

interface FeedItem {
  ID?: string;
  name?: string;
  link?: string;
  mainImage?: string;
  price?: string;
  regularPrice?: string;
  discount?: string;
  stock?: string;
  fileUnder?: string;
  brand?: string;
  attributes?: { attribute?: FeedAttr | FeedAttr[] };
}
interface FeedAttr {
  name?: string;
  values?: { value?: string | string[] };
}

function parseAttributes(node: FeedItem["attributes"]): Record<string, string[]> | null {
  const a = node?.attribute;
  if (!a) return null;
  const arr = Array.isArray(a) ? a : [a];
  const out: Record<string, string[]> = {};
  for (const it of arr) {
    const name = cleanText(it?.name);
    if (!name) continue;
    const v = it?.values?.value;
    out[name] = v == null ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x));
  }
  return Object.keys(out).length ? out : null;
}

function mapItem(it: FeedItem): ProductObservation {
  const name = cleanText(it.name) ?? String(it.ID ?? "");
  const regular = toNumber(it.regularPrice) ?? toNumber(it.price) ?? 0;
  const current = toNumber(it.price);
  const pct = parsePercent(it.discount);
  // Use the discounted price only when the feed signals a real discount.
  const discount = pct > 0 ? deriveDiscount(regular, current) : deriveDiscount(regular, null);
  const stock = (cleanText(it.stock) ?? "").toLowerCase();

  return {
    externalId: String(it.ID ?? name),
    name,
    brand: normalizeBrand(it.brand),
    modelRef: parseModelRef(name, null, null)?.ref ?? null,
    category: cleanText(it.fileUnder),
    productType: normalizeType(cleanText(it.fileUnder), name),
    gender: null,
    collection: null,
    attributes: parseAttributes(it.attributes),
    url: cleanText(it.link),
    imageUrl: cleanText(it.mainImage),
    currency: "MKD",
    price: regular,
    ...discount,
    // The feed only lists available products; absence next run = sold out / removed.
    stockStatus: stock === "available" ? "in_stock" : stock ? "out_of_stock" : "unknown",
    stockQuantity: null,
    qtyBasis: "assumed", // own-brand feed exposes availability, not a count
    locationsCount: 0,
    inStockLocations: null,
  };
}

/** MY:TIME own-brand collector — the Adform XML product feed. */
export const mytimeFeedCollector: ProductCollector = {
  id: "mytime-xml-feed",
  label: "MY:TIME Adform XML feed",
  appliesTo: (t) => t.is_self && t.web.platform === "xml_feed",
  async collect(_ctx: CollectorContext): Promise<ProductObservation[]> {
    const res = await fetch(requireEnv("MYTIME_FEED_URL"), {
      headers: { "User-Agent": "MyTimeBI/1.0 (+https://mcp.mytimeprime.mk)" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`MY:TIME feed HTTP ${res.status}`);
    const data = parser.parse(await res.text()) as { CNJExport?: { Item?: FeedItem | FeedItem[] } };
    const items = data?.CNJExport?.Item ?? [];
    return (Array.isArray(items) ? items : [items]).map(mapItem);
  },
};
