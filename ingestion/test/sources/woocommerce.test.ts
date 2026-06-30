import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseListingTiles, parseWooSalePrice } from "../../src/sources/woocommerce.js";

const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/woocommerce/${f}`, import.meta.url), "utf8");

describe("parseWooSalePrice", () => {
  it("extracts del/ins regular+sale on a B-Watch discounted product (<bdi>, hex currency)", () => {
    const r = parseWooSalePrice(fx("pxw453-04.html"));
    expect(r.regular).toBeCloseTo(12690, 0);
    expect(r.sale).toBeCloseTo(6345, 0);
  });
  it("returns no sale on a full-price product", () => {
    const r = parseWooSalePrice(fx("dk-6-14452-4.html"));
    expect(r.sale ?? null).toBeNull();
  });
  it("extracts a Bozinovski catalog-sale price (<del><span> markup, no <ins>/<bdi>)", () => {
    const r = parseWooSalePrice(fx("bozinovski-evergreen.html"));
    expect(r.regular).toBeCloseTo(11900, 0);
    expect(r.sale).toBeCloseTo(8330, 0);
  });
  it("returns {null,null} when there is no price block", () => {
    const r = parseWooSalePrice("<html><body>no price here</body></html>");
    expect(r.regular).toBeNull();
    expect(r.sale).toBeNull();
  });
});

describe("parseListingTiles", () => {
  it("reads permalink + regular/sale per tile from a shop listing", () => {
    const tiles = parseListingTiles(fx("bozinovski-listing.html"));
    expect(tiles).toHaveLength(2);
    const sale = tiles.find((t) => t.permalink.endsWith("/tv-set/"));
    expect(sale?.regular).toBeCloseTo(11900, 0);
    expect(sale?.sale).toBeCloseTo(8330, 0);
    const full = tiles.find((t) => t.permalink.includes("jazzmaster"));
    expect(full?.regular).toBeCloseTo(49900, 0);
    expect(full?.sale ?? null).toBeNull();
  });
});

import { mapProduct } from "../../src/sources/woocommerce.js";

const wc = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "JAZZMASTER OPEN HEART",
  slug: "jazzmaster-open-heart",
  prices: { regular_price: "4990000", currency_minor_unit: 2, currency_code: "MKD" },
  is_in_stock: true,
  categories: [{ name: "Часовници" }],
  images: [{ src: "https://x/a.jpg" }],
  permalink: "https://bozinovski.com.mk/proizvod/jazzmaster/",
  attributes: [],
  ...over,
});

describe("mapProduct gender + product type", () => {
  it("reads Bozinovski gender from the pa_sex attribute", () => {
    const o = mapProduct(
      wc({ attributes: [{ taxonomy: "pa_sex", terms: [{ name: "Женски" }] }] }) as never,
    );
    expect(o.gender).toBe("womens");
    expect(o.productType).toBe("watches");
  });
  it("reads B-Watch gender from pa_pol", () => {
    const o = mapProduct(
      wc({ attributes: [{ taxonomy: "pa_pol", terms: [{ name: "Машки" }] }] }) as never,
    );
    expect(o.gender).toBe("mens");
  });
  it("falls back to the category string for gender (Watch Club)", () => {
    const o = mapProduct(
      wc({ categories: [{ name: "Женски часовници" }], attributes: [] }) as never,
    );
    expect(o.gender).toBe("womens");
    expect(o.productType).toBe("watches");
  });
  it("leaves gender null when no slug and category has no gender word", () => {
    const o = mapProduct(wc({ categories: [{ name: "Часовници" }], attributes: [] }) as never);
    expect(o.gender ?? null).toBeNull();
  });
});
