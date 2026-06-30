import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNop, specValue } from "../../src/sources/hronometar.js";

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

describe("hronometar spec parsing", () => {
  // Real markup: entity-encoded Cyrillic labels, unclosed <td> cells.
  const SPEC =
    "<table class=data-table><tbody>" +
    "<tr class=odd><td class=spec-name>&#x41C;&#x435;&#x445;&#x430;&#x43D;&#x438;&#x437;&#x430;&#x43C;<td class=spec-value>&#x410;&#x432;&#x442;&#x43E;&#x43C;&#x430;&#x442;&#x438;&#x43A;" +
    "<tr class=odd><td class=spec-name>&#x41F;&#x43E;&#x43B;<td class=spec-value>Машки" +
    "<tr class=even><td class=spec-name>&#x41A;&#x43E;&#x43B;&#x435;&#x43A;&#x446;&#x438;&#x458;&#x430;<td class=spec-value>Coupole Classic</table>";

  it("reads the Пол spec value", () => {
    expect(specValue(SPEC, "Пол")).toBe("Машки");
  });
  it("reads the Колекција spec value", () => {
    expect(specValue(SPEC, "Колекција")).toBe("Coupole Classic");
  });
  it("returns null for an absent label", () => {
    expect(specValue(SPEC, "Бренд")).toBeNull();
  });
});
