import type { DigestResult } from "@mytime/db";
import { describe, expect, it, vi } from "vitest";
import { renderDigestEmail } from "../../src/digest/render.js";

// Force Gemini key absent so all assertions use the deterministic fallback.
vi.stubEnv("GEMINI_API_KEY", "");

const fakeDigest: DigestResult = {
  generatedFor: "2026-06-29",
  note: "Test digest",
  competitors: [
    {
      targetId: "competitor-alpha",
      sales: {
        newlyDiscounted: 5,
        ended: 2,
        onSaleToday: 12,
        avgPct: 18.5,
        samples: [{ name: "Widget A", was: 1000, now: 820, pct: 18 }],
      },
      ads: {
        activeToday: 3,
        new: [
          {
            adTitle: "Summer Sale Ad",
            linkUrl: "https://example.com",
            daysRunning: 1,
            snapshotUrl: null,
          },
        ],
        stoppedCount: 1,
        longestRunning: { daysRunning: 45, adTitle: "Always On Ad" },
      },
      social: { followers: { facebook: 120, instagram: -5 } },
      inventory: {
        newProducts: 3,
        newStockouts: ["Product X", "Product Y"],
        priceMoves: [{ name: "Widget B", from: 2000, to: 1800 }],
      },
    },
  ],
};

describe("renderDigestEmail", () => {
  it("resolves without throwing", async () => {
    await expect(renderDigestEmail(fakeDigest)).resolves.toBeDefined();
  });

  it("subject contains the generatedFor date", async () => {
    const result = await renderDigestEmail(fakeDigest);
    expect(result.subject).toContain("2026-06-29");
  });

  it("html contains the competitor targetId", async () => {
    const result = await renderDigestEmail(fakeDigest);
    expect(result.html).toContain("competitor-alpha");
  });

  it("html contains English marker", async () => {
    const result = await renderDigestEmail(fakeDigest);
    expect(result.html).toContain("Daily competitor digest");
  });

  it("html contains Macedonian marker", async () => {
    const result = await renderDigestEmail(fakeDigest);
    expect(result.html).toContain("Дневен преглед");
  });
});
