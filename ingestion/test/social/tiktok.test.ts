import { describe, expect, it } from "vitest";
import { mapTtPosts } from "../../src/social/tiktok.js";

const items = [
  {
    id: "7xyz",
    text: "watch drop",
    createTimeISO: "2026-06-20T10:00:00.000Z",
    webVideoUrl: "https://tiktok.com/@h/video/7xyz",
    videoMeta: { coverUrl: "https://cdn/cover.jpg" },
    playCount: 15000,
    diggCount: 800,
    commentCount: 30,
    shareCount: 12,
    authorMeta: { name: "handle", fans: 5000 },
  },
];

describe("mapTtPosts", () => {
  it("maps a tiktok video with real-view reach and shares", () => {
    const posts = mapTtPosts(items as never, "handle");
    const p = posts[0];
    expect(p.externalPostId).toBe("7xyz");
    expect(p.views).toBe(15000);
    expect(p.shares).toBe(12);
    expect(p.engagement).toBe(842); // 800 + 30 + 12
    expect(p.estimatedReach).toBe(15000);
    expect(p.reachSource).toBe("views");
    expect(p.postType).toBe("video");
  });
});
