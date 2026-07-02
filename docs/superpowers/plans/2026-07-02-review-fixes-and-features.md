# Review Fixes + Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.
> Executed 2026-07-02 in autonomous orchestrator mode (user offline): one implementer subagent per
> task, one combined spec+quality review per task (time-boxed deviation from two-stage), final
> whole-branch review before merge.

**Goal:** Fix all bugs (A), logic issues (B), security findings (D) from
`docs/reviews/2026-07-02-fable5-full-review.md` and ship features E1–E6, E8, per spec
`docs/superpowers/specs/2026-07-02-review-fixes-and-features-design.md`.

**Architecture:** No new services. Ingestion runner + collectors hardened; digest/scheduler made
per-target and idempotent; analytics SQL corrected + 5 new read-only MCP tools; admin security
hardening. One migration (digest schedule `period`).

**Tech stack:** unchanged (Node 24 TS ESM, Drizzle+pg, Vitest, Biome).

**Branch:** `feat/review-fixes` off `main`. Every task: re-verify finding → fix (TDD where pure) →
`pnpm --filter <pkg> build && test` → commit.

---

### Task T1: Product lifecycle (A1, A10, A14, B3, B10, B11)

**Files:** `db/src/writers.ts` (+`deactivateMissingProducts`), `ingestion/src/index.ts` (call after
successful product collect, Skopje runDate), `db/scripts/backfill-active.mjs` (new),
`mcp-server/src/analytics.ts` (`compareMarketShare` active filter; `depletionCte` disappearance +
window off-by-one; disclaimer), `ingestion/src/pipeline/normalize.ts` (`маж|мажи`),
`ingestion/test/*`.

- A1: `deactivateMissingProducts(pool, targetId, runDate)` → `UPDATE products SET active=false
  WHERE target_id=$1 AND last_seen_date < $2 AND active`; runner calls it **only after a successful
  product collector run for that target**. Backfill script (dry-run default, `--apply`): per target
  with product rows, deactivate `last_seen_date < max(last_seen_date) of that target`.
- A14: `runDate` from Europe/Skopje (`Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Skopje'})`).
- A10: same `p.active` predicate on the price-aggregate side as the counts.
- B11: `current_date - ($N::int - 1)` in `depletionCte` + `competitorAds` so windows are N days.
- B3: disappearance events — products whose last quantity snapshot >0 and which went inactive
  (`last_seen_date` in-window, older than the target's latest snapshot date) add last qty to
  depletion. Rewrite `DEPLETION_DISCLAIMER` to state exactly what's counted.
- B10: extend gender regex with `маж(и)?` (keep existing branches; unit test машки≠женски).

### Task T2a: Scheduler catch-up + wire settings knobs (A3, B1)

**Files:** `db/src/digests-db.ts` (`dueSchedules`, `isDue`, new `clearScheduleRun`),
`mcp-server/src/digestScheduler.ts` (mark-then-send), settings read helper in `db` (find the
existing admin settings table via `mcp-server/src/admin/pages/settings.ts`), `db/src/digest.ts` +
`mcp-server/src/admin/pages/dashboard.ts` (threshold), `ingestion/src/ads/meta-ads.ts`
(`ad_results_limit`), `ingestion/src/sources/web-jsonld.ts` (`web_max_products`, env fallback),
tests (fake-clock catch-up: missed minute fires later same day; already-ran today doesn't refire;
disabled digest never sends).

- A3: due = `send_at <= hhmm AND (last_run_on IS NULL OR last_run_on < today)` (+enabled). Scheduler
  marks ran **before** sending; on send failure clears the mark (retry next tick) + logs.
- B1: `getAppSettings(pool)` returns typed values with defaults (5, 50, current env, true);
  scheduler checks `digest_enabled` each tick; digest/dashboard/collectors read their knobs.

### Task T2b: Digest per-target dates + freshness + weekly (B2+C2, E3, E8)

**Files:** `db/src/digest.ts` (shared per-target latest-two-dates CTE fragment used by all seven
sections; delete `stopped_count_placeholder`/`prior_count`), freshness from `ingestion_runs` (last
success per target/collector; "no fresh data" label when stale >48h), `days` param (default 1;
weekly=7 compares latest vs latest ≥7d older), `db/src/schema.ts`+migration 0007 (`digest_schedules.period`
'daily'|'weekly' default daily), scheduler passes period, admin digests page gains the field,
new `data_health` tool in `mcp-server/src/analytics.ts`+`tools/index.ts` (per target: last success,
last failure, consecutive failures, rows last run). Per-target CTE shape:
`WITH dd AS (SELECT target_id, captured_date, row_number() OVER (PARTITION BY target_id ORDER BY
captured_date DESC) rn FROM (SELECT DISTINCT target_id, captured_date FROM prices) x WHERE rn<=2)`.

### Task T3a: Social collectors + writer hardening (A4, A5, A6, A7, A8, A9, A11, B4)

**Files:** `db/src/writers.ts` (`writeSocialPosts` conflict clause; safe date), `ingestion/src/social/
{facebook,instagram,meta-own,_social}.ts`, tests per mapper.

- A4: `reach_source`: keep measured over estimate (CASE); counters `COALESCE(excluded.x, existing.x)`;
  engagement recomputed consistently (never null-out non-null).
- A6: `toDateOrNull(x)` guard in writer + FB mapper.
- A5: IG and FB blocks (incl. initial account fetches) in separate try/catch; report partial status.
- A7/A11: match Apify results by `pageId`/`facebookId` echo → exact URL → drop+log (never positional
  index, never substring); `extractHandle` warns+skips `profile.php` URLs.
- A8: normalize FB post URL (strip query, canonical host) before use as `externalPostId`; no id and
  no URL → drop with log.
- A9: negative counts → null in `mapIgPosts` + account metrics.
- B4: own IG engagement = likes+comments (drop insight shares from the sum; still store shares col).

### Task T3b: Social analytics aggregates (B5, B6, B9 + notes)

**Files:** `mcp-server/src/analytics.ts` (`socialPosts`, `socialBenchmark`).
Aggregates partition by (target, platform); group output gains `perPlatform[]` blocks (posts list
unchanged); `pctEstimatedReach` per aggregate; cadence additionally computed from timestamp span
(`posts/max(1,days-spanned)`) returned alongside window count; tool notes document per-platform
engagement definitions + scraper-depth cap. Competitor regression check in live verify.

### Task T4: SKU matching fixes + pricing features (B7, B8, E1, E2, E4, E5)

**Files:** `ingestion/src/pipeline/normalize.ts` (slug-derived refs excluded from match keys),
`mcp-server/src/analytics.ts` + `tools/index.ts` (compareSkus tightening; new `price_history`,
`assortment_gaps`, `promo_calendar`), `db/src/digest.ts` (undercut section), tests.

- B7: no slug-derived match keys; brand agreement required when either side has a brand
  (blank-blank allowed, output flag `brandUnverified`).
- B8: `DISTINCT ON (key) ORDER BY key, effective_price ASC`.
- E1 `price_history({competitor?,brand?,modelRef?,q?,days<=365})`: per-product date series
  (price, discountPct) + summary (min/max/current, biggestDrop).
- E4 `assortment_gaps({competitor})`: brands each side carries that the other doesn't (+count,
  price-band min/median/max), both directions.
- E5 `promo_calendar({competitor?,days<=180})`: per target daily discounted-count series → waves =
  consecutive days (gap≤2) with count ≥ max(5, 10% of that target's active catalog); report
  start/end/peakBreadth/avgDepth; heuristic documented in note.
- E2: digest "Price undercuts" section — day-over-day (per-target dates from T2b) diff of matched
  SKUs (compare_skus logic): newly-undercut + resolved, cap 10 each + totals.

### Task T5: Security hardening (D1–D7, A12, A13)

**Files:** `mcp-server/src/admin/router.ts` (esc errors), `admin/pages/dashboard.ts` (esc err,
client `safeUrl()` https-only for href/src), `ingestion/src/social/meta-own.ts` + `_social.ts` +
`db/src/digest-render.ts` (tokens → `Authorization: Bearer` / `x-goog-api-key` headers),
`mcp-server/src/auth/provider.ts`+`store.ts` (refresh rotation, 90d `created_at` expiry, scope ⊆
grant, pending/codes sweep + size cap), `admin/session.ts` (`timingSafeEqual`), `admin/auth.ts`
(re-validate user active+role per request), `db/src/digest-render.ts` (allowlist HTML sanitizer —
no new deps), `admin/pages/targets.ts` (platform-host URL validation). Tests: sanitizer, safeUrl,
rotation, session re-validation.

### Task T6: `social_content` tool (E6)

**Files:** `mcp-server/src/analytics.ts` + `tools/index.ts`, test for hashtag extraction.
Top hashtags per competitor (30d, regex `#[\p{L}\p{N}_]+` lowercased), posting-time heatmap
(dow×hour Europe/Skopje, count+avgEngagement), brand mentions (distinct brands from `products`
matched case-insensitively in captions). Pure SQL/TS over `social_posts`.

### Task T7: Gate, deploy, live verification, merge

- `pnpm -r build && pnpm -r test` + Biome on changed files; fix fallout.
- Merge `feat/review-fixes` → `main` (no-ff), push origin.
- Deploy (git archive → VPS → build → restart mytime-mcp).
- Run migration 0007 + `backfill-active.mjs --apply` on VPS.
- Live verify script: every changed/new tool returns sane data (incl. mytime + a competitor
  regression row-for-row spot check on social tools), digest Preview renders with freshness +
  undercuts sections, scheduler tick log shows catch-up logic, admin toggle actually excludes a
  target from `loadTargetsFromDb`.
- Update memory + final report.
