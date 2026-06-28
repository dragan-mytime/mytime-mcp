import type { SocialMetricValue } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
} from "./_social.js";

interface IgPost {
  likesCount?: number;
  commentsCount?: number;
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
    const now = Date.now();
    const recent = posts.filter((x) => {
      const t = Date.parse(x.timestamp ?? "");
      return Number.isFinite(t) && now - t < 30 * 86_400_000;
    }).length;
    out.push({ metric: "posts_30d", value: recent });
  }
  return out;
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
      return it ? [{ targetId: a.targetId, metrics: metrics(it) }] : [];
    });
  },
};
