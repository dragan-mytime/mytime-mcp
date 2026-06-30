import { describe, expect, it } from "vitest";
import { normalizeType } from "../src/pipeline/normalize.js";

describe("normalizeType", () => {
  it("classifies watches from MK category", () => {
    expect(normalizeType("Машки Часовник", "Hamilton Jazzmaster")).toBe("watches");
  });
  it("classifies jewelry from MK sub-types", () => {
    expect(normalizeType("огрлици", "Zia KR016")).toBe("jewelry");
    expect(normalizeType("Женски Накит-Прстен", null)).toBe("jewelry");
  });
  it("classifies eyewear before watches (a watch store also sells очила)", () => {
    expect(normalizeType("Очила", "Ray-Ban часовник lookalike")).toBe("eyewear");
  });
  it("classifies accessories", () => {
    expect(normalizeType("Додатоци", "2-in-1 Wallet")).toBe("accessories");
  });
  it("falls back to the per-vendor default when there is no text signal", () => {
    expect(normalizeType(null, "794461C01", "jewelry")).toBe("jewelry");
    expect(normalizeType(null, "SSA461J1", "watches")).toBe("watches");
  });
  it("returns 'other' when text exists but matches nothing and no fallback", () => {
    expect(normalizeType("Ваучери", "Подарок ваучер")).toBe("other");
  });
  it("returns null when there is neither text nor a fallback", () => {
    expect(normalizeType(null, null)).toBeNull();
    expect(normalizeType("", "  ")).toBeNull();
  });
});
