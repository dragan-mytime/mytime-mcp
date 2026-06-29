import { parseWooSalePrice } from "../../sources/woocommerce.js";
import type { LiveSnapshot } from "../types.js";
import type { SiteVerifier } from "./_verifier.js";

export const woocommerceVerifier: SiteVerifier = {
  targets: ["b-watch", "bozinovski", "watch-club"],
  extract(html: string): LiveSnapshot {
    const { regular, sale } = parseWooSalePrice(html);
    const name =
      html
        .match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>(.*?)<\/h1>/is)?.[1]
        ?.replace(/<[^>]+>/g, "")
        .trim() ?? null;
    const onSale = regular != null && sale != null && sale < regular;
    return { name, price: regular, salePrice: onSale ? sale : null };
  },
};
