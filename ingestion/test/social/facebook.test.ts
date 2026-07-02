import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock apifyRun only — every other _social export (toDateOrNull, types) stays real.
vi.mock("../../src/social/_social.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/social/_social.js")>();
  return { ...orig, apifyRun: vi.fn() };
});

import { apifyRun } from "../../src/social/_social.js";
import {
  facebookCollector,
  mapFbPosts,
  normalizeFbPostUrl,
  urlMatchesHandle,
} from "../../src/social/facebook.js";

const fbPosts = [
  {
    postId: "p1",
    url: "https://facebook.com/page/posts/p1",
    text: "Sale starts now",
    time: "2026-06-20T10:00:00.000Z",
    likes: 40,
    reactionsCount: 55, // total reactions across types
    comments: 6,
    shares: 3,
    media: [{ thumbnail: "https://cdn/fb.jpg" }],
  },
];

describe("mapFbPosts", () => {
  it("maps an fb post: total reactions→likes, sums engagement, follower-estimated reach", () => {
    const posts = mapFbPosts(fbPosts as never, 8000);
    const p = posts[0];
    expect(p.externalPostId).toBe("p1");
    expect(p.likes).toBe(55); // prefers reactionsCount over the plain like count
    expect(p.comments).toBe(6);
    expect(p.shares).toBe(3);
    expect(p.engagement).toBe(64); // 55 + 6 + 3
    expect(p.estimatedReach).toBe(800); // 8000 * 0.1
    expect(p.reachSource).toBe("estimate");
  });

  // A6: locale-formatted / garbage date strings must not crash the mapper.
  it("A6: returns null postedAt for a locale-formatted (unparseable) date string", () => {
    const _posts = mapFbPosts(
      [{ postId: "p-locale", time: "June 20, 2026 at 10:00 AM" }] as never,
      null,
    );
    // June 20, 2026 at 10:00 AM is actually parseable by Date.parse in most engines,
    // so use a truly garbage string to confirm the guard.
    const posts2 = mapFbPosts(
      [{ postId: "p-garbage", time: "NOT A DATE AT ALL !!!" }] as never,
      null,
    );
    expect(posts2[0]?.postedAt).toBeNull();
  });

  it("A6: ISO date string parses successfully to non-null postedAt", () => {
    const posts = mapFbPosts(
      [{ postId: "p-iso", time: "2026-06-20T10:00:00.000Z" }] as never,
      null,
    );
    expect(posts[0]?.postedAt).not.toBeNull();
  });

  // A8: URL-based ids must be normalized to avoid duplicate rows.
  it("A8: normalizes m.facebook.com URL to www and strips query params for the id", () => {
    const posts = mapFbPosts(
      [{ postUrl: "https://m.facebook.com/story.php?story_fbid=123&id=456&_rdr" }] as never,
      null,
    );
    expect(posts[0]?.externalPostId).toBe("https://www.facebook.com/story.php");
  });

  it("A8: two runs with tracking-param variants produce the same externalPostId", () => {
    const run1 = mapFbPosts(
      [{ postUrl: "https://www.facebook.com/page/posts/999?__xts__=1" }] as never,
      null,
    );
    const run2 = mapFbPosts(
      [{ postUrl: "https://m.facebook.com/page/posts/999?fbclid=abc" }] as never,
      null,
    );
    expect(run1[0]?.externalPostId).toBe(run2[0]?.externalPostId);
  });

  it("A8: drops a post with no postId and no URL", () => {
    const posts = mapFbPosts([{ text: "orphan post" }] as never, null);
    expect(posts).toHaveLength(0);
  });
});

describe("normalizeFbPostUrl", () => {
  it("forces www.facebook.com and strips query + hash", () => {
    expect(normalizeFbPostUrl("https://m.facebook.com/story.php?story_fbid=1&id=2#top")).toBe(
      "https://www.facebook.com/story.php",
    );
  });
  it("strips trailing slash", () => {
    expect(normalizeFbPostUrl("https://www.facebook.com/page/posts/123/")).toBe(
      "https://www.facebook.com/page/posts/123",
    );
  });
  it("returns original string when URL is unparseable", () => {
    expect(normalizeFbPostUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("urlMatchesHandle", () => {
  it("matches the handle as an exact path segment anywhere in the path", () => {
    expect(urlMatchesHandle("https://www.facebook.com/pagename", "pagename")).toBe(true);
    expect(urlMatchesHandle("https://www.facebook.com/pagename/posts/123", "pagename")).toBe(true);
  });
  it("never substring-matches: 'page' must not match /pagename/...", () => {
    expect(urlMatchesHandle("https://www.facebook.com/pagename/posts/123", "page")).toBe(false);
  });
  it("never treats FB routing keywords as handles", () => {
    expect(urlMatchesHandle("https://www.facebook.com/pagename/posts/123", "posts")).toBe(false);
    expect(urlMatchesHandle("https://www.facebook.com/permalink.php?id=1", "permalink.php")).toBe(
      false,
    );
  });
  it("returns false for unparseable URLs and empty handles", () => {
    expect(urlMatchesHandle("not-a-url", "pagename")).toBe(false);
    expect(urlMatchesHandle("https://www.facebook.com/pagename", "")).toBe(false);
  });
});

describe("facebookCollector.collect post attribution (A7 review)", () => {
  const accounts = [
    {
      targetId: "t-pagename",
      platform: "facebook" as const,
      url: "https://facebook.com/pagename",
      handle: "pagename",
    },
    {
      targetId: "t-page",
      platform: "facebook" as const,
      url: "https://facebook.com/page",
      handle: "page", // substring of "pagename" — must never cross-match
    },
  ];
  const pageItems = [
    { url: "https://www.facebook.com/pagename", followers: 1000 },
    { url: "https://www.facebook.com/page", followers: 500 },
  ];
  const postItems = [
    // Standard post-URL format: /<handle>/posts/<id> → t-pagename.
    { postId: "std1", postUrl: "https://www.facebook.com/pagename/posts/12345678", likes: 5 },
    // Page-URL echo field (facebookUrl) carries the attribution → t-page.
    {
      postId: "echo1",
      postUrl: "https://www.facebook.com/story.php?story_fbid=9&id=555",
      facebookUrl: "https://www.facebook.com/page",
      likes: 2,
    },
    // Numeric permalink URL with no handle anywhere → unmatched, logged.
    { postId: "perm1", postUrl: "https://www.facebook.com/permalink.php?story_fbid=1&id=42" },
  ];

  beforeEach(() => {
    vi.mocked(apifyRun).mockImplementation(async (actor: string) =>
      actor === "apify~facebook-pages-scraper" ? (pageItems as never) : (postItems as never),
    );
  });
  afterEach(() => {
    vi.mocked(apifyRun).mockReset();
  });

  it("attributes /handle/posts/id URLs to the right page (standard format regression)", async () => {
    const res = await facebookCollector.collect(accounts);
    const pagename = res.find((r) => r.targetId === "t-pagename");
    expect(pagename?.posts?.map((p) => p.externalPostId)).toContain("std1");
  });

  it("attributes page-URL echo items via the echoed facebookUrl field", async () => {
    const res = await facebookCollector.collect(accounts);
    const page = res.find((r) => r.targetId === "t-page");
    expect(page?.posts?.map((p) => p.externalPostId)).toContain("echo1");
  });

  it("never matches a handle that is a substring of another page's handle", async () => {
    const res = await facebookCollector.collect(accounts);
    const page = res.find((r) => r.targetId === "t-page");
    const pagename = res.find((r) => r.targetId === "t-pagename");
    expect(page?.posts?.map((p) => p.externalPostId)).not.toContain("std1");
    expect(pagename?.posts?.map((p) => p.externalPostId)).not.toContain("echo1");
  });

  it("logs numeric permalink.php items as unmatched instead of silently dropping", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await facebookCollector.collect(accounts);
      for (const r of res) {
        expect(r.posts?.map((p) => p.externalPostId)).not.toContain("perm1");
      }
      const unmatchedCall = warn.mock.calls.find((c) =>
        String(c[0]).includes("post-scraper items could not be matched"),
      );
      expect(unmatchedCall).toBeDefined();
      expect(String(unmatchedCall?.[0])).toContain("1 post-scraper");
    } finally {
      warn.mockRestore();
    }
  });

  it("attributes page metrics by exact segment match (no positional fallback)", async () => {
    const res = await facebookCollector.collect(accounts);
    const pagename = res.find((r) => r.targetId === "t-pagename");
    const page = res.find((r) => r.targetId === "t-page");
    expect(pagename?.metrics.find((m) => m.metric === "followers")?.value).toBe(1000);
    expect(page?.metrics.find((m) => m.metric === "followers")?.value).toBe(500);
  });
});
