# MY:TIME BI — Fable 5 Code Review & QA Report (2026-07-02)

Reviewer: Fable 5 (full-repo review agent). Build + tests verified green before review
(`pnpm -r build`, `pnpm -r test` — 19 ingestion files/93 tests, 2 mcp-server files/10 tests, db green).

Known/accepted constraints were excluded up front (IG insights permission pending App Review,
FB reach retired in Graph v23, expiring CDN media URLs, no paid reach provider, archive-based deploys).

---

## A. Bugs (prioritized)

**A1. `products.active` is never set to false — delisted products pollute every analytic — HIGH**
`db/src/writers.ts:124` sets `active: true` on every upsert; nothing anywhere flips it off (verified: no `active=false` write exists in the repo). Consequences: `priceAssortment` (`mcp-server/src/analytics.ts:441`) counts long-gone SKUs forever; `compareSkus` (`analytics.ts:488-501`) compares against a product's *latest price ever*, however stale; `compareMarketShare` assortment counts inflate monotonically. Fix: after each successful product run, `UPDATE products SET active=false WHERE target_id=$1 AND last_seen_date < $runDate` (scoped per collected target), or bound all "latest price" laterals by `last_seen_date`.

**A2. Admin "Active — include in daily runs" toggle is a no-op — HIGH**
`mcp-server/src/admin/pages/targets.ts:120,171` writes `targets.active`, but `loadTargetsFromDb` (`db/src/targets-db.ts:99`) selects *all* rows with no `active` filter, and `rowToTarget` drops the column entirely, so `ingestion/src/index.ts` can't filter on it either. Disabling a competitor in the admin does nothing. Fix: `WHERE active = true` in `loadTargetsFromDb` (matching the plan doc's own acceptance criterion in `docs/superpowers/plans/2026-06-29-admin-panel.md`).

**A3. Digest scheduler silently skips a day if the exact minute is missed — HIGH**
`dueSchedules` (`db/src/digests-db.ts:203`) and `isDue` require `sendAt === hhmm` exactly. If the 60s tick doesn't land inside that one minute (deploy/restart at send time, a prior tick blocked >60s by Gemini's 90s timeout at `db/src/digest-render.ts:132`, clock hiccup), the digest never sends that day and no error is recorded. Fix: `send_at <= hhmm AND (last_run_on IS NULL OR last_run_on < today)` — the `lastRunOn` guard already makes catch-up idempotent. (Inverse edge: crash between `sendDigestEmail` and `markScheduleRan` (`mcp-server/src/digestScheduler.ts:44-45`) can double-send; consider marking-then-sending or a run ledger.)

**A4. `writeSocialPosts` upsert can downgrade measured reach and null-out engagement — MEDIUM**
`db/src/writers.ts:294-310` blindly overwrites all metric columns with `excluded.*`. If a later `meta-own` run's insight call fails (`graphInsight` returns null on any error, `ingestion/src/social/meta-own.ts:30`), a post that had `reachSource='measured'` is overwritten with `estimate`; a later scrape missing likes/comments overwrites real counts with NULL. The "auto-upgrades to measured" claim is true, but it auto-*downgrades* too. Fix: conditional set, e.g. `estimated_reach = CASE WHEN social_posts.reach_source='measured' AND excluded.reach_source<>'measured' THEN social_posts.estimated_reach ELSE excluded.estimated_reach END`, and `COALESCE(excluded.likes, social_posts.likes)` for counters.

**A5. Own-brand collector: an IG failure aborts FB collection — MEDIUM**
`collectOwnBrandMeta` (`meta-own.ts:130-207`): the initial `graphGet(igId, …)` for IG account metrics is *outside* the try/catch; if IG throws (expired token scope, transient 500), the function throws before the FB block runs, and the runner logs one failure losing both platforms. Wrap each platform block in its own try/catch and report partial status.

**A6. Unparseable `postedAt` strings crash the whole social write batch — MEDIUM**
`db/src/writers.ts:274`: `new Date(p.postedAt)` — the FB posts scraper feeds `it.time ?? it.timestamp ?? it.date` (`ingestion/src/social/facebook.ts:76`) which can be a locale string; an Invalid Date makes node-postgres serialization throw (`toISOString` RangeError), failing the entire platform's upsert. Fix: `Number.isFinite(Date.parse(x)) ? new Date(x) : null`.

**A7. Facebook collector can mis-attribute pages and silently drop posts — MEDIUM**
`facebook.ts:112-127`: (a) positional fallback `items[i]` assumes the actor preserves input order — wrong order attributes competitor A's followers to competitor B; (b) posts are matched by `postUrl.includes(handle)`, but many FB post URLs use numeric page ids (`permalink.php?story_fbid=…&id=123`), so those posts are dropped without any log; short handles can substring-match another page's URL. Fix: match on the actor's `pageId`/`facebookId` echo, and log unmatched items.

**A8. FB post identity falls back to URL → duplicate rows across runs — MEDIUM**
`facebook.ts:57`: `it.postId ?? it.postUrl ?? it.url` as `externalPostId`; URL variants (tracking params, m.facebook vs www) create duplicate posts in `social_posts`, inflating cadence and averages. Normalize URLs or drop URL-keyed posts.

**A9. IG hidden like counts (-1) poison engagement averages — MEDIUM**
Apify's IG scraper returns `likesCount: -1` when a profile hides likes. `mapIgPosts` (`ingestion/src/social/instagram.ts:73-77`) passes it straight through → `engagement = -1 + comments`, and `metrics()` (line 40) averages it into `avg_post_engagement`. Guard `likesCount >= 0 ? likesCount : null`.

**A10. `compareMarketShare` mixes active-filtered counts with unfiltered price aggregates — LOW**
`analytics.ts:85-98`: `count(*) FILTER (WHERE p.active)` but `avg/min/max(lp.price)` run over *all* products including inactive. Once A1 is fixed this becomes a visible inconsistency; add `WHERE p.active` to the outer query.

**A11. `extractHandle` breaks on non-vanity FB URLs — LOW**
`_social.ts:35-38`: `https://facebook.com/profile.php?id=123` → handle `profile.php`. Combined with A7's substring matching this attributes nothing (or the wrong thing). Validate handles at seed time.

**A12. In-memory OAuth `pending`/`codes` maps grow unbounded — LOW**
`mcp-server/src/auth/store.ts:47-73`: expired entries are only removed if the exact state/code is presented. Unauthenticated `/authorize` hits add entries forever (slow memory DoS). Add a periodic sweep or size cap.

**A13. Admin sessions aren't re-validated against the whitelist — LOW**
`admin/auth.ts:125-138`: an 8h cookie stays valid after the user is deactivated or demoted in `authorized_users` (MCP refresh path *does* re-check, `auth/provider.ts:123`). Re-check on each request or shorten TTL.

**A14. Ingestion `runDate` is the UTC date — LOW (latent)**
`ingestion/src/index.ts:34` uses `toISOString().slice(0,10)`. It's correct only because the timer fires 03:15 UTC (05:15 Skopje). Any schedule between 22:00–02:00 UTC would label rows with the wrong local day and break the day-over-day digest joins. Derive the date in Europe/Skopje like `skopjeNow()` does.

## B. Logic & data-quality issues

**B1. Four admin Settings are dead knobs — HIGH**
`discount_threshold_pct`, `ad_results_limit`, `web_max_products`, `digest_enabled` are written by `admin/pages/settings.ts` but *never read anywhere* (grep-verified). The digest hardcodes 5% (`db/src/digest.ts:583`, `dashboard.ts:130`), meta-ads hardcodes `resultsLimit=50` (`ingestion/src/ads/meta-ads.ts:73`), product cap is env-only (`web-jsonld.ts:37` + systemd), and the scheduler ignores `digest_enabled` entirely (`digestScheduler.ts:34-68`). An admin unchecking "Digest enabled" still gets emails. Wire them or remove them from the UI.

**B2. Digest compares the 2 most recent *global* dates — failed scrapes read as "competitor went quiet" — HIGH**
Every `dd … LIMIT 2` CTE in `db/src/digest.ts` (98-147, 263-340, 416-459, 491-591) picks the two latest dates across *all* competitors. A competitor whose collector failed today simply has no rows on `today_date` → the digest reports 0 on-sale / 0 ads for it, indistinguishable from real inactivity; mixed-cadence targets misalign new/ended calculations. Fix: per-target latest-two-dates (the dashboard's `disc` query already does per-target `max(captured_date)` — `dashboard.ts:81-86`), plus a per-target freshness stamp in the output.

**B3. Velocity undercounts: "disappearance" isn't actually counted — MEDIUM**
`DEPLETION_DISCLAIMER` (`analytics.ts:3`) claims 1 unit per "stock-out or disappearance", but `depletionCte` only pairs *existing* snapshot rows via `lag()`; a product dropped from the listing entirely (no row today — exactly what the MY:TIME feed does for sold-out items, `mytime-feed.ts:76`) contributes zero. Also the first snapshot in the window always has `prev_qty IS NULL` (boundary sale lost). Either implement disappearance detection (last snapshot in-window with no successor + product now unseen) or correct the disclaimer.

**B4. Engagement is defined differently per platform and per side — MEDIUM**
Competitor IG = likes+comments (`instagram.ts:77`); own IG = likes+comments+*shares from insights* (`meta-own.ts:94`); own FB = `post_activity_by_action_type` actions; competitor FB = reactions+comments+shares; TikTok = digg+comment+share. `social_benchmark`'s `avg_engagement`/`avg_engagement_rate` (`analytics.ts:137-153`) average these together per target — own-vs-competitor IG comparison is biased in MY:TIME's favor. At minimum document per-platform definitions in the tool note; better, exclude shares from own IG for parity.

**B5. engagementRate uses today's followers for every historical post, averaged across platforms — MEDIUM**
`analytics.ts:376-385`: the lateral picks the latest `followers` regardless of post age (fine for 30d, wrong for anything longer), and `avg_engagement_rate`/`avg_engagement`/`avg_reach` in `socialPosts` partition by `t.id` only — averaging IG rates with TikTok rates over different follower bases. Partition by (target, platform) or at least label the mixture.

**B6. "Cadence" is capped by scraper depth — MEDIUM**
IG `latestPosts` (~12), FB/TikTok `resultsLimit: 15` per run. `posts_in_window` (30d) undercounts prolific posters, especially in the first weeks after onboarding when history hasn't accumulated. Note it in the tool output or derive cadence from post timestamps' span.

**B7. `compareSkus` slug fallback + blank-brand wildcard invite false matches — MEDIUM**
`parseModelRef` falls back to the URL slug (`normalize.ts:115-116`) — generic slugs become 5+-char match keys; and the join allows `mt.bkey='' OR comp.bkey=''` (`analytics.ts:516`), so brandless products match anything with the same key. A "same-name-different-product" pair reports a bogus price delta. Tighten: don't use slugs as keys, or require brand equality when either side has a known brand.

**B8. `compareSkus` collapses key-collisions with `max(name)/max(bkey)/min(eff)` — LOW**
`analytics.ts:504-510`: when several products share a key, brand/name/price can each come from *different* products, and min-price pairing may compare different variants (e.g. strap variants). Prefer `DISTINCT ON (key)` picking one coherent row.

**B9. Estimate-based "reach" dominates FB and blends into averages — LOW**
`REACH_RATE` constants (`reach.ts:7-11`) are fixed guesses; `avg_reach` in `socialPosts` averages measured views with follower-multiples without weighting/labeling at the aggregate level. The per-post labeling is honest — carry a `pctEstimated` share into the aggregate too.

**B10. `normalizeGender` misses "маж/мажи" — LOW**
`normalize.ts:18` matches `маш|mašk|mask|муж` but not the standard Macedonian "маж(и)". Verify against real vendor labels; add `маж`.

**B11. Off-by-one lookbacks — LOW**
`captured_date >= current_date - $1::int` yields a days+1 window in `depletionCte`/`competitorAds`; harmless but inconsistent with "period_days" in output.

## C. Code quality

**C1. Zero tests on the analytics/digest SQL — the riskiest code in the repo.** mcp-server has only `session.test.ts` + `digest-scheduler.test.ts`. Untested behaviors that matter: engagementRate with followers 0/missing, depletion window edges (restock, gap, first-day), compareSkus brand/G-Shock gates and key collisions, digest global-date alignment (B2), `socialPosts` limit/partition semantics. A docker-Postgres (or pglite) fixture suite over `analytics.ts` and `digest.ts` is the highest-leverage QA investment available.

**C2. `db/src/digest.ts` (~800 lines) repeats the identical `dd/today_date/prior_date` CTE seven times**, and the ads agg query computes `stopped_count_placeholder` and `prior_count` that are discarded (`digest.ts:296-307`). Extract one shared date-resolution CTE (per-target, per B2) and delete the dead columns.

**C3. `ingestion/src/index.ts` — four copies of the try/collect/recordRun/catch block (~50 lines each).** Extract `runIsolated(collectorId, targetId, fn)`; the summary/logging/recordRun logic is identical.

**C4. mcp-server opens 4 independent pg pools** (`readPool`, `readDb`, `adminWritePool`, `adminWriteDb`) at `max:10` each → up to 40 connections against Supabase's pooler, plus ingestion's. Share one pool per connection string (drizzle accepts an existing pool).

**C5. `admin/pages/dashboard.ts` (~550 lines) mixes SQL, mapping, CSS, and a client app in a string** — unlintable, untestable. Move `DASH_JS`/`DASH_CSS` to static files served by express; keep only `gather()` in TS.

**C6. `competitorAds`' `targetFilter.replace(/a\./g, "")` string surgery** (`analytics.ts:203,222,239,262`) is fragile — build alias-specific filters explicitly.

## D. Security

**D1. Admin router renders submit-handler errors unescaped — MEDIUM**
`admin/router.ts:46,72`: `<p class="error">${out.error}</p>` — and handlers echo user input into errors: `targets.ts:152` (web_url), `digests.ts:340` (send_at), `recipients.ts:53` (emails), `users.ts:133`/`targets.ts:179`/`digests.ts:176,357` (action). The CSRF gate means it's mostly self-XSS today, but one `esc(out.error)` at the router closes the class. Same for `dashboard.ts:283` (`err.message` unescaped).

**D2. Scraped URLs flow into `href`/`src` with HTML-escaping only — MEDIUM**
Dashboard client (`dashboard.ts:467,475,494,499`): `permalink`, `snapshotUrl`, `mediaUrl` come from scraped competitor/Apify data; `esc()` doesn't neutralize a `javascript:` scheme in `href` → stored XSS in the admin dashboard via a crafted post permalink. Allowlist `^https?://` before emitting links (mediaUrl in `img src` is inert but filter it too).

**D3. Secrets in URL query strings — MEDIUM**
`META_ACCESS_TOKEN` (`meta-own.ts:14,24,37`), `APIFY_TOKEN` (`_social.ts:47`), Gemini key (`digest-render.ts:116`). Query strings leak through proxies/log lines (and Graph API errors sometimes echo the request URL). Apify accepts `Authorization: Bearer`; Meta accepts the token in a header/POST; Gemini accepts `x-goog-api-key`.

**D4. Refresh tokens never expire, never rotate, and refresh-scope isn't constrained — LOW**
`oauth_refresh_tokens` has no expiry column; `exchangeRefreshToken` (`provider.ts:115-141`) doesn't rotate and accepts caller-supplied `scopes` without checking ⊆ original grant. Role gating makes scope escalation moot today, but add rotation + `created_at`-based expiry.

**D5. Admin session hardening — LOW**
A13 (no whitelist re-check) plus `checkCsrf` uses `===` (not `timingSafeEqual`) — `session.ts:61-63`. Minor, cheap fixes.

**D6. Prompt-injection → HTML injection into digest emails — LOW**
Gemini output is placed raw into the email (`digest-render.ts:180`); the model's input JSON contains scraped ad bodies/captions. A hostile string in a competitor ad could steer Gemini into emitting phishing links/HTML to internal recipients. Sanitize the returned HTML (allowlist h2/h3/p/ul/li/strong as the prompt already demands).

**D7. Admin-editable target URLs are barely validated — LOW**
`targets.ts:151`: only `web_url` gets an `https?://` regex; IG/FB/TikTok URLs accept anything and become VPS-side fetch/Apify targets. Admins are trusted, but validating host patterns (facebook.com/instagram.com/tiktok.com) prevents foot-guns.

**Positives noted:** parameterized SQL throughout (no injection found — the only interpolations are zod-validated ints); PKCE + state + signed Google id_token verification done properly; refresh tokens stored hashed; Gemini key masked and super-admin-gated; the JSON embed in the dashboard correctly escapes `<`; preview iframe is sandboxed with escaped `srcdoc`.

## E. Missing features (value ÷ effort)

**E1. Price/discount history tools — HIGH value, LOW effort.** The `prices` table has full time series, but every MCP tool exposes only "latest". `price_history(competitor|brand|ref, days)` and a discount-depth timeline would unlock trend questions the tooling can't answer today.

**E2. Undercut alerts in the digest — HIGH value, LOW effort.** `compare_skus` already matches refs; diff it day-over-day and add "competitor X undercut you on N matched SKUs (list)" to `dailyDigest`. This is the single most actionable retail signal the data already supports.

**E3. Data-freshness surfaced to analysts — HIGH value, LOW effort.** `ingestion_runs` exists but no tool exposes it; combined with B2, stale data silently reads as zeros. Add per-target `lastSuccessfulRun` to every tool response (or a `data_health` tool).

**E4. Assortment-gap analysis — MEDIUM value, LOW effort.** `shared_brands` INTERSECT exists (`analytics.ts:107-113`); the inverse (brands/price-bands a competitor carries that MY:TIME doesn't) is the classic buying-decision input and is one EXCEPT query away.

**E5. Promo-calendar detection — MEDIUM value, MEDIUM effort.** Detect discount-wave start/end dates per competitor from `prices` history (e.g. Bozinovski's Evergreen 30%) → "competitor sale seasons" view for planning MY:TIME campaigns.

**E6. Social content mining — MEDIUM value, MEDIUM effort.** Captions/hashtags/post types are stored but unused: top hashtags per competitor, which brands/products they push, posting-time heatmap vs engagement.

**E7. `registry_financials` collector — MEDIUM value, MEDIUM effort.** The schema stub (`schema.ts:373-390`) awaits the Central Registry scraper; annual revenue/employees would ground the market-share estimates in real numbers.

**E8. Weekly rollup digest — LOW effort.** The scheduler supports arbitrary times but only day-over-day data; a `days: 7` mode of `dailyDigest` + a weekly schedule is nearly free.

---

## Do these first

1. **A1 — implement product deactivation** (`last_seen_date < runDate → active=false`); it silently corrupts price_assortment, compare_skus, and market-share today.
2. **A2 — make the admin Active toggle real** (`loadTargetsFromDb` WHERE active) — it's an advertised control that does nothing.
3. **A3 — change scheduler matching to `send_at <= hhmm` + not-run-today** — digests currently skip whole days on any missed minute.
4. **B2 + E3 — per-target date alignment in the digest and a freshness stamp** — stops failed scrapes from reading as "competitor went quiet".
5. **B1 — wire or remove the four dead Settings knobs** (especially `digest_enabled`, which an admin reasonably believes stops emails).
