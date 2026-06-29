import type { AdObservation } from "@mytime/shared";
import { logger } from "@mytime/shared";
import { apifyRun } from "../social/_social.js";
import { fixEncoding } from "./decode.js";

const ACTOR = "apify~facebook-ads-scraper";

interface AdItem {
  adArchiveID?: string | number;
  isActive?: boolean;
  startDate?: number;
  startDateFormatted?: string;
  publisherPlatform?: string[];
  inputUrl?: string;
  snapshot?: {
    linkUrl?: string | null;
    ctaType?: string | null;
    title?: string | null;
    caption?: string | null;
    body?: { text?: string | null } | null;
    displayFormat?: string | null;
    images?: Record<string, string>[];
    videos?: Record<string, string>[];
    cards?: Record<string, string>[];
  } | null;
}

const firstMedia = (s: AdItem["snapshot"]): string | null => {
  if (!s) return null;
  const v = s.videos?.[0];
  if (v) return v.videoHdUrl ?? v.videoSdUrl ?? null;
  const i = s.images?.[0];
  if (i) return i.originalImageUrl ?? i.resizedImageUrl ?? null;
  const c = s.cards?.[0];
  if (c) return c.originalImageUrl ?? c.resizedImageUrl ?? c.videoSdUrl ?? null;
  return null;
};

export function mapAdItems(raw: unknown[], runDate: string): AdObservation[] {
  const out: AdObservation[] = [];
  for (const item of raw as AdItem[]) {
    if (!item?.adArchiveID || item.isActive === false) continue;
    const id = String(item.adArchiveID);
    out.push({
      adArchiveId: id,
      startedRunningDate: item.startDateFormatted?.slice(0, 10) ?? null,
      daysRunning:
        typeof item.startDate === "number"
          ? Math.max(
              0,
              Math.floor((Date.parse(`${runDate}T00:00:00Z`) - item.startDate * 1000) / 86_400_000),
            )
          : null,
      platforms: (item.publisherPlatform ?? [])
        .map((p) => p.toLowerCase())
        .filter((p) => p === "facebook" || p === "instagram"),
      ctaType: item.snapshot?.ctaType ?? null,
      linkUrl: item.snapshot?.linkUrl ?? null,
      adTitle: fixEncoding(item.snapshot?.title ?? item.snapshot?.caption ?? null),
      adBody: fixEncoding(item.snapshot?.body?.text ?? null),
      mediaType: item.snapshot?.displayFormat ?? null,
      mediaUrl: firstMedia(item.snapshot),
      snapshotUrl: `https://www.facebook.com/ads/library/?id=${id}`,
    });
  }
  return out;
}

/** Scrape active ads for competitor FB page URLs (one batched run), grouped by target. */
export async function collectCompetitorAds(
  pages: { targetId: string; url: string }[],
  runDate: string,
  resultsLimit = 50,
): Promise<Map<string, AdObservation[]>> {
  const byTarget = new Map<string, AdObservation[]>();
  for (const p of pages) byTarget.set(p.targetId, []);
  if (pages.length === 0) return byTarget;
  const raw = await apifyRun<{ inputUrl?: string }>(ACTOR, {
    startUrls: pages.map((p) => ({ url: p.url })),
    resultsLimit,
    activeStatus: "active",
  });
  const urlToTarget = new Map(pages.map((p) => [p.url, p.targetId]));
  const grouped = new Map<string, unknown[]>();
  for (const item of raw) {
    const u = item.inputUrl ?? "";
    const arr = grouped.get(u) ?? [];
    arr.push(item);
    grouped.set(u, arr);
  }
  for (const [u, items] of grouped) {
    const tid = urlToTarget.get(u);
    if (tid) byTarget.set(tid, mapAdItems(items, runDate));
  }
  logger.info(
    { pages: pages.length, ads: [...byTarget.values()].reduce((n, a) => n + a.length, 0) },
    "competitor ads scraped",
  );
  return byTarget;
}
