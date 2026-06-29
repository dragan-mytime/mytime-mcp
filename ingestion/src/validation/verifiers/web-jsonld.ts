import type { LiveSnapshot } from "../types.js";
import type { SiteVerifier } from "./_verifier.js";

/**
 * Strip all HTML tags and return inner text, then trim.
 */
function innerText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Parse a Macedonian-formatted price string to a number.
 * "6.400 ден." → 6400, "11.290 ден." → 11290
 * The dot is a thousands separator (no decimals on MKD prices).
 * We just strip everything that isn't a digit.
 */
function parseMkdPrice(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const webJsonLdVerifier: SiteVerifier = {
  targets: ["saat-saat", "swarovski"],

  extract(html: string, _markdown: string, _url: string): LiveSnapshot {
    try {
      // ── 1. Product name from <h1> ────────────────────────────────────────
      let name: string | null = null;
      {
        const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
        if (m?.[1]) name = innerText(m[1]) || null;
      }

      // ── 2. Carve out the main product block (before Related Products) ────
      const relatedIdx = html.search(/Related\s+Products|Слични|Similar|Препорач/i);
      const mainBlock = relatedIdx > 0 ? html.slice(0, relatedIdx) : html;

      // ── 3. Look for a struck-through original price in the main block ────
      //  On-sale markup: <span class="text-lg text-gray-400 line-through">8.000 ден.</span>
      let struckPrice: number | null = null;
      {
        const m = mainBlock.match(
          /<span[^>]*class="[^"]*line-through[^"]*"[^>]*>([\s\S]*?)<\/span>/,
        );
        if (m?.[1]) struckPrice = parseMkdPrice(innerText(m[1]));
      }

      // ── 4. Current displayed price (text-3xl) ───────────────────────────
      //  On sale:   <span class="text-3xl font-bold text-[#e63946]">6.400 ден.</span>
      //  Not on sale: <span class="text-3xl font-bold text-gray-900">11.290 ден.</span>
      let currentPrice: number | null = null;
      {
        const m = mainBlock.match(
          /<span[^>]*class="[^"]*text-3xl[^"]*font-bold[^"]*"[^>]*>([\s\S]*?)<\/span>/,
        );
        if (m?.[1]) currentPrice = parseMkdPrice(innerText(m[1]));
      }

      // ── 5. Assemble snapshot ─────────────────────────────────────────────
      // When on sale: price = struck original, salePrice = current (red) price.
      // When not on sale: price = current price, salePrice = null.
      const price = struckPrice !== null ? struckPrice : currentPrice;
      const salePrice = struckPrice !== null ? currentPrice : null;

      return { name, price, salePrice };
    } catch {
      return { name: null, price: null, salePrice: null };
    }
  },
};
