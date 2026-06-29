import { requireEnv } from "@mytime/shared";

export interface FetchedPage {
  url: string;
  html: string;
  markdown: string;
}

/** Fetch a fully-rendered page once via FireCrawl /scrape (html + markdown). */
export async function fetchLive(url: string): Promise<FetchedPage> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireEnv("FIRECRAWL_API_KEY")}`,
    },
    body: JSON.stringify({ url, formats: ["html", "markdown"], onlyMainContent: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`FireCrawl scrape HTTP ${res.status} for ${url}`);
  const json = (await res.json()) as { data?: { html?: string; markdown?: string } };
  return { url, html: json.data?.html ?? "", markdown: json.data?.markdown ?? "" };
}
