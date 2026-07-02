import { describe, expect, it } from "vitest";
import { parseAppSettings } from "../src/settings.js";

describe("parseAppSettings", () => {
  it("returns defaults for an empty settings table", () => {
    expect(parseAppSettings({})).toEqual({
      discountThresholdPct: 5,
      adResultsLimit: 50,
      webMaxProducts: null,
      digestEnabled: true,
    });
  });

  it("reads stored numeric and boolean values", () => {
    expect(
      parseAppSettings({
        discount_threshold_pct: 10,
        ad_results_limit: 120,
        web_max_products: 500,
        digest_enabled: false,
      }),
    ).toEqual({
      discountThresholdPct: 10,
      adResultsLimit: 120,
      webMaxProducts: 500,
      digestEnabled: false,
    });
  });

  it("coerces numeric strings (jsonb round-trips)", () => {
    const s = parseAppSettings({ discount_threshold_pct: "8", web_max_products: "250" });
    expect(s.discountThresholdPct).toBe(8);
    expect(s.webMaxProducts).toBe(250);
  });

  it("falls back to defaults for invalid values", () => {
    const s = parseAppSettings({
      discount_threshold_pct: "abc",
      ad_results_limit: 0,
      web_max_products: -3,
      digest_enabled: "yes",
    });
    expect(s.discountThresholdPct).toBe(5);
    expect(s.adResultsLimit).toBe(50);
    expect(s.webMaxProducts).toBeNull();
    expect(s.digestEnabled).toBe(true);
  });

  it("rejects non-integers and null", () => {
    const s = parseAppSettings({ discount_threshold_pct: 7.5, ad_results_limit: null });
    expect(s.discountThresholdPct).toBe(5);
    expect(s.adResultsLimit).toBe(50);
  });
});
