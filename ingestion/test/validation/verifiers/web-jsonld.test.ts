import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webJsonLdVerifier } from "../../../src/validation/verifiers/web-jsonld.js";

const html = readFileSync(
  new URL("../fixtures/saat-saat/ar11732-32480.html", import.meta.url),
  "utf8",
);
const url = "https://saatandsaat.mk/en/product/ar11732-32480";

describe("webJsonLdVerifier", () => {
  it("targets saat-saat and swarovski", () => {
    expect(webJsonLdVerifier.targets).toContain("saat-saat");
    expect(webJsonLdVerifier.targets).toContain("swarovski");
  });

  describe("saat-saat fixture: Emporio Armani AR11732 (not on sale)", () => {
    const snapshot = webJsonLdVerifier.extract(html, "", url);

    it("extracts the product name containing AR11732", () => {
      expect(snapshot.name).toBeTruthy();
      expect(snapshot.name).toContain("AR11732");
    });

    it("extracts the main product price as 279", () => {
      expect(snapshot.price).not.toBeNull();
      expect(snapshot.price).toBeCloseTo(279, 0);
    });

    it("returns null salePrice when product is not on sale", () => {
      expect(snapshot.salePrice).toBeNull();
    });
  });
});
