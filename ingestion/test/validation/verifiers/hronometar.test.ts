import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hronometarVerifier } from "../../../src/validation/verifiers/hronometar.js";

const html017 = readFileSync(
  new URL("../../sources/fixtures/hronometar/017g621.html", import.meta.url),
  "utf8",
);

const htmlSpb = readFileSync(
  new URL("../../sources/fixtures/hronometar/spb375j1.html", import.meta.url),
  "utf8",
);

describe("hronometarVerifier", () => {
  it("targets includes hronometar", () => {
    expect(hronometarVerifier.targets).toContain("hronometar");
  });

  describe("017g621 (on sale: regular 7600, sale 6080)", () => {
    const snap = hronometarVerifier.extract(html017, "", "https://hronometar.mk/watches/017g621");

    it("price is 7600", () => {
      expect(snap.price).not.toBeNull();
      expect(snap.price).toBeCloseTo(7600, 0);
    });

    it("salePrice is 6080", () => {
      expect(snap.salePrice).not.toBeNull();
      expect(snap.salePrice).toBeCloseTo(6080, 0);
    });
  });

  describe("spb375j1 (not on sale: price 71250)", () => {
    const snap = hronometarVerifier.extract(htmlSpb, "", "https://hronometar.mk/watches/spb375j1");

    it("price is 71250", () => {
      expect(snap.price).not.toBeNull();
      expect(snap.price).toBeCloseTo(71250, 0);
    });

    it("salePrice is null", () => {
      expect(snap.salePrice ?? null).toBeNull();
    });
  });
});
