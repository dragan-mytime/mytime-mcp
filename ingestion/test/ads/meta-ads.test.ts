import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapAdItems } from "../../src/ads/meta-ads.js";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/facebook-ads-sample.json", import.meta.url), "utf8"),
);

describe("mapAdItems", () => {
  it("keeps only active ad items (skips page-summary items)", () => {
    const ads = mapAdItems(raw, "2026-06-29");
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.every((a) => a.adArchiveId)).toBe(true);
  });
  it("extracts start date, platforms, link, cta, snapshot url", () => {
    const a = mapAdItems(raw, "2026-06-29").find((x) => x.linkUrl);
    expect(a).toBeDefined();
    expect(a?.startedRunningDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(a?.platforms)).toBe(true);
    expect(a?.snapshotUrl).toContain("ads/library");
  });
  it("computes non-negative days_running", () => {
    const a = mapAdItems(raw, "2026-06-29").find((x) => x.daysRunning != null);
    expect(a?.daysRunning).toBeGreaterThanOrEqual(0);
  });
  it("returns readable Cyrillic ad copy", () => {
    const withBody = mapAdItems(raw, "2026-06-29").find(
      (x) => x.adBody && /[а-шА-Ш]{3,}/.test(x.adBody),
    );
    expect(withBody).toBeDefined();
  });
});
