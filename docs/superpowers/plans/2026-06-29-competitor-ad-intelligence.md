# Competitor Ad Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capture each competitor's currently-running Meta ads (creatives, copy, platforms, longevity, landing pages) daily via Apify, store as a time-series, and expose a `competitor_ads` MCP tool.

**Architecture:** A new ad collector reuses the existing Apify plumbing (`ingestion/src/social/_social.ts` `apifyRun`) to call `apify/facebook-ads-scraper` with competitor Facebook Page URLs (no Page-ID resolution needed — the actor resolves pages from their URLs). Active ads are mapped to `AdObservation`s and written idempotently to a new `ad_observations` table, in a new daily phase in `ingestion/src/index.ts`. A `competitor_ads` MCP tool reads derived metrics (active count, longevity, new ads, landing pages).

**Tech Stack:** Node 24/TS 6 (ESM/NodeNext), Drizzle, Vitest, Biome. Apify (`APIFY_TOKEN`, already set). Actor `apify/facebook-ads-scraper` (call as `apify~facebook-ads-scraper`).

---

## Verified facts (captured live during planning)

- **Targeting:** the actor's `startUrls` accept a **Facebook Page URL directly** (we have all 8 competitor FB URLs in `config/targets.json` under `social.facebook`). Input: `{ startUrls: [{url}], resultsLimit, activeStatus: "active" }`. No Page-ID lookup.
- **Output:** `run-sync-get-dataset-items` returns a flat array mixing two item shapes:
  - **page-summary** items (when a page has 0 active ads): have `totalCount`/`pageInfo`, **no `adArchiveID`**.
  - **ad** items: have `adArchiveID` (string), `isActive` (bool), `startDate` (unix seconds) + `startDateFormatted` (ISO), `endDateFormatted`, `publisherPlatform` (e.g. `["FACEBOOK","INSTAGRAM",...]`), `pageName`, and a `snapshot` object.
  - `snapshot`: `linkUrl`, `ctaType` (e.g. `SHOP_NOW`), `ctaText`, `title`, `caption`, `body.text` (ad copy), `displayFormat` (e.g. `DPA`/`IMAGE`/`VIDEO`), `images[]`, `videos[]`, `cards[]` (carousel/DPA), `pageLikeCount`.
  - **`spend`, `reachEstimate`, impressions are `null`** (no performance data for MK commercial ads — by design).
- **Feasibility confirmed:** saat-saat, b-watch, watch-club have active ads; bozinovski/hronometar/swarovski/zia currently have 0 (valid — store nothing).
- **Cyrillic `snapshot.body.text` is mojibake** (UTF-8 bytes mis-decoded as cp1251). Needs a decode step (Task 5).
- A real captured output is saved at `ingestion/test/ads/fixtures/facebook-ads-sample.json` (use it as the test fixture).

## File structure

```
shared/src/ad.ts                 # AdObservation type (collector→writer contract)
db/src/schema.ts                 # + ad_observations table
db/                              # + generated migration
db/src/writers.ts                # + writeAdObservations
ingestion/src/ads/meta-ads.ts    # collector: apifyRun + map output -> AdObservation[]
ingestion/src/ads/decode.ts      # fixEncoding() mojibake helper
ingestion/src/index.ts           # + ad phase (daily)
mcp-server/src/analytics.ts      # + competitorAds()
mcp-server/src/tools/index.ts    # + competitor_ads tool
ingestion/test/ads/*.test.ts     # mapping + decode tests (fixture-based)
```

---

## Task 1: `AdObservation` type

**Files:** Create `shared/src/ad.ts`; export it from `shared/src/index.ts`.

- [ ] **Step 1:** Create `shared/src/ad.ts`:
```ts
/** One competitor ad observed in the Meta Ad Library during one run. */
export interface AdObservation {
  adArchiveId: string;
  startedRunningDate: string | null; // YYYY-MM-DD
  daysRunning: number | null;
  platforms: string[]; // e.g. ["facebook","instagram"]
  ctaType: string | null;
  linkUrl: string | null;
  adTitle: string | null;
  adBody: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  snapshotUrl: string | null;
}
```
- [ ] **Step 2:** Add `export * from "./ad.js";` to `shared/src/index.ts`.
- [ ] **Step 3:** `corepack pnpm --filter @mytime/shared build` → clean.
- [ ] **Step 4:** Commit: `git add shared/src && git commit -m "feat(shared): AdObservation type"`

---

## Task 2: `ad_observations` schema + migration

**Files:** Modify `db/src/schema.ts`; generate a migration.

- [ ] **Step 1:** Add to `db/src/schema.ts` (follow the `socialMetrics` style — `pgTable` + `uniqueIndex` + `index`; reuse existing imports `pgTable,text,date,integer,timestamp,uuid,uniqueIndex,index`):
```ts
export const adObservations = pgTable(
  "ad_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    adArchiveId: text("ad_archive_id").notNull(),
    capturedDate: date("captured_date").notNull(),
    startedRunningDate: date("started_running_date"),
    daysRunning: integer("days_running"),
    platforms: text("platforms").array(),
    ctaType: text("cta_type"),
    linkUrl: text("link_url"),
    adTitle: text("ad_title"),
    adBody: text("ad_body"),
    mediaType: text("media_type"),
    mediaUrl: text("media_url"),
    snapshotUrl: text("snapshot_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_observations_target_ad_date_uq").on(t.targetId, t.adArchiveId, t.capturedDate),
    index("ad_observations_target_date_idx").on(t.targetId, t.capturedDate),
  ],
);
```
Confirm `targets.id` is `text` (it is — other FKs use `text("...").references(() => targets.id)`). Add `export type AdObservationRow = typeof adObservations.$inferSelect;` near the other row-type exports.

- [ ] **Step 2:** `corepack pnpm --filter @mytime/db build` → clean.
- [ ] **Step 3:** Generate migration: `corepack pnpm db:generate` (creates `db/drizzle/00NN_*.sql`). Inspect it: it should `CREATE TABLE ad_observations` + the indexes, nothing else.
- [ ] **Step 4:** Apply to Supabase: `corepack pnpm db:migrate`. Verify: a quick `select count(*) from ad_observations` returns 0 (table exists).
- [ ] **Step 5:** Commit: `git add db && git commit -m "feat(db): ad_observations table + migration"`

---

## Task 3: mojibake decoder (TDD)

**Files:** Create `ingestion/src/ads/decode.ts`; test `ingestion/test/ads/decode.test.ts`.

- [ ] **Step 1:** Write the failing test. First, find a real `body.text` in the fixture and the expected readable Cyrillic. Run:
```
node -e "const d=require('./ingestion/test/ads/fixtures/facebook-ads-sample.json');const a=d.find(x=>x.adArchiveID&&x.snapshot?.body?.text);console.log(JSON.stringify(a.snapshot.body.text.slice(0,60)))"
```
Then write `decode.test.ts` asserting `fixEncoding(<raw mojibake from fixture>)` produces a string containing a known Macedonian word (determine it by eyeballing the decoded output while implementing — e.g. a word like "Сега"/"цена"/"попуст"). The test pins the exact raw→expected pair from the fixture.

- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Implement `ingestion/src/ads/decode.ts`. The text is UTF-8 bytes mis-decoded; reverse with a latin1 round-trip and fall back to the original if the result isn't valid:
```ts
/** Meta Ad Library copy comes back mojibake (UTF-8 read as latin1/cp1251).
 *  Reverse it; if the round-trip produces replacement chars, keep the original. */
export function fixEncoding(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const fixed = Buffer.from(s, "latin1").toString("utf8");
    if (fixed.includes("�")) return s;
    return fixed;
  } catch {
    return s;
  }
}
```
If the latin1 round-trip is insufficient (still garbled), try `Buffer.from(s, "binary")` or a cp1251 decode via `TextDecoder("windows-1251")` over the latin1 bytes — iterate against the fixture until the test's expected Cyrillic word appears. (Implementer: pick whichever reproduces readable Macedonian for the fixture sample.)

- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit: `git add ingestion/src/ads/decode.ts ingestion/test/ads/decode.test.ts && git commit -m "feat(ads): mojibake decoder for ad copy"`

---

## Task 4: ad output mapping (TDD against the fixture)

**Files:** Create `ingestion/src/ads/meta-ads.ts` (mapping fn + collector); test `ingestion/test/ads/meta-ads.test.ts`.

- [ ] **Step 1:** Write the failing test using the saved fixture:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapAdItems } from "../../src/ads/meta-ads.js";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/facebook-ads-sample.json", import.meta.url), "utf8"),
);

describe("mapAdItems", () => {
  it("keeps only active ad items (skips page-summary items)", () => {
    const ads = mapAdItems(raw, "2026-06-29");
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.every((a) => a.adArchiveId)).toBe(true);
  });
  it("extracts archive id, start date, platforms, link and cta", () => {
    const a = mapAdItems(raw, "2026-06-29").find((x) => x.linkUrl);
    expect(a).toBeDefined();
    expect(a?.startedRunningDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(a?.platforms)).toBe(true);
    expect(a?.snapshotUrl).toContain("ads/library");
  });
  it("computes non-negative days_running", () => {
    const a = mapAdItems(raw, "2026-06-29").find((x) => x.daysRunning != null);
    expect(a?.daysRunning).toBeGreaterThanOrEqual(0);
  });
});
```
- [ ] **Step 2:** Run → FAIL (`mapAdItems` not defined).
- [ ] **Step 3:** Implement `ingestion/src/ads/meta-ads.ts`:
```ts
import type { AdObservation, Target } from "@mytime/shared";
import { logger } from "@mytime/shared";
import { apifyRun } from "../social/_social.js";
import { fixEncoding } from "./decode.js";

const ACTOR = "apify~facebook-ads-scraper";

interface AdItem {
  adArchiveID?: string | number;
  isActive?: boolean;
  startDate?: number; // unix seconds
  startDateFormatted?: string;
  publisherPlatform?: string[];
  snapshot?: {
    linkUrl?: string | null;
    ctaType?: string | null;
    title?: string | null;
    caption?: string | null;
    body?: { text?: string | null } | null;
    displayFormat?: string | null;
    images?: { originalImageUrl?: string; resizedImageUrl?: string }[];
    videos?: { videoSdUrl?: string; videoHdUrl?: string }[];
    cards?: { originalImageUrl?: string; resizedImageUrl?: string; videoSdUrl?: string }[];
  } | null;
}

const firstMedia = (s: AdItem["snapshot"]): string | null => {
  if (!s) return null;
  const v = s.videos?.[0];
  if (v?.videoHdUrl || v?.videoSdUrl) return v.videoHdUrl ?? v.videoSdUrl ?? null;
  const i = s.images?.[0];
  if (i?.originalImageUrl || i?.resizedImageUrl) return i.originalImageUrl ?? i.resizedImageUrl ?? null;
  const c = s.cards?.[0];
  if (c) return c.originalImageUrl ?? c.resizedImageUrl ?? c.videoSdUrl ?? null;
  return null;
};

/** Map a raw actor dataset to active-ad observations for one run date. */
export function mapAdItems(raw: unknown[], runDate: string): AdObservation[] {
  const out: AdObservation[] = [];
  for (const item of raw as AdItem[]) {
    if (!item?.adArchiveID || item.isActive === false) continue;
    const id = String(item.adArchiveID);
    const started = item.startDateFormatted?.slice(0, 10) ?? null;
    const daysRunning =
      typeof item.startDate === "number"
        ? Math.max(0, Math.floor((Date.parse(`${runDate}T00:00:00Z`) - item.startDate * 1000) / 86_400_000))
        : null;
    const s = item.snapshot ?? null;
    out.push({
      adArchiveId: id,
      startedRunningDate: started,
      daysRunning,
      platforms: (item.publisherPlatform ?? [])
        .map((p) => p.toLowerCase())
        .filter((p) => p === "facebook" || p === "instagram"),
      ctaType: s?.ctaType ?? null,
      linkUrl: s?.linkUrl ?? null,
      adTitle: fixEncoding(s?.title ?? s?.caption ?? null),
      adBody: fixEncoding(s?.body?.text ?? null),
      mediaType: s?.displayFormat ?? null,
      mediaUrl: firstMedia(s),
      snapshotUrl: `https://www.facebook.com/ads/library/?id=${id}`,
    });
  }
  return out;
}

/** Scrape active ads for the given competitor FB page URLs (one batched run). */
export async function collectCompetitorAds(
  pages: { targetId: string; url: string }[],
  runDate: string,
  resultsLimit = 50,
): Promise<Map<string, AdObservation[]>> {
  const byTarget = new Map<string, AdObservation[]>();
  if (pages.length === 0) return byTarget;
  const raw = await apifyRun<Record<string, unknown>>(ACTOR, {
    startUrls: pages.map((p) => ({ url: p.url })),
    resultsLimit,
    activeStatus: "active",
  });
  // group raw items by their inputUrl -> targetId
  const urlToTarget = new Map(pages.map((p) => [p.url, p.targetId]));
  for (const t of pages) byTarget.set(t.targetId, []);
  const grouped = new Map<string, unknown[]>();
  for (const item of raw) {
    const u = (item as { inputUrl?: string }).inputUrl ?? "";
    (grouped.get(u) ?? grouped.set(u, []).get(u)!).push(item);
  }
  for (const [u, items] of grouped) {
    const tid = urlToTarget.get(u);
    if (!tid) continue;
    byTarget.set(tid, mapAdItems(items, runDate));
  }
  logger.info(
    { pages: pages.length, ads: [...byTarget.values()].reduce((n, a) => n + a.length, 0) },
    "competitor ads scraped",
  );
  return byTarget;
}
```
(`Target` type import: confirm it is exported from `@mytime/shared`; if the loaded target shape differs, type `pages` locally instead. The `inputUrl` grouping matches the verified output — each ad item carries its `inputUrl`.)

- [ ] **Step 4:** Run test → PASS (adjust `videoHdUrl`/`resizedImageUrl` field names if the fixture uses different media subfields — inspect `raw.find(x=>x.snapshot?.cards?.length)?.snapshot.cards[0]` and align).
- [ ] **Step 5:** `corepack pnpm --filter @mytime/ingestion exec tsc --noEmit` clean; Biome write; commit:
`git add ingestion/src/ads/meta-ads.ts ingestion/test/ads && git commit -m "feat(ads): facebook-ads-scraper collector + output mapping"`

---

## Task 5: writer `writeAdObservations`

**Files:** Modify `db/src/writers.ts`.

- [ ] **Step 1:** Add (mirror `writeSocialMetrics`'s batched upsert):
```ts
export async function writeAdObservations(
  db: Db,
  targetId: string,
  runDate: string,
  ads: AdObservation[],
): Promise<number> {
  if (ads.length === 0) return 0;
  const values = ads.map((a) => ({
    targetId,
    adArchiveId: a.adArchiveId,
    capturedDate: runDate,
    startedRunningDate: a.startedRunningDate,
    daysRunning: a.daysRunning,
    platforms: a.platforms,
    ctaType: a.ctaType,
    linkUrl: a.linkUrl,
    adTitle: a.adTitle,
    adBody: a.adBody,
    mediaType: a.mediaType,
    mediaUrl: a.mediaUrl,
    snapshotUrl: a.snapshotUrl,
  }));
  await db
    .insert(adObservations)
    .values(values)
    .onConflictDoUpdate({
      target: [adObservations.targetId, adObservations.adArchiveId, adObservations.capturedDate],
      set: {
        daysRunning: sql`excluded.days_running`,
        adBody: sql`excluded.ad_body`,
        linkUrl: sql`excluded.link_url`,
        mediaUrl: sql`excluded.media_url`,
      },
    });
  return ads.length;
}
```
Add imports: `adObservations` from `./schema.js`, `AdObservation` from `@mytime/shared`.
- [ ] **Step 2:** `corepack pnpm --filter @mytime/db build` clean. Commit: `git add db/src/writers.ts && git commit -m "feat(db): writeAdObservations idempotent writer"`

---

## Task 6: wire the ad phase into the daily run

**Files:** Modify `ingestion/src/index.ts`.

- [ ] **Step 1:** Import `collectCompetitorAds` and `writeAdObservations`. After the competitor-social loop (before own-brand Meta), add a phase modeled on the existing social phase:
```ts
// ── Competitor ad intelligence: Meta Ad Library via Apify (Subsystem B) ──
if (optionalEnv("APIFY_TOKEN") && (!onlyCollectors || onlyCollectors.includes("meta-ads"))) {
  const pages = targets
    .filter((t) => !t.is_self && (!onlyTargets || onlyTargets.includes(t.id)) && Boolean(t.social.facebook))
    .map((t) => ({ targetId: t.id, url: t.social.facebook as string }));
  if (pages.length) {
    summary.attempted++;
    const startedAt = new Date();
    try {
      const byTarget = await collectCompetitorAds(pages, runDate);
      let rows = 0;
      for (const [tid, ads] of byTarget) rows += await writeAdObservations(db, tid, runDate, ads);
      summary.succeeded++;
      summary.rows += rows;
      await recordRun(db, { runDate, collector: "meta-ads", targetId: null, status: "success", rowsWritten: rows, startedAt });
      logger.info({ collector: "meta-ads", pages: pages.length, rows }, "competitor ads collected");
    } catch (err) {
      summary.failed++;
      const error = err instanceof Error ? err.message : String(err);
      summary.failures.push({ collector: "meta-ads", target: "all", error });
      await recordRun(db, { runDate, collector: "meta-ads", targetId: null, status: "failed", rowsWritten: 0, error, startedAt }).catch(() => {});
      logger.error({ collector: "meta-ads", err }, "competitor ads failed (isolated)");
    }
  }
}
```
- [ ] **Step 2:** Build. Smoke-test live (limited): `INGEST_COLLECTORS=meta-ads INGEST_TARGETS=saat-saat pnpm ingest` then `select count(*) from ad_observations`. Expect a handful of rows (saat-saat had active ads). Paste the count.
- [ ] **Step 3:** Commit: `git add ingestion/src/index.ts && git commit -m "feat(ingestion): daily competitor ad phase"`

---

## Task 7: analytics + `competitor_ads` MCP tool

**Files:** Modify `mcp-server/src/analytics.ts` and `mcp-server/src/tools/index.ts`.

- [ ] **Step 1:** Add `competitorAds(pool, { competitor?, days? })` to `analytics.ts` (raw SQL like the other analytics fns). Return, per competitor (or the one given), from the latest `captured_date`: active-ad count, avg & max `days_running`, platform split, and the top ads (ad_title, ad_body, link_url, days_running, snapshot_url) ordered by `days_running desc limit 10`, plus top `link_url`s by frequency. Include a `note` that figures are active Ad Library ads (no spend data available).
- [ ] **Step 2:** Register the tool in `tools/index.ts` (follow the existing `McpToolDef` shape):
```ts
{
  name: "competitor_ads",
  title: "Competitor ad intelligence (Meta Ad Library)",
  description:
    "Currently-running Meta ads per competitor: active-ad count, ad longevity (days running = the performance proxy; spend/impressions are NOT public for these ads), newest creatives, CTAs, and top landing pages.",
  requiredRole: "analyst",
  inputSchema: {
    competitor: z.string().optional().describe("target id, e.g. 'saat-saat'; omit for all"),
    days: z.number().int().positive().max(365).optional().describe("lookback window (default 30)"),
  },
  run: (pool, a) => competitorAds(pool, a as { competitor?: string; days?: number }),
},
```
- [ ] **Step 3:** Build mcp-server; quick manual check the tool returns data for saat-saat after Task 6's smoke ingest. Commit: `git add mcp-server/src && git commit -m "feat(mcp): competitor_ads tool + analytics"`

---

## Task 8: full verification

- [ ] **Step 1:** `corepack pnpm -r build && corepack pnpm --filter @mytime/ingestion test && corepack pnpm exec biome check` → all green.
- [ ] **Step 2:** `.env.example`: note `APIFY_TOKEN` already covers this (no new env). Add a one-line comment that `meta-ads` uses it.
- [ ] **Step 3:** Run the full collector once for all competitors: `INGEST_COLLECTORS=meta-ads pnpm ingest`; confirm rows land for the advertising competitors and 0-ad pages write nothing (no error). Paste per-target counts.

## Self-review notes (addressed)
- **Spec coverage:** ad_observations (Task 2), collector+mapping (Tasks 3–4), writer (5), daily phase (6), MCP tool (7) — all present. ✓
- **Field names** come from the live capture (Verified facts), not guesses; media subfield names flagged to confirm against the fixture in Task 4 Step 4. ✓
- **Type consistency:** `AdObservation` defined Task 1, used in Tasks 4/5/6. `adObservations` table Task 2, used in Task 5. `mapAdItems`/`collectCompetitorAds`/`writeAdObservations`/`competitorAds` names consistent across tasks. ✓
- **No-spend reality** is surfaced in the tool description (longevity is the proxy). ✓
