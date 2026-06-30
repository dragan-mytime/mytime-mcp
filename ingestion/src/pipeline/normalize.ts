// Pure normalization helpers shared by collectors. No I/O, no DB.

export function cleanText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length ? s : null;
}

/** Brand kept as-is (trimmed); aggregation is case-insensitive at query time. */
export function normalizeBrand(v: unknown): string | null {
  return cleanText(v);
}

/** Map site-specific gender labels (MK/EN) to a canonical token. */
export function normalizeGender(v: unknown): string | null {
  const s = (cleanText(v) ?? "").toLowerCase();
  if (!s) return null;
  if (/(маш|mašk|mask|machk|\bmen\b|муж)/.test(s)) return "mens";
  if (/(жен|žen|\bzen|women|\bwom)/.test(s)) return "womens";
  if (/(уни|unisex)/.test(s)) return "unisex";
  if (/(дет|деца|kid|child)/.test(s)) return "kids";
  return null;
}

/** Best-effort manufacturer reference from a product name (leading code token). */
export function parseModelFromName(name: string | null): string | null {
  if (!name) return null;
  const m = name.trim().match(/^([A-Za-z]{0,4}[0-9][A-Za-z0-9.\-/]{2,})/);
  return m?.[1] ? m[1].toUpperCase() : null;
}

export function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Parse a percent value like "40%" → 40. */
export function parsePercent(v: unknown): number {
  const n = Number(
    String(v ?? "")
      .replace("%", "")
      .trim(),
  );
  return Number.isFinite(n) ? n : 0;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export type ProductType = "watches" | "jewelry" | "accessories" | "eyewear" | "other";

/**
 * Coarse, cross-vendor product type from a raw vendor category + product name,
 * with an optional per-vendor fallback (monobrands: Pandora/Zia/Swarovski →
 * "jewelry", Hronometar → "watches"). Eyewear is matched first so a watch
 * store's "очила" never lands in watches. Returns null only when there is no
 * text and no fallback, keeping "other" meaningful.
 */
export function normalizeType(
  category: string | null,
  name: string | null,
  fallback: ProductType | null = null,
): ProductType | null {
  const s = `${category ?? ""} ${name ?? ""}`.toLowerCase().trim();
  if (!s) return fallback;
  if (/(очил|наочар|eyewear|sunglass|glasses)/.test(s)) return "eyewear";
  if (/(часовниц|часовник|\bwatch|saat|zegar)/.test(s)) return "watches";
  if (
    /(накит|jewel|прстен|обетк|ѓердан|гердан|огрлиц|белегз|нараквиц|приврзок|привезоц|привез|синџир|ланч|алк[аи]|алка|чокер|choker|bracelet|necklace|earring|\bring\b|pendant|charm)/.test(
      s,
    )
  )
    return "jewelry";
  if (
    /(додатоц|ремч|ремен|каиш|strap|манжет|cufflink|новчаник|wallet|чанта|\bbag\b|футрол)/.test(s)
  )
    return "accessories";
  return fallback ?? "other";
}

/**
 * Derive the discount fields from a regular and (optional) sale price.
 * Returns nulls when there is no genuine discount (legacy stored 0 here).
 */
export function deriveDiscount(
  regular: number,
  sale: number | null | undefined,
): { salePrice: number | null; discountAmount: number | null; discountPct: number | null } {
  if (sale == null || !(sale < regular) || regular <= 0) {
    return { salePrice: null, discountAmount: null, discountPct: null };
  }
  return {
    salePrice: sale,
    discountAmount: round2(regular - sale),
    discountPct: round2(((regular - sale) / regular) * 100),
  };
}
