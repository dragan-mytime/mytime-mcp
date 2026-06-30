import { describe, expect, it, vi } from "vitest";
import { renderDigestWithPrompt, templateDigest } from "../src/digest-render.js";
import type { DigestResult } from "../src/index.js";

// No Gemini key → renderDigestWithPrompt must use the deterministic template.
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
        samples: [],
        byBrand: [{ brand: "Tissot", count: 4, avgPct: 25 }],
        byCategory: [{ category: "Watches", count: 9, avgPct: 20 }],
      },
      ads: {
        activeToday: 3,
        new: [
          {
            adTitle: "Summer sale",
            linkUrl: "https://x",
            daysRunning: 2,
            snapshotUrl: "https://fb/ad",
            mediaUrl: "https://cdn/ad.jpg",
            mediaType: "image",
          },
        ],
        stoppedCount: 1,
        longestRunning: {
          adTitle: "Evergreen",
          daysRunning: 45,
          mediaUrl: "https://cdn/ever.jpg",
          mediaType: "image",
          snapshotUrl: "https://fb/ever",
          linkUrl: "https://x/ever",
        },
      },
      social: { followers: { facebook: 120 } },
      inventory: { newProducts: 3, newStockouts: ["X"], priceMoves: [] },
    },
  ],
};

describe("renderDigestWithPrompt", () => {
  it("subject contains the generatedFor date", async () => {
    const r = await renderDigestWithPrompt(fakeDigest, "any prompt");
    expect(r.subject).toContain("2026-06-29");
  });

  it("falls back to the template when Gemini is unavailable", async () => {
    const r = await renderDigestWithPrompt(fakeDigest, "any prompt");
    expect(r.usedFallback).toBe(true);
    expect(r.html).toContain("competitor-alpha");
    expect(r.html).toContain("Daily competitor digest"); // EN marker
    expect(r.html).toContain("Дневен преглед"); // MK marker
  });
});

describe("templateDigest", () => {
  it("emits both EN and MK blocks", () => {
    const html = templateDigest(fakeDigest);
    expect(html).toContain("Daily competitor digest");
    expect(html).toContain("Дневен преглед");
  });
});
