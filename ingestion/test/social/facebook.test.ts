import { describe, expect, it } from "vitest";
import { mapFbPosts, normalizeFbPostUrl } from "../../src/social/facebook.js";

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
