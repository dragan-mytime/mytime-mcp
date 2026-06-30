# Social listener expansion — post content, engagement & estimated reach

**Date:** 2026-06-30
**Status:** Approved (build), iterate on production
**Area:** `ingestion/src/social/*`, `shared/src/*`, `db/src/{schema,writers}.ts` (+migration), a new
MCP tool, and a dashboard "Social" tab.

## Problem

Social listening only persists **account-level aggregates** (followers, following, post count, an
avg-engagement number) in `social_metrics`. The Instagram/TikTok collectors already **fetch recent
posts** from Apify (per-post likes, comments, timestamps) but **discard** the content — captions,
images, per-post engagement, and video view counts are thrown away. So we can't see *what*
competitors post, how individual posts perform, or any reach signal. The brief's ask: posts,
"communication" (captions), images, engagement, and reach.

## Solution

Persist and surface **per-post** social content + engagement, with a **$0 estimated reach** labeled
by source. No paid provider (Apify has no organic-reach mechanism; paid tools only model reach from
the same public signals). Instagram + TikTok are first-class; Facebook is best-effort (thin public
post data); own-brand keeps real numbers via the official Graph API.

### 1. Data model

New `social_posts` table — one row per post per account, **upserted** so re-scrapes refresh
engagement:

```ts
export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id").notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    externalPostId: text("external_post_id").notNull(), // platform post/shortcode id
    capturedDate: date("captured_date").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }), // when the post went live
    postType: text("post_type"),     // image | video | carousel | reel
    caption: text("caption"),
    permalink: text("permalink"),
    mediaUrl: text("media_url"),      // primary image / video thumbnail (time-limited CDN link)
    mediaUrls: jsonb("media_urls"),   // string[] for carousels
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    views: integer("views"),          // public for video/reels/tiktok; null for static
    engagement: integer("engagement"),        // likes + comments + shares
    estimatedReach: integer("estimated_reach"),
    reachSource: text("reach_source"),         // views | estimate | measured (own-brand insights)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_posts_account_external_uq").on(t.socialAccountId, t.externalPostId),
    index("social_posts_account_posted_idx").on(t.socialAccountId, t.postedAt),
  ],
);
```

`social_metrics` (existing, long-format) is unchanged in shape but gains two new metric names:
`avg_engagement_rate` (engagement ÷ followers, %) and `est_reach_avg`.

⚠️ **Media URLs are time-limited** (IG/TikTok CDN links, like FB ad media) — stored but they expire;
durable media hosting is a noted follow-up, not in v1.

### 2. Reach estimation (`estimateReach`)

A pure helper in a shared social module:
- video/reel/tiktok with a public `views` count → `reach = views`, `reachSource = "views"` (a
  genuine measured proxy).
- otherwise → `reach = round(followers × RATE[platform])`, `reachSource = "estimate"`, where
  `RATE` is a documented per-platform organic reach-rate benchmark (e.g. IG ~0.20, FB ~0.10,
  TikTok handled by views). Constants live next to the helper with a comment citing they are
  industry benchmarks, tunable.
- A `ReachProvider` interface is **declared** (one method, `accountReach(handle): Promise<number>`)
  as a future seam, but **no implementation is built** (YAGNI).

### 3. Contract + collectors

- `shared`: add `SocialPostObservation` (the fields above, minus db plumbing) and extend
  `SocialResult` with `posts: SocialPostObservation[]` (keep `metrics`).
- `instagram.ts`: type the full Apify `latestPosts` fields (caption, url/shortCode, displayUrl +
  images, type, likesCount, commentsCount, videoViewCount, timestamp); map each to a
  `SocialPostObservation`; compute `engagement` and `estimateReach`. Keep emitting the existing
  account metrics + add `avg_engagement_rate`.
- `tiktok.ts`: same, from the TikTok actor's video items (views/plays, diggCount, commentCount,
  shareCount, cover image, desc, createTime).
- `facebook.ts`: best-effort — map whatever public post fields the actor returns; if none, emit no
  posts (account metrics only).
- `meta-own.ts` (own brand): add own posts via the Graph API where available, with **real** reach/
  impressions from insights (`reachSource = "measured"`); follower metrics unchanged. Existing ad
  reach (Ad Library ranges) stays in `ad_observations` and is woven into the dashboard separately —
  it is not duplicated into `social_posts`.

### 4. Writer

`writeSocialPosts(db, socialAccountId, runDate, posts)` in `db/src/writers.ts`: chunked upsert on
`(social_account_id, external_post_id)`, updating engagement/reach/caption/media on conflict. The
social orchestrator (`social/index.ts`) calls `ensureSocialAccount` (exists) then both
`writeSocialMetrics` (exists) and the new `writeSocialPosts`.

### 5. Surfacing

- **MCP tool `social_posts`** (analyst): input `{ competitor?, platform?, days?, limit? }`. Returns
  per competitor: posting cadence (posts in the window), avg engagement + engagement-rate, total &
  avg estimated reach, and the top posts (caption, media, type, likes/comments/shares/views,
  engagement, reach, permalink, postedAt). Reach is clearly labeled with its `reachSource`.
- **Dashboard "Social" tab** (`mcp-server/src/admin/pages/dashboard.ts`): per-competitor — a
  follower/cadence summary row + a board of recent post cards (thumbnail, caption, engagement, est.
  reach badge with source), with the existing ad creatives woven in alongside. Reuses the embedded-
  JSON + vanilla-JS pattern.

## Out of scope (v1)

- Paid reach provider (seam only). Digest enrichment (fast-follow). Engagement-over-time history (v1
  keeps latest engagement on the post row). Durable media hosting. Comment-text / sentiment.

## Testing

- Unit: `estimateReach` (views vs follower-benchmark vs null-followers) + the IG/TikTok post
  mappers (fixture actor items → `SocialPostObservation` with correct engagement/reach/source).
- Writer: upsert refreshes engagement on a second run (no duplicate rows).
- Collector tests use saved Apify-response fixtures (no live Apify in tests).
- **Live verification:** run the IG + TikTok collectors for the competitors, confirm `social_posts`
  populates (captions, media, views where expected, reach labeled by source); call `social_posts`
  and load the dashboard Social tab. `pnpm -r build` + tests + Biome clean.

## Success criteria

1. `social_posts` persists per-post content + engagement for IG/TikTok competitors (FB best-effort,
   own-brand with real reach); re-scrapes upsert, no duplicates.
2. Every post carries an `estimated_reach` + `reach_source` (`views` where public, else `estimate`).
3. `social_posts` MCP tool + dashboard Social tab show captions, media, engagement, and labeled
   reach per competitor. Build + tests + Biome clean; no regression to existing social metrics.
