import { describe, expect, it } from "vitest";
import { skopjeDate } from "../src/pipeline/dates.js";

describe("skopjeDate", () => {
  it("returns the Skopje calendar date, not the UTC one, late at night (CEST, UTC+2)", () => {
    // 22:30 UTC on the 29th is already 00:30 on the 30th in Skopje.
    expect(skopjeDate(new Date("2026-06-29T22:30:00Z"))).toBe("2026-06-30");
  });
  it("returns the Skopje calendar date in winter (CET, UTC+1)", () => {
    // 23:30 UTC on Jan 15 is 00:30 on Jan 16 in Skopje.
    expect(skopjeDate(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-16");
  });
  it("matches the UTC date during the day", () => {
    expect(skopjeDate(new Date("2026-06-29T05:00:00Z"))).toBe("2026-06-29");
  });
});
