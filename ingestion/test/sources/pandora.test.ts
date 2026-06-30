import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseListing } from "../../src/sources/pandora.js";

const fx = (f: string) => readFileSync(new URL(`./fixtures/pandora/${f}`, import.meta.url), "utf8");

describe("pandora monobrand defaults", () => {
  it("defaults gender to womens and type to jewelry", () => {
    const items = parseListing(fx("listing.html"));
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.gender).toBe("womens");
      expect(it.productType).toBe("jewelry");
    }
  });
});
