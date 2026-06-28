import type { SocialMetricValue } from "@mytime/shared";
import {
  apifyRun,
  type SocialAccountRef,
  type SocialCollector,
  type SocialResult,
} from "./_social.js";

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

/** Facebook page public metrics via apify/facebook-pages-scraper. */
export const facebookCollector: SocialCollector = {
  id: "apify-facebook",
  platform: "facebook",
  async collect(accounts: SocialAccountRef[]): Promise<SocialResult[]> {
    if (accounts.length === 0) return [];
    const items = await apifyRun<FbPage>("apify~facebook-pages-scraper", {
      startUrls: accounts.map((a) => ({ url: a.url })),
    });
    return accounts.flatMap((a, i) => {
      const handle = a.handle.toLowerCase();
      // Match by handle in any URL/name field; fall back to positional match.
      const it =
        items.find((p) => fbFields(p).includes(handle)) ??
        (items.length === accounts.length ? items[i] : undefined);
      return it ? [{ targetId: a.targetId, metrics: metrics(it) }] : [];
    });
  },
};
