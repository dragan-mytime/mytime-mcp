import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectOwnBrandMeta, mapFbActions, mapIgOwnPost } from "../../src/social/meta-own.js";

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

describe("collectOwnBrandMeta failure signaling (T3a review)", () => {
  const jsonRes = (body: unknown) => ({ json: async () => body });

  beforeEach(() => {
    vi.stubEnv("META_ACCESS_TOKEN", "test-token");
    vi.stubEnv("META_IG_USER_ID", "ig123");
    vi.stubEnv("META_PAGE_ID", "pg456");
    // Silence the expected per-platform error logs.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws an aggregate error when BOTH configured platforms fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: { message: "token expired" } })),
    );
    await expect(collectOwnBrandMeta()).rejects.toThrow(/all configured platforms failed/);
    await expect(collectOwnBrandMeta()).rejects.toThrow(/instagram: .*token expired/);
    await expect(collectOwnBrandMeta()).rejects.toThrow(/facebook: .*token expired/);
  });

  it("returns partial results (no throw) when only IG fails and FB succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/ig123")) return jsonRes({ error: { message: "ig down" } });
        if (u.includes("/pg456/published_posts")) return jsonRes({ data: [] });
        if (u.includes("/pg456")) return jsonRes({ followers_count: 42, fan_count: 40 });
        return jsonRes({ error: { message: "unexpected node" } });
      }),
    );
    const res = await collectOwnBrandMeta();
    expect(res).toHaveLength(1);
    expect(res[0].platform).toBe("facebook");
    expect(res[0].metrics.find((m) => m.metric === "followers")?.value).toBe(42);
  });
});
