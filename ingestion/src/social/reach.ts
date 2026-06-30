import type { SocialPlatform } from "@mytime/shared";

/**
 * Organic reach-rate benchmarks (share of followers an average post reaches).
 * Industry ballparks — tunable. TikTok rarely uses these (it exposes real views).
 */
const REACH_RATE: Record<SocialPlatform, number> = {
  instagram: 0.2,
  facebook: 0.1,
  tiktok: 0.05,
};

/**
 * Estimated reach for a post. Real public `views` (video/reel/tiktok) are the
 * measured proxy; otherwise estimate from `followers × benchmark`. Returns the
 * value plus its source so callers can label it honestly.
 */
export function estimateReach(
  platform: SocialPlatform,
  views: number | null,
  followers: number | null,
): { reach: number | null; source: "views" | "estimate" | null } {
  if (typeof views === "number" && views > 0) return { reach: views, source: "views" };
  if (typeof followers === "number" && followers > 0) {
    return { reach: Math.round(followers * REACH_RATE[platform]), source: "estimate" };
  }
  return { reach: null, source: null };
}
