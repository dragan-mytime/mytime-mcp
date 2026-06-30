import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
} from "./_social.js";
import { estimateReach } from "./reach.js";

interface TtAuthor {
  name?: string;
  fans?: number;
  following?: number;
  heart?: number;
  video?: number;
}
interface TtItem {
  authorMeta?: TtAuthor;
}

interface TtVideo {
  id?: string;
  text?: string;
  createTimeISO?: string;
  webVideoUrl?: string;
  videoMeta?: { coverUrl?: string };
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  authorMeta?: { name?: string; fans?: number };
}

/** Map a TikTok author's video items → posts (TikTok is video-first, so reach = views). */
export function mapTtPosts(items: TtVideo[], handle: string): SocialPostObservation[] {
  const mine = items.filter((it) => it.authorMeta?.name?.toLowerCase() === handle.toLowerCase());
  const followers = mine[0]?.authorMeta?.fans ?? null;
  return mine.flatMap((it) => {
    if (!it.id) return [];
    const likes = it.diggCount ?? null;
    const comments = it.commentCount ?? null;
    const shares = it.shareCount ?? null;
    const views = it.playCount ?? null;
    // null only when no interaction data at all.
    const engagement =
      likes === null && comments === null && shares === null
        ? null
        : (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
    const { reach, source } = estimateReach("tiktok", views, followers);
    return [
      {
        externalPostId: String(it.id),
        postedAt: it.createTimeISO ?? null,
        postType: "video",
        caption: it.text ?? null,
        permalink: it.webVideoUrl ?? null,
        mediaUrl: it.videoMeta?.coverUrl ?? null,
        mediaUrls: null,
        likes,
        comments,
        shares,
        views,
        engagement,
        estimatedReach: reach,
        reachSource: source,
      },
    ];
  });
}

function metrics(a: TtAuthor): SocialMetricValue[] {
  const out: SocialMetricValue[] = [];
  if (typeof a.fans === "number") out.push({ metric: "followers", value: a.fans });
  if (typeof a.following === "number") out.push({ metric: "following", value: a.following });
  if (typeof a.video === "number") out.push({ metric: "posts", value: a.video });
  if (typeof a.heart === "number") out.push({ metric: "likes_total", value: a.heart });
  return out;
}

/** TikTok public metrics via clockworks/tiktok-profile-scraper. */
export const tiktokCollector: SocialCollector = {
  id: "apify-tiktok",
  platform: "tiktok",
  async collect(accounts: SocialAccountRef[]): Promise<SocialResult[]> {
    if (accounts.length === 0) return [];
    const items = await apifyRun<TtItem>("clockworks~tiktok-profile-scraper", {
      profiles: accounts.map((a) => a.handle),
      resultsPerPage: 15,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
    });
    const byUser = new Map<string, TtAuthor>();
    for (const it of items) {
      if (it.authorMeta?.name) byUser.set(it.authorMeta.name.toLowerCase(), it.authorMeta);
    }
    return accounts.flatMap((a) => {
      const am = byUser.get(a.handle.toLowerCase());
      return am
        ? [
            {
              targetId: a.targetId,
              metrics: metrics(am),
              posts: mapTtPosts(items as TtVideo[], a.handle),
            },
          ]
        : [];
    });
  },
};
