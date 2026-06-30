import { describe, expect, it } from "vitest";
import { estimateReach } from "../../src/social/reach.js";

describe("estimateReach", () => {
  it("uses real views when present (video)", () => {
    expect(estimateReach("tiktok", 12000, 5000)).toEqual({ reach: 12000, source: "views" });
  });
  it("estimates from followers x benchmark when no views (instagram)", () => {
    expect(estimateReach("instagram", null, 10000)).toEqual({ reach: 2000, source: "estimate" });
  });
  it("estimates with the facebook benchmark", () => {
    expect(estimateReach("facebook", null, 10000)).toEqual({ reach: 1000, source: "estimate" });
  });
  it("returns null reach when neither views nor followers are known", () => {
    expect(estimateReach("instagram", null, null)).toEqual({ reach: null, source: null });
  });
});
