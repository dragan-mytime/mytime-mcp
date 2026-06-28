import {
  optionalEnv,
  requireEnv,
  type SocialMetricValue,
  type SocialPlatform,
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

export interface OwnBrandSocialResult {
  platform: SocialPlatform;
  metrics: SocialMetricValue[];
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
    if (m.length) out.push({ platform: "instagram", metrics: m });
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
