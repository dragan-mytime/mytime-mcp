import {
  optionalEnv,
  requireEnv,
  type SocialMetricValue,
  type SocialPlatform,
  type SocialPostObservation,
} from "@mytime/shared";

const GRAPH = "https://graph.facebook.com/v23.0";

async function graphGet(node: string, fields: string): Promise<Record<string, unknown>> {
  const token = requireEnv("META_ACCESS_TOKEN");
  const url = `${GRAPH}/${node}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (json.error) throw new Error(`Meta Graph API: ${json.error.message ?? "error"}`);
  return json;
}

/** IG media insights use ?metric= (not ?fields=). Returns the first metric value or null. */
async function graphInsight(mediaId: string, metric: string): Promise<number | null> {
  const token = requireEnv("META_ACCESS_TOKEN");
  const url = `${GRAPH}/${mediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as {
    data?: { values?: { value?: number }[] }[];
    error?: unknown;
  };
  if (json.error) return null;
  return json.data?.[0]?.values?.[0]?.value ?? null;
}

export interface OwnBrandSocialResult {
  platform: SocialPlatform;
  metrics: SocialMetricValue[];
  posts?: SocialPostObservation[];
}

/**
 * MY:TIME own-brand social via the OFFICIAL Meta Graph API (Step F) — not the
 * public scraper. Reads the IG Business account + the FB Page with the
 * non-expiring Page token. Returns the same metric shapes as competitors so
 * MY:TIME lines up in social_benchmark.
 */
export async function collectOwnBrandMeta(): Promise<OwnBrandSocialResult[]> {
  const out: OwnBrandSocialResult[] = [];

  const igId = optionalEnv("META_IG_USER_ID");
  if (igId) {
    const ig = await graphGet(igId, "followers_count,follows_count,media_count");
    const m: SocialMetricValue[] = [];
    if (typeof ig.followers_count === "number")
      m.push({ metric: "followers", value: ig.followers_count });
    if (typeof ig.follows_count === "number")
      m.push({ metric: "following", value: ig.follows_count });
    if (typeof ig.media_count === "number") m.push({ metric: "posts", value: ig.media_count });
    const posts: SocialPostObservation[] = [];
    try {
      const mediaRes = await graphGet(
        `${igId}/media`,
        "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
      );
      const media = Array.isArray((mediaRes as { data?: unknown[] }).data)
        ? (mediaRes as { data: Record<string, unknown>[] }).data.slice(0, 25)
        : [];
      for (const post of media) {
        const reach = await graphInsight(String(post.id), "reach");
        const likes = typeof post.like_count === "number" ? post.like_count : null;
        const comments = typeof post.comments_count === "number" ? post.comments_count : null;
        const isVideo = String(post.media_type ?? "")
          .toUpperCase()
          .includes("VIDEO");
        posts.push({
          externalPostId: String(post.id),
          postedAt: (post.timestamp as string) ?? null,
          postType: isVideo ? "video" : "image",
          caption: (post.caption as string) ?? null,
          permalink: (post.permalink as string) ?? null,
          mediaUrl: (post.media_url as string) ?? (post.thumbnail_url as string) ?? null,
          mediaUrls: null,
          likes,
          comments,
          shares: null,
          views: null,
          engagement: likes === null && comments === null ? null : (likes ?? 0) + (comments ?? 0),
          estimatedReach: reach,
          reachSource: reach != null ? "measured" : null,
        });
      }
    } catch {
      // media/insights unavailable for some accounts/media types — metrics still write.
    }
    if (m.length || posts.length) out.push({ platform: "instagram", metrics: m, posts });
  }

  const pageId = optionalEnv("META_PAGE_ID");
  if (pageId) {
    const fb = await graphGet(pageId, "followers_count,fan_count");
    const m: SocialMetricValue[] = [];
    if (typeof fb.followers_count === "number")
      m.push({ metric: "followers", value: fb.followers_count });
    if (typeof fb.fan_count === "number") m.push({ metric: "likes", value: fb.fan_count });
    if (m.length) out.push({ platform: "facebook", metrics: m });
  }

  return out;
}
