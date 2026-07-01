import {
  optionalEnv,
  requireEnv,
  type SocialMetricValue,
  type SocialPlatform,
  type SocialPostObservation,
} from "@mytime/shared";
import { estimateReach } from "./reach.js";

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

/** Like graphInsight but returns the value as an OBJECT (e.g. post_activity_by_action_type). */
async function graphInsightObj(id: string, metric: string): Promise<Record<string, number> | null> {
  const token = requireEnv("META_ACCESS_TOKEN");
  const url = `${GRAPH}/${id}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as {
    data?: { values?: { value?: unknown }[] }[];
    error?: unknown;
  };
  if (json.error) return null;
  const v = json.data?.[0]?.values?.[0]?.value;
  return v && typeof v === "object" ? (v as Record<string, number>) : null;
}

/** FB organic engagement from post_activity_by_action_type → the competitor field shape. */
export function mapFbActions(
  acts: Record<string, number>,
  followers: number | null,
): {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  engagement: number | null;
  estimatedReach: number | null;
  reachSource: string | null;
} {
  const g = (k: string) => (typeof acts[k] === "number" ? acts[k] : null);
  const likes = g("like");
  const comments = g("comment");
  const shares = g("share");
  const engagement =
    likes === null && comments === null && shares === null
      ? null
      : (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
  const { reach, source } = estimateReach("facebook", null, followers); // FB post reach retired in v23
  return { likes, comments, shares, engagement, estimatedReach: reach, reachSource: source };
}

/** IG own post: measured reach when insights are permitted, else the followers-benchmark estimate. */
export function mapIgOwnPost(
  post: {
    id: string;
    caption?: string;
    media_type?: string;
    media_url?: string;
    thumbnail_url?: string;
    permalink?: string;
    timestamp?: string;
    like_count?: number;
    comments_count?: number;
  },
  ins: { reach: number | null; views: number | null; shares: number | null },
  followers: number | null,
): SocialPostObservation {
  const likes = typeof post.like_count === "number" ? post.like_count : null;
  const comments = typeof post.comments_count === "number" ? post.comments_count : null;
  const shares = ins.shares;
  const isVideo = String(post.media_type ?? "")
    .toUpperCase()
    .includes("VIDEO");
  const engagement =
    likes === null && comments === null && shares === null
      ? null
      : (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
  const measured = ins.reach != null;
  const est = estimateReach("instagram", ins.views, followers);
  return {
    externalPostId: String(post.id),
    postedAt: post.timestamp ?? null,
    postType: isVideo ? "video" : "image",
    caption: post.caption ?? null,
    permalink: post.permalink ?? null,
    mediaUrl: post.media_url ?? post.thumbnail_url ?? null,
    mediaUrls: null,
    likes,
    comments,
    shares,
    views: ins.views,
    engagement,
    estimatedReach: measured ? ins.reach : est.reach,
    reachSource: measured ? "measured" : est.source,
  };
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
    const igFollowers = typeof ig.followers_count === "number" ? ig.followers_count : null;
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
        const ins = {
          reach: await graphInsight(String(post.id), "reach"),
          views: await graphInsight(String(post.id), "views"),
          shares: await graphInsight(String(post.id), "shares"),
        };
        posts.push(mapIgOwnPost(post as never, ins, igFollowers));
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
    const fbPosts: SocialPostObservation[] = [];
    try {
      const res = await graphGet(
        `${pageId}/published_posts`,
        "id,message,created_time,permalink_url,full_picture",
      );
      const items = Array.isArray((res as { data?: unknown[] }).data)
        ? (res as { data: Record<string, unknown>[] }).data.slice(0, 25)
        : [];
      const fbFollowers = typeof fb.followers_count === "number" ? fb.followers_count : null;
      for (const post of items) {
        const acts = (await graphInsightObj(String(post.id), "post_activity_by_action_type")) ?? {};
        const e = mapFbActions(acts, fbFollowers);
        fbPosts.push({
          externalPostId: String(post.id),
          postedAt: (post.created_time as string) ?? null,
          postType: "image",
          caption: (post.message as string) ?? null,
          permalink: (post.permalink_url as string) ?? null,
          mediaUrl: (post.full_picture as string) ?? null,
          mediaUrls: null,
          likes: e.likes,
          comments: e.comments,
          shares: e.shares,
          views: null,
          engagement: e.engagement,
          estimatedReach: e.estimatedReach,
          reachSource: e.reachSource,
        });
      }
    } catch {
      // published_posts/insights unavailable — page metrics still write.
    }
    if (m.length || fbPosts.length) out.push({ platform: "facebook", metrics: m, posts: fbPosts });
  }

  return out;
}
