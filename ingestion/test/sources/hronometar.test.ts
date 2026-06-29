import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNop } from "../../src/sources/hronometar.js";

const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/hronometar/${f}`, import.meta.url), "utf8");

describe("hronometar parseNop discount capture", () => {
  it("captures the old (struck) price as regular and current as sale", () => {
    const o = parseNop(fx("017g621.html"), "https://www.hronometar.mk/017g621");
    expect(o).not.toBeNull();
    expect(o?.price).toBeCloseTo(7600, 0);
    expect(o?.salePrice).toBeCloseTo(6080, 0);
    expect(o?.discountPct).toBeCloseTo(20, 0);
  });
  it("records no discount on a full-price product", () => {
    const o = parseNop(fx("spb375j1.html"), "https://www.hronometar.mk/spb375j1");
    expect(o?.price).toBeCloseTo(71250, 0);
    expect(o?.salePrice ?? null).toBeNull();
    expect(o?.discountPct ?? null).toBeNull();
  });
});
