# Own-brand in the social benchmark (mytime as a first-class target)

**Date:** 2026-07-01
**Status:** Approved (build)
**Area:** `ingestion/src/social/meta-own.ts`, `mcp-server/src/analytics.ts` (`socialPosts` +
`socialBenchmark`), a 90-day own-brand backfill.

## Problem

`social_posts` and `social_benchmark`'s engagement/cadence paths return **competitors only** — MY:TIME
is absent, so the tools can't do their actual job (benchmarking). The own-brand data path already
exists (the `meta-own` collector writes own IG posts into the **same `social_posts` table**; 25 are
there now), but: (a) `socialPosts` filters `t.is_self = false`, excluding `mytime`; (b) own FB posts
aren't collected; (c) `social_benchmark` has no `engagement`/`cadence` metric (returns `[]`), with a
"Step F / official APIs" placeholder note; (d) no `engagementRate`.

## Graph API reality (probed live against our token, v23.0)

The brief assumed measured reach + `post_impressions_organic`; **neither is available to us now:**
- **IG media insights are permission-blocked** (`#10 Application does not have permission` for
  `reach`/`views`/`saved`/`shares`/`total_interactions`) — needs `instagram_manage_insights` via
  Meta App Review. Basic media fields (`like_count`, `comments_count`, caption, media, permalink)
  **do** work. (So the 25 existing own IG posts have `reach = null`.)
- **FB post reach metrics are retired** in v23 (`post_impressions_organic_unique` → `#100 not a
  valid insights metric`). Available and working: **`post_activity_by_action_type`** (organic
  like/share/comment counts) and `post_clicks`. Post comment/reaction summaries need
  `pages_read_user_content` (also denied).

**Consequence:** measured reach is not obtainable today. The honest, fully-available cross-metric is
**`engagementRate = engagement / followers`** (organic engagement is available for both own and
competitors). Reach stays the **same followers×benchmark estimate for every target** (apples-to-
apples), with a capability path that auto-upgrades own reach to `measured` if the permission lands.

## Solution

### 1. Include `mytime` (stop filtering it out)
- `socialPosts`: remove the `t.is_self = false` clause (include all targets). `socialPosts({competitor:"mytime"})` then works via the existing `t.id = $N` filter.
- Data merge is already at the **data layer** — both the competitor scraper and the own-brand Meta
  collector write `SocialPostObservation`s into `social_posts`. No live Meta fetch in the MCP
  handler (slow/rate-limited); the tool just reads the table.

### 2. Expand `meta-own.ts` (own FB posts + graceful measured-reach)
- **Facebook posts:** fetch `${pageId}/published_posts?fields=id,message,created_time,permalink_url,full_picture`
  (paged, 90 days). Per post, `engagement` = sum of `post_activity_by_action_type` values
  (organic like+comment+share; missing keys → 0). `mediaUrl` = `full_picture`. `views/shares`
  broken out where the action-type map provides them; `reach` = `estimateReach("facebook", null,
  followers)` (FB reach retired) → `reachSource:"estimate"`. Flag in a comment that FB organic
  reach is not API-available in v23.
- **Instagram posts (enrich):** keep the working media fields. **Try** `graphInsight(mediaId, m)`
  for `reach`, `views`, `shares`, `saved` inside try/catch:
  - if a call returns a value → use it (`views` where present; `reach` → `reachSource:"measured"`;
    add `shares` to engagement). This is the **capability path that auto-activates** once
    `instagram_manage_insights` is granted — no config flag.
  - if it errors/denied (today's `#10`) → `reach = estimateReach("instagram", views, followers)`,
    `reachSource:"estimate"`. Never throw on insight denial.
- **Engagement parity:** `engagement = likes + comments + (shares ?? 0)` — the SAME formula
  competitors use (null only when no interaction data). Organic by construction (Meta own-action
  counts + public like/comment counts are organic; MY:TIME's paid runs as separate Ad-Library ads,
  not per-post boosts — noted as the organic-isolation caveat for IG).
- Own posts already flow to `social_posts(mytime)` via the runner (T9 wiring) — unchanged.

### 3. `engagementRate` on every row
- `engagementRate = engagement / followers`, computed for **all** targets. Followers come from the
  latest `social_metrics.followers` per account (own + competitors). Added per-post and as
  `avgEngagementRate` in the aggregates. Surfaced as the **preferred comparison metric** in the
  tool's `reachNote`/summary; reach stays labeled by source so measured-vs-estimate is never
  silently compared.

### 4. Fill `social_benchmark` `engagement` + `cadence`
- When `metric = "engagement"`: compute per target×platform from `social_posts` (last 30d):
  `avgEngagement`, `avgEngagementRate`, `postsInWindow` — including `mytime`.
- When `metric = "cadence"`: posts-per-window (posting frequency) per target×platform, incl `mytime`.
- Other metrics (`followers`, …) keep reading `social_metrics` (already includes own-brand). Replace
  the "Step F" note with an honest reach/engagement-basis note.

### 5. Operational
- Own pull runs in the **nightly ingest** (daily snapshot cadence — already wired). Add a **90-day**
  IG/FB `/media`/`published_posts` backfill via paging cursors so the lookback matches competitors
  (note: competitor coverage is scraper-limited to ~recent posts, so own is capped similarly for
  fairness — don't over-collect own beyond the comparable window).
- **Rate limits:** sequential per-post insight calls with a small backoff on `#4`/`#17`/`#32`
  throttling errors; cap posts per run.
- **Token:** long-lived Page token in `META_ACCESS_TOKEN` (env, never hardcoded); add a startup
  validity check (`/me`), and an optional refresh via `/oauth/access_token` (app id/secret) if a
  short-lived token is ever detected. Log a clear warning if insights return `#10` (permission not
  yet granted) so the measured-reach upgrade path is observable.

## Testing
- Unit: FB `post_activity_by_action_type` → engagement summing (fixture); the IG insight-or-estimate
  fallback (fixture where insight returns a value → measured; fixture where it throws → estimate);
  `engagementRate` computation (incl. followers = 0/null → null).
- `socialPosts`/`socialBenchmark` query changes: mytime included; competitor rows unchanged (a
  regression assertion).
- **Live verification:** run the own-brand collector; confirm `mytime` FB + IG posts land in
  `social_posts` with organic engagement + `reachSource:"estimate"` (today); `socialPosts({})` and
  `socialPosts({competitor:"mytime"})` return a `mytime` block; `socialBenchmark({metric:"engagement"})`
  and `({metric:"cadence"})` return non-empty rows incl `mytime`; spot-check one recent MY:TIME post
  (e.g. the Karl Lagerfeld FB post) that engagement is organic-only. `pnpm -r build` + tests + Biome.

## Success criteria
1. `socialPosts` (no arg) includes a `mytime` block (postsInWindow, avgEngagement, avgReach,
   avgEngagementRate, posts[]); `socialPosts({competitor:"mytime"})` works.
2. `socialBenchmark({metric:"engagement"})` and `({metric:"cadence"})` return non-empty rows
   including `mytime`.
3. `engagementRate` on all rows; `engagement` organic and identical-formula to competitors.
4. Own reach is `"estimate"` today, and **auto-flips to `"measured"`** for `mytime` if/when the IG
   insights permission is granted (no code change) — the measured path is present but degrades
   gracefully.
5. No regression to competitor rows. Build + tests + Biome clean.

## Out of scope
- Meta App Review to unlock `instagram_manage_insights` / `pages_read_user_content` (external; the
  code is ready to consume them). Paid/boosted reach attribution. Video-view measured reach for FB.
