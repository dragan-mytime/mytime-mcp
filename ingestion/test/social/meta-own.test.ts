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
    expect(p.engagement).toBe(15); // 10 + 2 + 3
  });
  it("falls back to estimate when insights are unavailable (today's #10)", () => {
    const p = mapIgOwnPost(base as never, { reach: null, views: null, shares: null }, 10000);
    expect(p.estimatedReach).toBe(2000); // 10000 * 0.2
    expect(p.reachSource).toBe("estimate");
    expect(p.engagement).toBe(12); // 10 + 2
  });
});
