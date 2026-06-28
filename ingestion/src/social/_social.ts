import { requireEnv, type SocialMetricValue, type SocialPlatform } from "@mytime/shared";

/** A competitor social account to collect public metrics for. */
export interface SocialAccountRef {
  targetId: string;
  platform: SocialPlatform;
  url: string;
  handle: string;
}

/** Per-account result: the public metrics observed. */
export interface SocialResult {
  targetId: string;
  metrics: SocialMetricValue[];
}

/**
 * One collector per platform. Apify actors take a batch of handles, so collect()
 * runs ONE actor call for all of a platform's accounts. Public metrics only —
 * never private insights (brief §4).
 */
export interface SocialCollector {
  readonly id: string;
  readonly platform: SocialPlatform;
  collect(accounts: SocialAccountRef[]): Promise<SocialResult[]>;
}

/** Extract the platform handle from a profile URL. */
export function extractHandle(platform: SocialPlatform, url: string): string {
  const last = url.split("?")[0]?.replace(/\/+$/, "").split("/").pop() ?? "";
  return platform === "tiktok" ? last.replace(/^@/, "") : last;
}

/** Run an Apify actor synchronously and return its dataset items. */
export async function apifyRun<T = Record<string, unknown>>(
  actor: string,
  input: unknown,
): Promise<T[]> {
  const token = requireEnv("APIFY_TOKEN");
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(300_000),
    },
  );
  if (!res.ok) throw new Error(`Apify ${actor} HTTP ${res.status}`);
  return (await res.json()) as T[];
}
