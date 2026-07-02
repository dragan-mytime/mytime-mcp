import { describe, expect, it } from "vitest";
import { brandMatchKey, normalizeModelKey, parseModelRef } from "../src/pipeline/normalize.js";

describe("parseModelRef", () => {
  it("prefers a real sku over name/slug — source: attr", () => {
    const r = parseModelRef("CARSON", "H76615130", "carson-4");
    expect(r).toEqual({ ref: "H76615130", source: "attr" });
  });
  it("ignores a numeric db-id sku and finds the code in the name — source: name", () => {
    const r = parseModelRef("Casio Timeless A168WA-1W", "24602", "casio-timeless-a168wa-1w");
    expect(r).toEqual({ ref: "A168WA-1W", source: "name" });
  });
  it("extracts a dotted manufacturer code mid-name — source: name", () => {
    const r = parseModelRef("PIERRE CARDIN CF.1019.LB.1", null, null);
    expect(r).toEqual({ ref: "CF.1019.LB.1", source: "name" });
  });
  it("extracts a leading code — source: name", () => {
    const r = parseModelRef("JC1L359M0075 Eterna Set", null, null);
    expect(r).toEqual({ ref: "JC1L359M0075", source: "name" });
  });
  it("falls back to the slug when the name has no code — source: slug (B7: callers should NOT store this)", () => {
    const r = parseModelRef("Notes of Coral", null, "notes-of-coral");
    expect(r).toEqual({ ref: "NOTES-OF-CORAL", source: "slug" });
  });
  it("returns null when there is nothing usable", () => {
    expect(parseModelRef("Watch", null, null)).toBeNull();
  });

  // B7: callers must NOT store slug-derived refs as match keys
  it("callers correctly discard slug-derived refs (B7)", () => {
    const r = parseModelRef("Notes of Coral", null, "notes-of-coral");
    const stored = r?.source !== "slug" ? (r?.ref ?? null) : null;
    expect(stored).toBeNull();
  });
  it("callers keep attr/name-derived refs (B7)", () => {
    const r = parseModelRef("Casio Timeless A168WA-1W", null, "casio-timeless-a168wa-1w");
    const stored = r?.source !== "slug" ? (r?.ref ?? null) : null;
    expect(stored).toBe("A168WA-1W");
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
