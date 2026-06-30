import { describe, expect, it } from "vitest";
import { brandMatchKey, normalizeModelKey, parseModelRef } from "../src/pipeline/normalize.js";

describe("parseModelRef", () => {
  it("prefers a real sku over name/slug", () => {
    expect(parseModelRef("CARSON", "H76615130", "carson-4")).toBe("H76615130");
  });
  it("ignores a numeric db-id sku and finds the code in the name", () => {
    expect(parseModelRef("Casio Timeless A168WA-1W", "24602", "casio-timeless-a168wa-1w")).toBe(
      "A168WA-1W",
    );
  });
  it("extracts a dotted manufacturer code mid-name", () => {
    expect(parseModelRef("PIERRE CARDIN CF.1019.LB.1", null, null)).toBe("CF.1019.LB.1");
  });
  it("extracts a leading code", () => {
    expect(parseModelRef("JC1L359M0075 Eterna Set", null, null)).toBe("JC1L359M0075");
  });
  it("falls back to the slug when the name has no code", () => {
    expect(parseModelRef("Notes of Coral", null, "notes-of-coral")).toBe("NOTES-OF-CORAL");
  });
  it("returns null when there is nothing usable", () => {
    expect(parseModelRef("Watch", null, null)).toBeNull();
  });
});

describe("normalizeModelKey", () => {
  it("strips punctuation and uppercases", () => {
    expect(normalizeModelKey("A168WA-1W")).toBe("A168WA1W");
    expect(normalizeModelKey("dkj.5.50006-3")).toBe("DKJ5500063");
  });
  it("returns null for keys shorter than 5 alphanumerics", () => {
    expect(normalizeModelKey("AB-1")).toBeNull();
    expect(normalizeModelKey(null)).toBeNull();
  });
});

describe("brandMatchKey", () => {
  it("collapses Casio sub-lines and flags G-Shock", () => {
    expect(brandMatchKey("Casio Timeless", "A168WA-1W")).toEqual({
      brand: "CASIO",
      isGShock: false,
    });
    expect(brandMatchKey("Casio Vintage", "...")).toEqual({ brand: "CASIO", isGShock: false });
    expect(brandMatchKey("Casio", "G-SHOCK GA-2100")).toEqual({ brand: "CASIO", isGShock: true });
  });
  it("passes other brands through uppercased; empty when unknown", () => {
    expect(brandMatchKey("Seiko", "SPB375J1")).toEqual({ brand: "SEIKO", isGShock: false });
    expect(brandMatchKey(null, "x")).toEqual({ brand: "", isGShock: false });
  });
});
