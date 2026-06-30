import { describe, expect, it } from "vitest";
import { mapFbPosts } from "../../src/social/facebook.js";

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
});
