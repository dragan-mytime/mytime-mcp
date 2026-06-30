import { describe, expect, it } from "vitest";
import { map } from "../../src/sources/zia.js";

const item = (over: Record<string, unknown> = {}) => ({
  _id: "1",
  name: "KR016",
  price: 990,
  status: "active",
  stock: 5,
  category: { name: "алки" },
  images: [{ url: "https://x/a.jpg" }],
  tags: [],
  ...over,
});

describe("zia monobrand defaults", () => {
  it("defaults gender to womens and classifies jewelry", () => {
    const o = map(item() as never, "https://zia.mk");
    expect(o.gender).toBe("womens");
    expect(o.productType).toBe("jewelry");
  });
  it("preserves an explicit kids signal in the category", () => {
    const o = map(item({ category: { name: "ZIA Kids" } }) as never, "https://zia.mk");
    expect(o.gender).toBe("kids");
  });
});
