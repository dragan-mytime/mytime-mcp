import type { SocialMetricValue } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
} from "./_social.js";

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
      resultsPerPage: 1,
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
      return am ? [{ targetId: a.targetId, metrics: metrics(am) }] : [];
    });
  },
};
