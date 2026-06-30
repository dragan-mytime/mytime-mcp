# Digest data enrichment — ad creatives + discount brand/category breakdown

**Date:** 2026-06-30
**Status:** Approved design (pre-implementation)
**Area:** `db/src/digest.ts` (`dailyDigest` / `CompetitorDigest`)

## Problem

The daily digest prompt can only present data that's in the `DigestResult` JSON. To deliver the
user's email goals — *visually show new + best-performing ads per competitor*, and *show which
brands/categories are discounted* — the digest data must carry (a) ad **media** and (b) a
discount **brand/category breakdown**. Both come from data we already collect; this enriches the
`dailyDigest` output only. The email rendering (Gemini prompt) consumes the richer JSON; this
step makes no prompt/render change. Also feeds the future dashboard.

## 1. Ad creatives

Extend the `ads` section of `CompetitorDigest`:

- **New ads** — each entry gains `mediaUrl: string | null` and `mediaType: string | null`
  (the existing `adTitle`/`linkUrl`/`daysRunning`/`snapshotUrl` stay). Source columns
  `ad_observations.media_url` / `media_type`.
- **`longestRunning` ("best performing")** — upgrade from `{ daysRunning, adTitle }` to
  `{ adTitle, daysRunning, mediaUrl, mediaType, snapshotUrl, linkUrl } | null`, so it can render
  as a visual hero rather than a bare title.

Query changes (`queryAds`): add `media_url, media_type, snapshot_url, link_url` to the `today_ads`
CTE and the `longest` `DISTINCT ON` pick (with the corresponding `GROUP BY` additions in the agg
SELECT); add `media_url, media_type` to the new-ads SELECT. Types `NewAdRow` / `AdsAggRow` gain
the columns; assembly maps them.

⚠️ **Caveat:** FB Ad Library `media_url`s are time-limited. The digest is built the same morning
ads were scraped (~03:15 ingest → 07:00 send), so they'll usually still resolve, but some images
may 404. Durable fix = host the media ourselves — a follow-up, not in scope here.

## 2. Discount breakdown by brand & category

Extend the `sales` section of `CompetitorDigest` with **per-competitor** rollups of *today's*
on-sale products:

- `byBrand: { brand: string; count: number; avgPct: number | null }[]` — top 5 brands by count.
- `byCategory: { category: string; count: number; avgPct: number | null }[]` — top 5 categories.

Computed from `products.brand` / `products.category` joined to today's `prices` where
`discount_pct > 0`, grouped per target, ranked by count (then avg depth), `rn <= 5`. Two new
queries in `querySales` (returns `{ agg, samples, byBrand, byCategory }`); rows indexed by
`target_id` and mapped in assembly. Rows with NULL brand/category are skipped.

**Scope of "trends":** today's snapshot only (which brands/categories are discounted + how deep).
Multi-day trend lines belong to the dashboard (next step), fed by the same data.

## Data shape (final `CompetitorDigest` additions)

```ts
sales: {
  // …existing…
  byBrand: { brand: string; count: number; avgPct: number | null }[];
  byCategory: { category: string; count: number; avgPct: number | null }[];
};
ads: {
  // …existing activeToday/stoppedCount…
  new: { adTitle; linkUrl; daysRunning; snapshotUrl; mediaUrl: string | null; mediaType: string | null }[];
  longestRunning: { adTitle; daysRunning; mediaUrl: string | null; mediaType: string | null; snapshotUrl: string | null; linkUrl: string | null } | null;
};
```

## Testing

- Update `db/test/digest-render.test.ts` `fakeDigest` to the new shape (the new fields make the
  type stricter); the render fallback test stays green (it doesn't read the new fields).
- The deterministic `templateDigest` fallback is unchanged (still uses `adTitle`/`daysRunning`).
- **Live verification:** run `dailyDigest(db)` against the VPS DB and confirm the new fields are
  populated — at least one competitor has `ads.new[].mediaUrl`, a richer `longestRunning`, and
  non-empty `sales.byBrand`/`byCategory` (e.g. b-watch). No unit test for `dailyDigest` (needs a DB).
- `pnpm -r build` + ingestion/db tests + Biome clean.

## Scope / YAGNI

- No prompt/email-render change here (separate step the user drives).
- No media hosting/proxy (follow-up); no multi-day trend history (dashboard).
- Breakdown is per-competitor; a market-wide rollup, if wanted, can be synthesized by the LLM or
  added later.

## Success criteria

1. `CompetitorDigest.ads.new[]` carries `mediaUrl`/`mediaType`; `longestRunning` carries media +
   links; `sales.byBrand`/`sales.byCategory` are populated for competitors with discounts.
2. Live `dailyDigest` shows the new fields filled from real data.
3. Build + tests + Biome clean; existing digest send/scheduler unaffected.
