import { type Browser, chromium } from "playwright";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CHALLENGE_RE =
  /just a moment|attention required|checking your browser|verifying you are human/i;

export interface CloudflareSession {
  /** Navigate to `url` and return the response body (JSON for Store-API endpoints). */
  fetchText(url: string): Promise<string>;
  /** Close the browser. Always call in a finally. */
  close(): Promise<void>;
}

/**
 * Open a headless-Chromium session that has passed the Cloudflare JS challenge for `origin`.
 *
 * Some sites (watch-club) sit behind Cloudflare's managed challenge: plain fetch — and even an
 * in-page `fetch()` to the Store REST API — gets a "Just a moment…" 403. But a real browser
 * solves the challenge once on the homepage, and thereafter a *top-level navigation* to an API
 * URL returns clean JSON (the cf_clearance cookie rides along). We drive that here.
 *
 * Calls are serialized (a single page/tab) so concurrent callers queue safely.
 */
export async function openCloudflareSession(origin: string): Promise<CloudflareSession> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });
  const context = await browser.newContext({
    userAgent: BROWSER_UA,
    locale: "mk-MK",
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();

  const waitForClear = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      const title = await page.title().catch(() => "");
      if (title && !CHALLENGE_RE.test(title)) return;
      await page.waitForTimeout(2000);
    }
  };

  // Solve the challenge once on the origin homepage to obtain the clearance cookie.
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForClear();

  const doFetch = async (url: string): Promise<string> => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (resp && resp.status() === 200) {
        const body = await resp.text();
        // A real API response is JSON/text; an HTML doc here means a challenge page.
        if (!/^\s*<(?:!doctype|html)/i.test(body)) return body;
      }
      // Re-challenged → let Cloudflare auto-clear, then read the rendered body text.
      await waitForClear();
      const rendered = await page.innerText("body").catch(() => "");
      if (rendered && !CHALLENGE_RE.test(rendered)) return rendered;
      await page.waitForTimeout(2000 * attempt);
    }
    throw new Error(`Cloudflare kept challenging ${url}`);
  };

  // Serialize navigations — one page/tab can't be in two places at once.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    fetchText(url: string): Promise<string> {
      const run = chain.then(() => doFetch(url));
      chain = run.catch(() => undefined);
      return run;
    },
    async close(): Promise<void> {
      await browser.close().catch(() => undefined);
    },
  };
}
