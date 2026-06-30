import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
} from "./_social.js";
import { estimateReach } from "./reach.js";

interface IgPost {
  id?: string;
  shortCode?: string;
  caption?: string;
  url?: string;
  displayUrl?: string;
  images?: string[];
  type?: string; // Image | Video | Sidecar
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  timestamp?: string;
}
interface IgProfile {
  username?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  latestPosts?: IgPost[];
}

function metrics(p: IgProfile): SocialMetricValue[] {
  const out: SocialMetricValue[] = [];
  if (typeof p.followersCount === "number")
    out.push({ metric: "followers", value: p.followersCount });
  if (typeof p.followsCount === "number") out.push({ metric: "following", value: p.followsCount });
  if (typeof p.postsCount === "number") out.push({ metric: "posts", value: p.postsCount });

  const posts = Array.isArray(p.latestPosts) ? p.latestPosts : [];
  if (posts.length) {
    const eng = posts.map((x) => (x.likesCount ?? 0) + (x.commentsCount ?? 0));
    out.push({
      metric: "avg_post_engagement",
      value: Math.round(eng.reduce((a, b) => a + b, 0) / eng.length),
    });
    if (typeof p.followersCount === "number" && p.followersCount > 0) {
      const avgEng = eng.reduce((a, b) => a + b, 0) / eng.length;
      out.push({
        metric: "avg_engagement_rate",
        value: Math.round((avgEng / p.followersCount) * 1000) / 10,
      });
    }
    const now = Date.now();
    const recent = posts.filter((x) => {
      const t = Date.parse(x.timestamp ?? "");
      return Number.isFinite(t) && now - t < 30 * 86_400_000;
    }).length;
    out.push({ metric: "posts_30d", value: recent });
  }
  return out;
}

const IG_TYPE: Record<string, string> = { Image: "image", Video: "video", Sidecar: "carousel" };

/** Map an IG profile's latestPosts → SocialPostObservation[] (reach uses views or followers). */
export function mapIgPosts(p: {
  followersCount?: number;
  latestPosts?: IgPost[];
}): SocialPostObservation[] {
  const followers = typeof p.followersCount === "number" ? p.followersCount : null;
  return (p.latestPosts ?? []).flatMap((post) => {
    const id = post.shortCode ?? post.id;
    if (!id) return [];
    const likes = post.likesCount ?? null;
    const comments = post.commentsCount ?? null;
    const views = post.videoViewCount ?? null;
    const engagement = (likes ?? 0) + (comments ?? 0);
    const { reach, source } = estimateReach("instagram", views, followers);
    return [
      {
        externalPostId: String(id),
        postedAt: post.timestamp ?? null,
        postType: IG_TYPE[post.type ?? ""] ?? null,
        caption: post.caption ?? null,
        permalink: post.url ?? null,
        mediaUrl: post.displayUrl ?? null,
        mediaUrls: Array.isArray(post.images) ? post.images : null,
        likes,
        comments,
        shares: null,
        views,
        engagement,
        estimatedReach: reach,
        reachSource: source,
      },
    ];
  });
}

/** Instagram public metrics via apify/instagram-profile-scraper. */
export const instagramCollector: SocialCollector = {
  id: "apify-instagram",
  platform: "instagram",
  async collect(accounts: SocialAccountRef[]): Promise<SocialResult[]> {
    if (accounts.length === 0) return [];
    const items = await apifyRun<IgProfile>("apify~instagram-profile-scraper", {
      usernames: accounts.map((a) => a.handle),
    });
    const byUser = new Map(
      items.filter((i) => i.username).map((i) => [String(i.username).toLowerCase(), i]),
    );
    return accounts.flatMap((a) => {
      const it = byUser.get(a.handle.toLowerCase());
      return it ? [{ targetId: a.targetId, metrics: metrics(it), posts: mapIgPosts(it) }] : [];
    });
  },
};
