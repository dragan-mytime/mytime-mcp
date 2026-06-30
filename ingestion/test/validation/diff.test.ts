import { describe, expect, it } from "vitest";
import { diffVsDb, diffVsLlm } from "../../src/validation/diff.js";
import type { DbProductRow, LiveSnapshot } from "../../src/validation/types.js";

const db = (o: Partial<DbProductRow> = {}): DbProductRow => ({
  productId: "p1",
  targetId: "t",
  externalId: "x",
  url: "u",
  name: "Casio MTP-1",
  brand: "Casio",
  modelRef: "MTP-1",
  category: "Watches",
  price: 1000,
  salePrice: null,
  discountPct: null,
  stockStatus: "in_stock",
  ...o,
});

describe("diffVsDb", () => {
  it("flags a discount the DB missed as an error", () => {
    const live: LiveSnapshot = { price: 1000, salePrice: 800, stockStatus: "in_stock" };
    const m = diffVsDb(live, db());
    const sale = m.find((x) => x.field === "salePrice");
    expect(sale?.severity).toBe("error");
    expect(sale?.note).toMatch(/live shows a discount/i);
  });
  it("flags a stale DB discount the live page no longer shows", () => {
    const live: LiveSnapshot = { price: 1000, salePrice: null, stockStatus: "in_stock" };
    const m = diffVsDb(live, db({ salePrice: 800 }));
    const sale = m.find((x) => x.field === "salePrice");
    expect(sale?.severity).toBe("error");
    expect(sale?.note).toMatch(/no longer shows/i);
  });
  it("ignores price differences within tolerance", () => {
    const live: LiveSnapshot = { price: 1000.4, stockStatus: "in_stock" };
    expect(diffVsDb(live, db()).find((x) => x.field === "price")).toBeUndefined();
  });
  it("flags price differences beyond tolerance as error", () => {
    const live: LiveSnapshot = { price: 1200, stockStatus: "in_stock" };
    expect(diffVsDb(live, db()).find((x) => x.field === "price")?.severity).toBe("error");
  });
  it("flags stock mismatch as error", () => {
    const live: LiveSnapshot = { price: 1000, stockStatus: "out_of_stock" };
    expect(diffVsDb(live, db()).find((x) => x.field === "stockStatus")?.severity).toBe("error");
  });
  it("flags descriptive differences as review, not error", () => {
    const live: LiveSnapshot = { price: 1000, stockStatus: "in_stock", brand: "CASIO inc" };
    expect(diffVsDb(live, db()).find((x) => x.field === "brand")?.severity).toBe("review");
  });
  it("does not flag descriptive fields when the live value is absent", () => {
    const live: LiveSnapshot = { price: 1000, stockStatus: "in_stock", brand: null };
    expect(diffVsDb(live, db()).find((x) => x.field === "brand")).toBeUndefined();
  });
});

describe("diffVsLlm", () => {
  it("flags a price drift between verifier and LLM as review", () => {
    const verifier: LiveSnapshot = { price: 1000, salePrice: 800 };
    const llm: LiveSnapshot = { price: 1000, salePrice: null };
    expect(diffVsLlm(verifier, llm).find((x) => x.field === "salePrice")?.severity).toBe("review");
  });
});
