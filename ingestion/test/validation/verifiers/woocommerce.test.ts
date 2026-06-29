import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { woocommerceVerifier } from "../../../src/validation/verifiers/woocommerce.js";

const htmlPxw = readFileSync(
  new URL("../../sources/fixtures/woocommerce/pxw453-04.html", import.meta.url),
  "utf8",
);

const htmlDk = readFileSync(
  new URL("../../sources/fixtures/woocommerce/dk-6-14452-4.html", import.meta.url),
  "utf8",
);

describe("woocommerceVerifier", () => {
  it("targets includes b-watch", () => {
    expect(woocommerceVerifier.targets).toContain("b-watch");
  });

  describe("pxw453-04 (on sale: regular 12690, sale 6345)", () => {
    const snap = woocommerceVerifier.extract(htmlPxw, "", "https://example.mk/product/pxw453-04");

    it("price is 12690", () => {
      expect(snap.price).not.toBeNull();
      expect(snap.price).toBeCloseTo(12690, 0);
    });

    it("salePrice is 6345", () => {
      expect(snap.salePrice).not.toBeNull();
      expect(snap.salePrice).toBeCloseTo(6345, 0);
    });
  });

  describe("dk-6-14452-4 (not on sale: price 8490)", () => {
    const snap = woocommerceVerifier.extract(htmlDk, "", "https://example.mk/product/dk-6-14452-4");

    it("price is 8490", () => {
      expect(snap.price).not.toBeNull();
      expect(snap.price).toBeCloseTo(8490, 0);
    });

    it("salePrice is null", () => {
      expect(snap.salePrice ?? null).toBeNull();
    });
  });
});
