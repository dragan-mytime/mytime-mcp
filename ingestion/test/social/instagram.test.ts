import { describe, expect, it } from "vitest";
import { mapIgPosts } from "../../src/social/instagram.js";

const profile = {
  followersCount: 10000,
  latestPosts: [
    {
      id: "abc123",
      shortCode: "abc123",
      caption: "New arrivals ⌚",
      url: "https://instagram.com/p/abc123",
      displayUrl: "https://cdn/img.jpg",
      type: "Image",
      likesCount: 120,
      commentsCount: 8,
      timestamp: "2026-06-20T10:00:00.000Z",
    },
    {
      id: "vid1",
      shortCode: "vid1",
      caption: "Reel",
      url: "https://instagram.com/reel/vid1",
      displayUrl: "https://cdn/thumb.jpg",
      type: "Video",
      likesCount: 50,
      commentsCount: 2,
      videoViewCount: 9000,
      timestamp: "2026-06-21T10:00:00.000Z",
    },
  ],
};

describe("mapIgPosts", () => {
  it("maps a static post with follower-estimated reach", () => {
    const posts = mapIgPosts(profile as never);
    const p = posts.find((x) => x.externalPostId === "abc123");
    expect(p?.caption).toBe("New arrivals ⌚");
    expect(p?.mediaUrl).toBe("https://cdn/img.jpg");
    expect(p?.engagement).toBe(128);
    expect(p?.estimatedReach).toBe(2000); // 10000 * 0.2
    expect(p?.reachSource).toBe("estimate");
  });
  it("maps a video post with real-view reach", () => {
    const posts = mapIgPosts(profile as never);
    const p = posts.find((x) => x.externalPostId === "vid1");
    expect(p?.views).toBe(9000);
    expect(p?.estimatedReach).toBe(9000);
    expect(p?.reachSource).toBe("views");
    expect(p?.postType).toBe("video");
  });
});
