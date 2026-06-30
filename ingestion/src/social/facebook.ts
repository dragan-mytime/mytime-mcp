import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
} from "./_social.js";
import { estimateReach } from "./reach.js";

interface FbPage {
  likes?: number;
  followers?: number;
  pageUrl?: string;
  facebookUrl?: string;
  url?: string;
  pageName?: string;
}

function metrics(p: FbPage): SocialMetricValue[] {
  const out: SocialMetricValue[] = [];
  if (typeof p.followers === "number") out.push({ metric: "followers", value: p.followers });
  if (typeof p.likes === "number") out.push({ metric: "likes", value: p.likes });
  return out;
}

const fbFields = (p: FbPage): string =>
  `${p.pageUrl ?? ""} ${p.facebookUrl ?? ""} ${p.url ?? ""} ${p.pageName ?? ""}`.toLowerCase();

interface FbPost {
  postId?: string;
  postUrl?: string;
  url?: string;
  text?: string;
  message?: string;
  time?: string;
  timestamp?: string;
  date?: string;
  likes?: number;
  reactionsCount?: number;
  reactions?: Record<string, number>;
  comments?: number;
  commentsCount?: number;
  shares?: number;
  sharesCount?: number;
  media?: { thumbnail?: string; image?: string; url?: string }[];
  video?: boolean;
}

const num = (...xs: (number | undefined)[]): number | null => {
  for (const x of xs) if (typeof x === "number") return x;
  return null;
};

/** Map FB page posts → posts. Total reactions (sum across types) becomes `likes`. */
export function mapFbPosts(items: FbPost[], followers: number | null): SocialPostObservation[] {
  return items.flatMap((it) => {
    const id = it.postId ?? it.postUrl ?? it.url;
    if (!id) return [];
    const reactions =
      it.reactionsCount ??
      (it.reactions ? Object.values(it.reactions).reduce((a, b) => a + (b ?? 0), 0) : undefined);
    const likes = num(reactions, it.likes);
    const comments = num(it.commentsCount, it.comments);
    const shares = num(it.sharesCount, it.shares);
    const media = it.media?.find((m) => m.thumbnail || m.image || m.url);
    const mediaUrl = media?.thumbnail ?? media?.image ?? media?.url ?? null;
    // null only when no interaction data at all.
    const engagement =
      likes === null && comments === null && shares === null
        ? null
        : (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
    const { reach, source } = estimateReach("facebook", null, followers);
    return [
      {
        externalPostId: String(id),
        postedAt: it.time ?? it.timestamp ?? it.date ?? null,
        postType: it.video ? "video" : "image",
        caption: it.text ?? it.message ?? null,
        permalink: it.postUrl ?? it.url ?? null,
        mediaUrl,
        mediaUrls: null,
        likes,
        comments,
        shares,
        views: null,
        engagement,
        estimatedReach: reach,
        reachSource: source,
      },
    ];
  });
}

/** Facebook page public metrics via apify/facebook-pages-scraper. */
export const facebookCollector: SocialCollector = {
  id: "apify-facebook",
  platform: "facebook",
  async collect(accounts: SocialAccountRef[]): Promise<SocialResult[]> {
    if (accounts.length === 0) return [];
    const items = await apifyRun<FbPage>("apify~facebook-pages-scraper", {
      startUrls: accounts.map((a) => ({ url: a.url })),
    });
    let postItems: FbPost[] = [];
    try {
      postItems = await apifyRun<FbPost>("apify~facebook-posts-scraper", {
        startUrls: accounts.map((a) => ({ url: a.url })),
        resultsLimit: 15,
      });
    } catch {
      // Posts scraper failure is non-fatal; page metrics still write.
    }
    return accounts.flatMap((a, i) => {
      const handle = a.handle.toLowerCase();
      // Match by handle in any URL/name field; fall back to positional match.
      const it =
        items.find((p) => fbFields(p).includes(handle)) ??
        (items.length === accounts.length ? items[i] : undefined);
      const acctPosts = postItems.filter((p) =>
        `${p.postUrl ?? ""} ${p.url ?? ""}`.toLowerCase().includes(handle),
      );
      const followers = it
        ? (metrics(it).find((mm) => mm.metric === "followers")?.value ?? null)
        : null;
      return it
        ? [{ targetId: a.targetId, metrics: metrics(it), posts: mapFbPosts(acctPosts, followers) }]
        : [];
    });
  },
};
