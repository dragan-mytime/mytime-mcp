import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProduct } from "../../src/sources/web-jsonld.js";

const fx = (f: string) =>
  readFileSync(new URL(`../validation/fixtures/saat-saat/${f}`, import.meta.url), "utf8");

describe("web-jsonld parseProduct discount capture", () => {
  it("captures the struck original + sale price on a discounted product", () => {
    const o = parseProduct(
      fx("escp103004-9494.html"),
      "https://saatandsaat.mk/product/escp103004-9494",
    );
    expect(o).not.toBeNull();
    expect(o?.price).toBeCloseTo(8000, 0);
    expect(o?.salePrice).toBeCloseTo(6400, 0);
    expect(o?.discountPct).toBeCloseTo(20, 0);
  });
  it("records no discount on a full-price product", () => {
    const o = parseProduct(
      fx("fes5433-32628.html"),
      "https://saatandsaat.mk/product/fes5433-32628",
    );
    expect(o?.price).toBeCloseTo(11290, 0);
    expect(o?.salePrice ?? null).toBeNull();
    expect(o?.discountPct ?? null).toBeNull();
  });
});
