# Subsystem B — Competitor Ad Intelligence (Meta Ad Library)

**Date:** 2026-06-29
**Status:** Approved design (pre-implementation)
**Part of:** the 3-subsystem expansion (A = data validation/discount fix — DONE; **B = this**; C = daily competitor digest). C will consume B's ad data.

## Problem & research findings

The user wants to see competitors' current sponsored posts and, ideally, ad performance. Research established hard constraints:

1. **The Meta Ad Library *API* is gated** — it requires identity verification + Ad Library API approval (oriented to political/issue-ad transparency). Our Meta app returns `OAuthException code 10 "App role required"`. So the official API route is closed to us.
2. **Apify is the viable path** — mature public Ad Library scrapers exist (no Meta token needed). We will use the official **`apify/facebook-ads-scraper`** (id `JJghSZmShuco4j9gJ`, 25.7k users, 99.6% success, ~$0.0058/ad).
3. **Real ad performance (spend, impressions, CTR) is NOT publicly available for our competitors.** Meta only publishes spend/reach for **political/issue ads** and **EU-served ads** (DSA). North Macedonia is non-EU and watch retailers don't run political ads, so those fields are empty. No tool can surface data that doesn't exist publicly.

**What we CAN get** per competitor (still strong competitive intel): each active ad's **creative (image/video URL), copy, platforms (FB/IG), start date, days-running, landing-page/CTA**. The performance proxy is **ad longevity + active-ad count** — advertisers kill losers fast and keep winners running.

## Decisions (locked during brainstorming)

- **Scope:** active-ad intelligence + longevity (NOT spend — unavailable). Capture creatives (URLs), copy, platforms, dates, landing pages.
- **Cadence:** **daily**, in the main 03:15 ingest run (new phase after social). Cost accepted, watch it.
- **Actor + targeting:** official `apify/facebook-ads-scraper`, target **by competitor FB Page** (precise — only that advertiser's ads), via per-page Ad Library URLs.
- **Own brand (MY:TIME):** competitors only for now (YAGNI); MY:TIME's own ads can be added later.

## Architecture & data flow

New ad collector in ingestion, following the existing Apify pattern (`ingestion/src/social/_social.ts` `apifyRun`). Runs daily as a new phase in `ingestion/src/index.ts` (after the competitor-social loop, before/with own-brand Meta), failure-isolated like every collector.

```
for each competitor target with an fb_page_id:
  build Ad Library page URL:
    https://www.facebook.com/ads/library/?active_status=active&ad_type=all
      &country=MK&view_all_page_id=<fb_page_id>
  → apify/facebook-ads-scraper (batched startUrls, one actor run)
  → map each returned active ad → AdObservation
  → writeAdObservations(db, targetId, runDate, ads)   // idempotent upsert
  → recordRun(...)
```

### Components (each independently testable)

- **`config/targets.json`** — add an optional `fb_page_id` per competitor (resolved once during setup; the exact resolution method — Meta Graph lookup of the public page, the Ad Library "search by page" UI, or page-HTML — is determined in the plan). Targets without `fb_page_id` are skipped.
- **`db/src/schema.ts`** — new `ad_observations` table + migration.
- **`db/src/writers.ts`** — `writeAdObservations(db, targetId, runDate, ads)`; idempotent batched upsert (mirrors `writeSocialMetrics`).
- **`ingestion/src/ads/meta-ads.ts`** — the collector: builds Ad Library URLs, calls the actor via `apifyRun`, maps the actor output to `AdObservation[]`. (Exact actor output field names confirmed via Apify `fetch-actor-details` during implementation.)
- **`ingestion/src/index.ts`** — wire the ad phase into the daily run, gated on `APIFY_TOKEN`, with `INGEST_COLLECTORS`/`INGEST_TARGETS` filters honored.
- **`mcp-server/src/tools/`** — new `competitor_ads` tool + analytics query.
- **`shared`** — an `AdObservation` type for the collector→writer contract.

## Data model — `ad_observations`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `target_id` | text FK → targets | the competitor |
| `ad_archive_id` | text | Meta's stable ad id |
| `captured_date` | date | the run date |
| `started_running_date` | date null | ad start (for longevity) |
| `days_running` | int null | today − started (computed) |
| `platforms` | text[] | e.g. {facebook,instagram} |
| `cta_type` | text null | e.g. SHOP_NOW |
| `link_url` | text null | landing page |
| `ad_title` | text null | headline |
| `ad_body` | text null | primary copy |
| `media_type` | text null | image / video / carousel |
| `media_url` | text null | creative URL (not stored binary) |
| `snapshot_url` | text null | Ad Library snapshot link |
| `created_at` | timestamptz | default now |

Unique index `(target_id, ad_archive_id, captured_date)` → idempotent re-runs (same day upserts, never duplicates), matching the project's snapshot convention.

## Derived metrics & the MCP tool

From the daily time-series:
- **Currently active ads** = rows at the latest `captured_date`.
- **Longevity** = `days_running` (or `today − started_running_date`) — the performance proxy.
- **New ads** = `ad_archive_id`s first appearing today; **stopped ads** = previously seen, absent today.
- **Destination intel** = top `link_url` landing pages, **CTA mix**, **platform split** (FB vs IG).

New MCP tool **`competitor_ads`** (role: **analyst**): args `{ competitor?: targetId, days?: number }` → per competitor: active-ad count, avg/max longevity, newest creatives (title/body/media/snapshot), top landing pages, platform split. Registered in `mcp-server/src/tools/index.ts`.

## Cost

Daily × ~$0.0058/ad. If competitors collectively run ~200 active ads, ≈ $35/mo on top of the existing Apify social spend (~$5/mo plan credits). Watch the Apify usage; easy to dial to weekly later (the collector logic is unchanged — only the schedule).

## Testing

- **Collector mapping** unit-tested against a **saved actor-output fixture** (a real `apify/facebook-ads-scraper` result captured once), so tests need no live Apify calls.
- **`writeAdObservations`** tested for idempotency (re-run same day = no dupes) via the existing DB test approach.
- **`competitor_ads`** analytics query tested against seeded `ad_observations`.
- `pnpm build` + Biome clean; migration verified.

## Scope / YAGNI

- Store creative **URLs**, not binaries.
- **No spend/impressions** (unavailable for MK commercial ads).
- No political-ad archive, no historical backfill (Ad Library only shows currently-active ads + recent).
- **Competitors only** (no MY:TIME own ads yet).
- Daily schedule reuses the existing `mytime-ingest.timer`; no new timer.

## Success criteria

1. The daily run records each competitor's currently-active Ad Library ads into `ad_observations` (idempotent), with longevity derivable.
2. The `competitor_ads` MCP tool returns active-ad counts, longevity, newest creatives, and top landing pages per competitor.
3. Fixture-based collector test + writer idempotency test + tool test pass; build + Biome clean.
4. Cost is visible (logged ad counts per run) so the daily-vs-weekly call can be revisited.
