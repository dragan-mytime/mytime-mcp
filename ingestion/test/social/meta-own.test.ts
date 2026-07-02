import { describe, expect, it } from "vitest";
import { mapFbActions, mapIgOwnPost } from "../../src/social/meta-own.js";

describe("mapFbActions", () => {
  it("splits organic action counts into likes/comments/shares + engagement", () => {
    expect(mapFbActions({ like: 9, share: 1, comment: 2 }, 8000)).toMatchObject({
      likes: 9,
      comments: 2,
      shares: 1,
      engagement: 12,
      estimatedReach: 800, // 8000 * 0.1 (fb reach retired → estimate)
      reachSource: "estimate",
    });
  });
  it("returns null engagement when the action map is empty", () => {
    expect(mapFbActions({}, 8000).engagement).toBeNull();
  });
});

describe("mapIgOwnPost reach basis", () => {
  const base = {
    id: "m1",
    like_count: 10,
    comments_count: 2,
    timestamp: "2026-06-30T10:00:00+0000",
    media_type: "IMAGE",
  };
  it("uses measured reach when the insight returns a value", () => {
    const p = mapIgOwnPost(base as never, { reach: 5000, views: null, shares: 3 }, 10000);
    expect(p.estimatedReach).toBe(5000);
    expect(p.reachSource).toBe("measured");
    expect(p.shares).toBe(3);
    // B4: engagement = likes+comments only (shares excluded for parity with competitor IG).
    expect(p.engagement).toBe(12); // 10 + 2 (NOT 10 + 2 + 3)
  });
  it("falls back to estimate when insights are unavailable", () => {
    const p = mapIgOwnPost(base as never, { reach: null, views: null, shares: null }, 10000);
    expect(p.estimatedReach).toBe(2000); // 10000 * 0.2
    expect(p.reachSource).toBe("estimate");
    // B4: engagement = likes+comments only.
    expect(p.engagement).toBe(12); // 10 + 2
  });
  it("B4: stores insight shares in the shares column but excludes them from engagement", () => {
    const p = mapIgOwnPost(base as never, { reach: 5000, views: null, shares: 100 }, 10000);
    expect(p.shares).toBe(100);
    expect(p.engagement).toBe(12); // 10 likes + 2 comments — 100 shares excluded
  });
  it("B4: null engagement when both likes and comments are absent (shares alone is not enough)", () => {
    const noLikesNoComments = {
      id: "m2",
      timestamp: "2026-06-30T10:00:00+0000",
      media_type: "IMAGE",
    };
    const p = mapIgOwnPost(
      noLikesNoComments as never,
      { reach: null, views: null, shares: 5 },
      null,
    );
    expect(p.engagement).toBeNull();
    expect(p.shares).toBe(5);
  });
});
