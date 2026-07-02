import { describe, expect, it, vi } from "vitest";
import { renderDigestWithPrompt, templateDigest } from "../src/digest-render.js";
import type { DigestResult } from "../src/index.js";

// No Gemini key → renderDigestWithPrompt must use the deterministic template.
vi.stubEnv("GEMINI_API_KEY", "");

const freshOk = { lastSuccessAt: "2026-06-29T04:00:00Z", stale: false };
const freshStale = { lastSuccessAt: null, stale: true };

const fakeDigest: DigestResult = {
  generatedFor: "2026-06-29",
  windowDays: 1,
  note: "Test digest",
  competitors: [
    {
      targetId: "competitor-alpha",
      dataFreshness: {
        products: freshOk,
        ads: freshOk,
        social: freshOk,
      },
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
      priceUndercuts: {
        newlyUndercut: [
          {
            ref: "A168WA1W",
            name: "Casio A168WA-1W",
            brand: "Casio",
            mtPrice: 3200,
            compPrice: 2900,
            deltaPct: -10,
          },
        ],
        resolved: [
          {
            ref: "SPB375J1",
            name: "Seiko SPB375J1",
            brand: "Seiko",
            mtPrice: 42000,
            compPrice: 45000,
            deltaPct: 7,
          },
        ],
        totalNewlyUndercut: 3,
        totalResolved: 1,
      },
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

  it("shows weekly heading when windowDays > 1", () => {
    const weeklyDigest: DigestResult = { ...fakeDigest, windowDays: 7 };
    const html = templateDigest(weeklyDigest);
    expect(html).toContain("Weekly competitor digest");
    expect(html).toContain("Неделен преглед");
  });

  it("renders the priceUndercuts section (E2) with items and totals", () => {
    const html = templateDigest(fakeDigest);
    // EN + MK headings
    expect(html).toContain("Price undercuts");
    expect(html).toContain("Пониски цени од нашите");
    // Newly undercut item with both prices + delta
    expect(html).toContain("Casio A168WA-1W");
    expect(html).toContain("A168WA1W");
    expect(html).toContain("3200");
    expect(html).toContain("2900");
    expect(html).toContain("(-10%)");
    // Resolved item
    expect(html).toContain("Seiko SPB375J1");
    // Totals (3 newly undercut even though only 1 item listed — capped list)
    expect(html).toContain("Newly undercut: 3");
    expect(html).toContain("Resolved: 1");
  });

  it("undercuts section shows stale warning when products freshness is stale", () => {
    const staleDigest: DigestResult = {
      ...fakeDigest,
      competitors: [
        {
          ...fakeDigest.competitors[0]!,
          dataFreshness: { products: freshStale, ads: freshOk, social: freshOk },
        },
      ],
    };
    const html = templateDigest(staleDigest);
    expect(html).not.toContain("Newly undercut: 3");
  });

  it("renders stale-freshness warning instead of data for stale sections", () => {
    const staleDigest: DigestResult = {
      ...fakeDigest,
      competitors: [
        {
          ...fakeDigest.competitors[0]!,
          dataFreshness: {
            products: freshStale,
            ads: freshStale,
            social: { lastSuccessAt: "2026-06-27T10:00:00Z", stale: true },
          },
        },
      ],
    };
    const html = templateDigest(staleDigest);
    // Stale sections should show the warning, not data values
    expect(html).toContain("no fresh data since");
    // Normal metrics should NOT appear (e.g., the on_sale_today count)
    expect(html).not.toContain("On sale today");
    expect(html).not.toContain("Active ads");
  });
});
