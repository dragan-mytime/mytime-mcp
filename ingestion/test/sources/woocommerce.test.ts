import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWooSalePrice } from "../../src/sources/woocommerce.js";

const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/woocommerce/${f}`, import.meta.url), "utf8");

describe("parseWooSalePrice", () => {
  it("extracts del/ins regular+sale on a discounted product", () => {
    const r = parseWooSalePrice(fx("pxw453-04.html"));
    expect(r.regular).toBeCloseTo(12690, 0);
    expect(r.sale).toBeCloseTo(6345, 0);
  });
  it("returns no sale on a full-price product", () => {
    const r = parseWooSalePrice(fx("dk-6-14452-4.html"));
    expect(r.sale ?? null).toBeNull();
  });
});
