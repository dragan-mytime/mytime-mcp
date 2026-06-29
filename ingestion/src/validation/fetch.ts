export interface FetchedPage {
  url: string;
  html: string;
  markdown: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Fetch the raw server-rendered HTML (no JS) so prices stay in the site's
 *  native currency (MKD). FireCrawl's JS render switches some sites to EUR. */
export async function fetchLive(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "mk,en;q=0.8" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`fetch HTTP ${res.status} for ${url}`);
  const html = await res.text();
  // crude text extraction for the optional LLM drift check
  const markdown = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { url, html, markdown };
}
