# Review fixes + features (Fable 5 QA batch)

**Date:** 2026-07-02
**Status:** Draft (user review pending)
**Source:** `docs/reviews/2026-07-02-fable5-full-review.md` — fix all bugs (A), all logic/data-quality
issues (B), all security findings (D), and build the missing features (E), per user instruction.

## Ground rule

Every finding is **re-verified before fixing** (the review is a strong lead, not gospel): the
implementer first reproduces the claim (failing test where testable, or a targeted read/query),
then fixes. If a finding doesn't reproduce, it's reported back, not "fixed."

## Workstream 1 — Product lifecycle correctness

- **A1 Product deactivation.** New post-run step in the ingestion runner: after a target's product
  collector succeeds, `UPDATE products SET active=false WHERE target_id=$1 AND last_seen_date <
  $runDate AND active` (scoped to the just-collected target; failed runs touch nothing, so a
  scraper outage never mass-deactivates). Reactivation is free (upsert sets `active:true`).
  One-time backfill script deactivates rows already stale (>7 days behind their target's latest
  successful run) — run manually on the VPS like previous backfills.
- **A10 `compareMarketShare` consistency.** Price aggregates get the same `p.active` filter as the
  counts.
- **A14 runDate timezone.** Derive `runDate` in Europe/Skopje (reuse the `skopjeNow()` approach)
  instead of UTC `toISOString().slice(0,10)`.
- **B10 gender.** Add `маж` (and plural `мажи`) to `normalizeGender`; verify against live vendor
  labels before/after.
- **B11 off-by-one windows.** `current_date - $1::int` → `current_date - ($1::int - 1)` (or
  interval arithmetic) so `period_days` means what it says, in `depletionCte` + `competitorAds`.
- **B3 velocity disappearance.** With A1 in place, add disappearance events to `depletionCte`:
  for products with quantity history whose `last_seen_date` falls inside the window and before the
  target's latest snapshot date, count their last known `quantity` as depleted. Update
  `DEPLETION_DISCLAIMER` to describe exactly what is and isn't counted.

## Workstream 2 — Digest & scheduler reliability

- **A3 scheduler catch-up.** `dueSchedules`/`isDue`: fire when `send_at <= hhmm` AND
  (`last_run_on IS NULL OR last_run_on < today`) — idempotent catch-up. Double-send guard: set
  `markScheduleRan` **before** sending; on send failure, clear it (compensating update) so the next
  tick retries. (Mark-then-send: a crash mid-send now skips rather than double-sends — preferred
  for a business digest.)
- **B1 dead knobs → wired.** `digest_enabled` checked by the scheduler tick (skip + log when off);
  `discount_threshold_pct` read by digest + dashboard queries (replaces hardcoded 5);
  `ad_results_limit` read by meta-ads collector (replaces hardcoded 50); `web_max_products` read by
  web-jsonld collector (env var becomes the fallback default). Settings read via one helper with
  sane defaults when unset.
- **B2 per-target date alignment (+ C2 dedup).** Replace the seven global `dd/today_date/prior_date`
  CTEs in `db/src/digest.ts` with one shared **per-target** latest-two-dates resolution (same
  approach as the dashboard's per-target `max(captured_date)`). Delete the dead
  `stopped_count_placeholder`/`prior_count` columns.
- **E3 freshness.** Digest gains a per-target `dataFreshness` stamp (last successful run date per
  collector family); stale targets are labeled "no fresh data" instead of reading as zeros. New
  lightweight `data_health` MCP tool exposing `ingestion_runs` per target (last success, last
  failure, consecutive failures).
- **E8 weekly rollup.** `dailyDigest` gains a `days` param (default 1, weekly = 7) comparing the
  latest per-target date against the date ≥N days prior; digest schedules gain a `period` field
  (daily/weekly) so an admin can schedule a Monday-morning weekly.

## Workstream 3 — Social data quality

- **A4 no-downgrade upsert.** `writeSocialPosts` conflict clause: keep `measured` reach when the
  incoming row is only an estimate; `COALESCE(excluded.<counter>, social_posts.<counter>)` for
  likes/comments/shares/views/engagement so a flaky scrape can't null out real counts.
- **A5 platform isolation in meta-own.** IG and FB blocks each in their own try/catch (including
  the initial account-metrics fetch); partial success reports which platform failed.
- **A6 safe postedAt.** Shared guard: `Number.isFinite(Date.parse(x))` else null, applied in
  `writeSocialPosts` (defense) and in the FB mapper (source).
- **A7/A11 FB attribution.** Match actor results to targets by the actor's `pageId`/`facebookId`
  echo (fall back to exact URL match, never positional index or substring); log unmatched items
  with counts. `extractHandle` rejects `profile.php`-style URLs at load time with a clear warning.
- **A8 FB post identity.** Normalize post URLs (strip query params, force www host) before using as
  `externalPostId`; posts with neither id nor URL are dropped with a log.
- **A9 hidden likes.** `likesCount >= 0 ? likesCount : null` in `mapIgPosts`; same guard in the
  account-level `avg_post_engagement` metric.
- **B4 engagement parity.** Own IG engagement drops insight-`shares` from the sum (likes+comments,
  same as competitor IG). Tool notes in `social_posts`/`social_benchmark` document the per-platform
  engagement definitions explicitly.
- **B5 per-platform aggregates.** `socialPosts` window aggregates partition by (target, platform)
  instead of target-only; group output nests per-platform aggregate blocks (posts list unchanged).
- **B6 cadence honesty.** Benchmark cadence note states the scraper-depth cap; additionally compute
  cadence from the observed timestamp span (`posts / days-spanned`, floored at 1 day) which is
  robust to depth caps, and return both.
- **B9 estimate share.** `socialPosts`/`socialBenchmark` aggregates include `pctEstimatedReach`
  (share of posts whose reach is estimated) so mixed bases are visible.

## Workstream 4 — SKU matching & pricing features

- **B7 compareSkus false matches.** Drop the URL-slug fallback as a match key (slug-derived refs
  are marked and excluded from matching); require brand agreement when **either** side has a
  non-empty brand key (blank-blank still allowed, flagged `brandUnverified` in output).
- **B8 coherent rows.** Key-collision collapse switches to `DISTINCT ON (key) ... ORDER BY key,
  effective_price ASC` so name/brand/price come from one product (the cheapest variant).
- **E1 `price_history` tool.** New MCP tool: filters (competitor, brand, model_ref, product name
  ILIKE, days≤365), returns per-product date series (price, discount_pct) + summary (min/max/current,
  biggest drop). Read-only, roles as other analyst tools.
- **E2 undercut alerts.** Digest section "Price undercuts": day-over-day diff of `compare_skus`
  (MY:TIME vs each competitor) listing SKUs where a competitor's effective price moved below ours
  (new undercuts + resolved ones), capped list + count.
- **E4 assortment gaps.** New `assortment_gaps` MCP tool: brands (and price-band coverage) a chosen
  competitor carries that MY:TIME doesn't, and vice versa — the EXCEPT complement of
  `shared_brands`.
- **E5 promo calendar.** New `promo_calendar` MCP tool: per competitor, detect discount waves from
  `prices` history (a wave = ≥N products entering discount within a rolling window; start/end dates,
  peak breadth, avg depth). Heuristic thresholds documented in the tool note.

## Workstream 5 — Security hardening

- **D1 escape handler errors.** `esc(out.error)` at the admin router render sites (+
  `dashboard.ts` err.message). Handlers keep echoing input; the router boundary escapes.
- **D2 URL scheme allowlist.** Dashboard client emits `href`/`src` only for `^https?://` values
  (shared `safeUrl()` in the client JS); non-conforming URLs render as plain text.
- **D3 secrets out of query strings.** Meta token → `Authorization: Bearer` header; Apify token →
  `Authorization: Bearer`; Gemini key → `x-goog-api-key` header.
- **D4 refresh-token hygiene.** Add `created_at`-based expiry (90 days) + rotation on refresh
  (issue new, revoke old); refresh scopes must be ⊆ original grant.
- **D5 session hardening.** `timingSafeEqual` for CSRF compare; **A13** admin session re-validates
  the user against `authorized_users` (active + role) on each request.
- **D6 digest HTML sanitization.** Sanitize Gemini output with an allowlist (h2,h3,p,ul,ol,li,
  strong,em,a[href^=https]) before embedding in the email; strip everything else.
- **D7 target URL validation.** Admin target editor validates platform URLs against expected hosts
  (facebook.com/instagram.com/tiktok.com, https only).
- **A12 OAuth map sweep.** Periodic sweep (setInterval, 10 min) evicting expired `pending`/`codes`
  entries + a hard size cap.

## Workstream 6 — Social content mining (E6)

- New `social_content` MCP tool over stored captions: top hashtags per competitor (30d), posting-
  time heatmap (day-of-week × hour, Europe/Skopje) with avg engagement per cell, and brand-mention
  counts (matched against the known brand list from `products`). Pure SQL over `social_posts`; no
  new collection.

## Cheap entangled refactors (included)

- **C2** (digest CTE dedup) — happens as part of B2.
- **C4** pool consolidation: one pg Pool per connection string shared by raw-pg and drizzle in
  mcp-server (cap total connections).
- **C6** replace `targetFilter.replace(/a\./g,"")` string surgery with explicit per-alias filter
  builders.

## Out of scope (explicit)

- **E7** Central Registry financials collector — needs an external-site feasibility spike first.
- **C1** full docker-Postgres SQL test harness — each fix here ships with unit tests where the
  logic is pure (mappers, guards, helpers) + live verification for SQL, per this repo's existing
  practice. A dedicated SQL fixture harness is its own future project.
- **C3** runner try/catch dedup, **C5** dashboard static-file split — cosmetic, deferred.

## Testing & verification

- TDD per task where the logic is testable in-process (mappers, guards, schedulers with fake
  clocks, sanitizers, URL allowlists).
- SQL changes verified live post-deploy (same pattern as previous batches): a verification script
  exercising each changed/added tool against prod data, plus digest Preview.
- Regression gates: `pnpm -r build`, `pnpm -r test`, Biome; competitor rows in social tools
  unchanged; existing digest sections still render.
- Deploy: single deploy at the end (git archive → VPS, restart), then the verification script +
  one manual digest Preview; backfill scripts (A1) run manually.

## Success criteria

1. All A/B/D findings fixed or explicitly reported as not-reproducible.
2. New tools live: `price_history`, `assortment_gaps`, `promo_calendar`, `data_health`,
   `social_content`; digest gains undercut alerts + freshness stamps + weekly mode.
3. Admin toggles (`active`, `digest_enabled`, thresholds/limits) demonstrably effective.
4. Whole-repo gate green; no competitor-data regression in social tools.
