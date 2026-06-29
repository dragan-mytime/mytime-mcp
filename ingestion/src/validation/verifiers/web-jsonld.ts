import type { LiveSnapshot } from "../types.js";
import type { SiteVerifier } from "./_verifier.js";

/**
 * Parse a price string to a number.
 * Handles both "ден" (MKD) and "€" (EUR) suffixes, thousands separators (. or ,),
 * and various non-ASCII encodings around the currency symbol.
 * Returns null if no numeric value can be extracted.
 */
function parsePrice(raw: string): number | null {
  // Strip everything that isn't a digit, period, or comma
  const digits = raw.replace(/[^\d.,]/g, "");
  if (!digits) return null;

  // Determine thousands vs decimal separator.
  // If the string has both "." and "," the rightmost one is the decimal separator.
  // If only one separator type exists, treat it as a decimal only when it appears
  // once and the fractional part has exactly 1 or 2 digits; otherwise it's thousands.
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");

  let normalised: string;
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastDot > lastComma) {
      // 1,234.56 style
      normalised = digits.replace(/,/g, "");
    } else {
      // 1.234,56 style
      normalised = digits.replace(/\./g, "").replace(",", ".");
    }
  } else if (lastComma !== -1) {
    const afterComma = digits.slice(lastComma + 1);
    if (afterComma.length <= 2 && digits.indexOf(",") === lastComma) {
      // treat as decimal separator: "279,00"
      normalised = digits.replace(",", ".");
    } else {
      // thousands separator: "17,990"
      normalised = digits.replace(/,/g, "");
    }
  } else if (lastDot !== -1) {
    const afterDot = digits.slice(lastDot + 1);
    if (afterDot.length <= 2 && digits.indexOf(".") === lastDot) {
      // treat as decimal: "279.00"
      normalised = digits;
    } else {
      // thousands separator: "17.990"
      normalised = digits.replace(/\./g, "");
    }
  } else {
    normalised = digits;
  }

  const n = Number.parseFloat(normalised);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract text content from the first element matching a regex against raw HTML.
 * Returns the inner text (HTML entities decoded minimally) or null.
 */
function extractText(html: string, classPattern: RegExp): string | null {
  const match = html.match(classPattern);
  if (!match) return null;
  const inner = match[1] ?? null;
  if (inner === null) return null;
  return inner
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export const webJsonLdVerifier: SiteVerifier = {
  targets: ["saat-saat", "swarovski"],

  extract(html: string, _markdown: string, _url: string): LiveSnapshot {
    // ── 1. Product name from <h1> ──────────────────────────────────────────
    let name: string | null = null;
    {
      // Match the <h1> that contains "font-bold text-gray-900" (the main product h1)
      const h1Match = html.match(
        /<h1[^>]*class="[^"]*font-bold[^"]*text-gray-900[^"]*"[^>]*>([\s\S]*?)<\/h1>/,
      );
      if (h1Match) {
        name = extractText(
          html,
          /<h1[^>]*class="[^"]*font-bold[^"]*text-gray-900[^"]*"[^>]*>([\s\S]*?)<\/h1>/,
        );
      }
    }

    // ── 2. Main product price ──────────────────────────────────────────────
    // The main price sits in: <span class="text-3xl font-bold text-gray-900">279 €</span>
    // Related-product prices use text-sm — we target text-3xl to avoid them.
    let price: number | null = null;
    let salePrice: number | null = null;

    {
      // Look for text-3xl price first (regular price on non-sale product OR original price on sale)
      const mainPriceMatch = html.match(
        /<span[^>]*class="[^"]*text-3xl[^"]*font-bold[^"]*text-gray-900[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      );

      if (mainPriceMatch) {
        const raw = (mainPriceMatch[1] ?? "").replace(/<[^>]+>/g, "").trim();
        price = parsePrice(raw);
      }

      // Check for a sale scenario: look for a struck-through original (line-through) AND
      // a red sale price (text-red-600) that appear BEFORE the Related Products section.
      // We carve out just the main product block to avoid carousel contamination.
      const relatedIdx = html.indexOf("Related Products");
      const mainBlock = relatedIdx > 0 ? html.slice(0, relatedIdx) : html;

      // Struck-through original price: class containing "line-through" (not text-sm)
      // We check for the larger variant: text-gray-400 ... line-through without text-sm
      const struckMatch = mainBlock.match(
        /<span[^>]*class="[^"]*text-gray-400[^"]*line-through[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      );

      if (struckMatch) {
        // There's a struck-through price — the main product is on sale.
        // The struck price is the original; the red price is the sale price.
        const struckRaw = (struckMatch[1] ?? "").replace(/<[^>]+>/g, "").trim();
        const struckPrice = parsePrice(struckRaw);

        // Red sale price: text-red-600 font-bold (bigger than text-sm carousel)
        const redMatch = mainBlock.match(
          /<span[^>]*class="[^"]*text-red-600[^"]*font-bold[^"]*"[^>]*>([\s\S]*?)<\/span>/,
        );
        const redPrice = redMatch
          ? parsePrice((redMatch[1] ?? "").replace(/<[^>]+>/g, "").trim())
          : null;

        if (struckPrice !== null && redPrice !== null) {
          price = struckPrice;
          salePrice = redPrice;
        } else if (struckPrice !== null) {
          price = struckPrice;
          salePrice = null;
        }
        // If for some reason text-3xl was already set but we found a struck price,
        // prefer the struck/red pair (more reliable on sale pages).
      }
    }

    return {
      name: name ?? null,
      price: price ?? null,
      salePrice: salePrice ?? null,
    };
  },
};
