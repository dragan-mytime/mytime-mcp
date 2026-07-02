import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
  toDateOrNull,
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
  facebookUrl?: string; // posts scraper may echo the page URL here
  pageUrl?: string; // alt field for page URL
  facebookId?: string; // numeric page id (apify~facebook-posts-scraper)
  pageName?: string;
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

/**
 * FB path segments that are routing keywords, never page handles. A post URL
 * like /pagename/posts/123 contains "posts"; matching must skip these so a
 * keyword is never mistaken for a handle (and vice versa).
 */
const FB_PATH_KEYWORDS = new Set([
  "posts",
  "videos",
  "photos",
  "photo",
  "photo.php",
  "reel",
  "reels",
  "permalink.php",
  "story.php",
  "profile.php",
  "watch",
  "share",
  "events",
  "groups",
  "p",
]);

/** Lowercased path segments of an FB URL (any subdomain), or [] if unparseable. */
function fbPathSegments(raw: string): string[] {
  try {
    return new URL(raw).pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * True when `handle` appears as an EXACT path segment of the URL (A7).
 * Never substring matching — "page" must not match /pagename/posts/1 — and FB
 * routing keywords are never treated as handles.
 */
export function urlMatchesHandle(raw: string, handle: string): boolean {
  if (!handle || FB_PATH_KEYWORDS.has(handle)) return false;
  return fbPathSegments(raw).some((seg) => seg === handle && !FB_PATH_KEYWORDS.has(seg));
}

/**
 * Normalize a FB post URL used as an external id: canonical host, no query
 * params, no hash, no trailing slash. Avoids duplicate rows when the same post
 * appears with tracking params or m.facebook.com variants across runs (A8).
 */
export function normalizeFbPostUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Force canonical host regardless of m./l./touch. subdomains.
    u.hostname = "www.facebook.com";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}

/** Map FB page posts → posts. Total reactions (sum across types) becomes `likes`. */
export function mapFbPosts(items: FbPost[], followers: number | null): SocialPostObservation[] {
  return items.flatMap((it) => {
    // A8: prefer the stable postId; only fall back to a URL if there is no id,
    // and normalise the URL to prevent duplicates across tracking-param variants.
    const rawUrl = it.postUrl ?? it.url ?? null;
    const id = it.postId ?? (rawUrl ? normalizeFbPostUrl(rawUrl) : null);
    if (!id) {
      console.warn("[fb-mapper] dropping post with no id and no url");
      return [];
    }
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
        // A6: guard against locale-formatted or unparseable date strings.
        postedAt: toDateOrNull(it.time ?? it.timestamp ?? it.date ?? null)?.toISOString() ?? null,
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
    // A7: track unmatched page- and post-scraper items for logging.
    const unmatchedPageItems = new Set(items.map((_, idx) => idx));
    const unmatchedPostItems = new Set(postItems.map((_, idx) => idx));
    const results = accounts.flatMap((a) => {
      const handle = a.handle.toLowerCase();
      // A7: match a page item when the handle is an exact URL path segment of
      // any of its URL fields, or equals its pageName. NEVER positional index,
      // NEVER substring includes on the whole URL.
      const itIdx = items.findIndex((p) => {
        const fields = [p.pageUrl, p.facebookUrl, p.url].filter(Boolean) as string[];
        return (
          fields.some((f) => urlMatchesHandle(f, handle)) || p.pageName?.toLowerCase() === handle
        );
      });
      const it = itIdx >= 0 ? items[itIdx] : undefined;
      if (it !== undefined) unmatchedPageItems.delete(itIdx);

      // A7: match posts by the actor's echoed page identifier (facebookId /
      // pageName) or by the handle appearing as an exact path segment of any
      // URL field (covers /pagename/posts/123 and page-URL echoes). Numeric
      // permalink.php URLs have no handle segment → unmatched → logged below.
      const acctPosts: FbPost[] = [];
      postItems.forEach((p, idx) => {
        const byEcho =
          (p.facebookId && p.facebookId.toLowerCase() === handle) ||
          p.pageName?.toLowerCase() === handle;
        const urlFields = [p.facebookUrl, p.pageUrl, p.postUrl, p.url].filter(Boolean) as string[];
        if (byEcho || urlFields.some((f) => urlMatchesHandle(f, handle))) {
          acctPosts.push(p);
          unmatchedPostItems.delete(idx);
        }
      });

      const followers = it
        ? (metrics(it).find((mm) => mm.metric === "followers")?.value ?? null)
        : null;
      return it
        ? [{ targetId: a.targetId, metrics: metrics(it), posts: mapFbPosts(acctPosts, followers) }]
        : [];
    });

    if (unmatchedPageItems.size > 0) {
      console.warn(
        `[fb-collector] ${unmatchedPageItems.size} page-scraper items could not be matched to any account:`,
        [...unmatchedPageItems]
          .map((i) => {
            const p = items[i];
            return p ? fbFields(p) : "?";
          })
          .join("; "),
      );
    }
    if (unmatchedPostItems.size > 0) {
      console.warn(
        `[fb-collector] ${unmatchedPostItems.size} post-scraper items could not be matched to any account:`,
        [...unmatchedPostItems]
          .map((i) => {
            const p = postItems[i];
            return p ? (p.postUrl ?? p.url ?? p.postId ?? "?") : "?";
          })
          .join("; "),
      );
    }

    return results;
  },
};
