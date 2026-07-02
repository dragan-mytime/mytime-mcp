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

  // A9: Apify returns likesCount=-1 when the profile hides likes.
  it("A9: -1 likesCount maps to null likes and engagement = comments only", () => {
    const hiddenLikesProfile = {
      followersCount: 5000,
      latestPosts: [
        {
          id: "hidden1",
          shortCode: "hidden1",
          url: "https://instagram.com/p/hidden1",
          type: "Image",
          likesCount: -1, // Apify hidden-likes sentinel
          commentsCount: 15,
          timestamp: "2026-06-20T10:00:00.000Z",
        },
      ],
    };
    const posts = mapIgPosts(hiddenLikesProfile as never);
    const p = posts[0];
    expect(p?.likes).toBeNull();
    expect(p?.comments).toBe(15);
    expect(p?.engagement).toBe(15); // comments only — no -1 pollution
  });

  it("A9: both likes and comments null → engagement null (no hidden-likes sentinel)", () => {
    const noDataProfile = {
      followersCount: 5000,
      latestPosts: [
        {
          id: "nodata1",
          shortCode: "nodata1",
          url: "https://instagram.com/p/nodata1",
          type: "Image",
          timestamp: "2026-06-20T10:00:00.000Z",
          // no likesCount, no commentsCount
        },
      ],
    };
    const posts = mapIgPosts(noDataProfile as never);
    expect(posts[0]?.likes).toBeNull();
    expect(posts[0]?.comments).toBeNull();
    expect(posts[0]?.engagement).toBeNull();
  });
});
