import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webJsonLdVerifier } from "../../../src/validation/verifiers/web-jsonld.js";

const htmlEscp = readFileSync(
  new URL("../fixtures/saat-saat/escp103004-9494.html", import.meta.url),
  "utf8",
);

const htmlFes = readFileSync(
  new URL("../fixtures/saat-saat/fes5433-32628.html", import.meta.url),
  "utf8",
);

describe("webJsonLdVerifier", () => {
  it("targets includes saat-saat", () => {
    expect(webJsonLdVerifier.targets).toContain("saat-saat");
  });

  describe("escp103004-9494 (on sale: regular 8000, sale 6400)", () => {
    const snap = webJsonLdVerifier.extract(
      htmlEscp,
      "",
      "https://saatandsaat.mk/en/product/escp103004-9494",
    );

    it("name contains ESCP103004", () => {
      expect(snap.name).toBeTruthy();
      expect(snap.name).toContain("ESCP103004");
    });

    it("price (regular/list) is 8000", () => {
      expect(snap.price).not.toBeNull();
      expect(snap.price).toBeCloseTo(8000, 0);
    });

    it("salePrice is 6400", () => {
      expect(snap.salePrice).not.toBeNull();
      expect(snap.salePrice).toBeCloseTo(6400, 0);
    });
  });

  describe("fes5433-32628 (not on sale: price 11290)", () => {
    const snap = webJsonLdVerifier.extract(
      htmlFes,
      "",
      "https://saatandsaat.mk/en/product/fes5433-32628",
    );

    it("name contains FES5433", () => {
      expect(snap.name).toBeTruthy();
      expect(snap.name).toContain("FES5433");
    });

    it("price is 11290", () => {
      expect(snap.price).not.toBeNull();
      expect(snap.price).toBeCloseTo(11290, 0);
    });

    it("salePrice is null", () => {
      expect(snap.salePrice).toBeNull();
    });
  });
});
