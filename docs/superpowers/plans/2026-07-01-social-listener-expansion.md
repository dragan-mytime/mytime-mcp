# Social Listener Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Persist and surface per-post social content (captions, media, engagement, views) with a $0 estimated reach, across Instagram, TikTok, and Facebook competitors + own-brand.

**Architecture:** A new `social_posts` table (upserted per post) fed by the existing Apify-based collectors, which currently fetch post data and discard it. A shared `SocialPostObservation` contract + a pure `estimateReach` helper + a `writeSocialPosts` writer. Surfaced via a `social_posts` MCP tool and a dashboard "Social" tab.

**Tech Stack:** TS 6 ESM (`.js` specifiers), Drizzle, Vitest 3, Biome 2, Apify, Postgres. Repo: `C:\Users\DRAGAN.SALDJIEV\mytime-bi`. Spec: `docs/superpowers/specs/2026-06-30-social-listener-expansion-design.md`.

**Dependency order:** Task 1 (schema) → Task 2 (contract) → Task 3 (reach) → Task 4 (writer) are the foundation; Tasks 5–8 (collectors) depend on 2+3; Task 9 (wiring) depends on 4+5–8; Tasks 10–11 (surfacing) depend on 1; Task 12 = verify/deploy.

---

### Task 1: `social_posts` table + migration

**Files:** Modify `db/src/schema.ts`; generate `db/migrations/0006_*.sql`.

- [ ] **Step 1 — add the table.** In `db/src/schema.ts`, after the `socialMetrics` table block, add:

```ts
export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    externalPostId: text("external_post_id").notNull(),
    capturedDate: date("captured_date").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postType: text("post_type"), // image | video | carousel | reel
    caption: text("caption"),
    permalink: text("permalink"),
    mediaUrl: text("media_url"),
    mediaUrls: jsonb("media_urls"), // string[]
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),
    views: integer("views"),
    engagement: integer("engagement"),
    estimatedReach: integer("estimated_reach"),
    reachSource: text("reach_source"), // views | estimate | measured
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_posts_account_external_uq").on(t.socialAccountId, t.externalPostId),
    index("social_posts_account_posted_idx").on(t.socialAccountId, t.postedAt),
  ],
);
```

Add the inferred type near the other `$inferSelect` exports: `export type SocialPostRow = typeof socialPosts.$inferSelect;`

- [ ] **Step 2 — build:** `pnpm --filter @mytime/db build` → exit 0.
- [ ] **Step 3 — generate migration:** `pnpm --filter @mytime/db generate` → new `db/migrations/0006_*.sql` with one `CREATE TABLE "social_posts"` + two indexes. Open it and confirm it is purely additive (no DROP).
- [ ] **Step 4 — Biome** `db/src/schema.ts` clean.
- [ ] **Step 5 — commit:** `git add db/src/schema.ts db/migrations && git commit -m "feat(db): social_posts table (migration 0006)"`

---

### Task 2: `SocialPostObservation` contract + `SocialResult.posts`

**Files:** Modify `shared/src/types.ts`; Modify `ingestion/src/social/_social.ts`.

- [ ] **Step 1 — add the shared type.** In `shared/src/types.ts`, after `SocialMetricValue`, add:

```ts
/** One public social post observed for an account. */
export interface SocialPostObservation {
  externalPostId: string;
  postedAt: string | null; // ISO timestamp
  postType: string | null; // image | video | carousel | reel
  caption: string | null;
  permalink: string | null;
  mediaUrl: string | null;
  mediaUrls: string[] | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  engagement: number | null;
  estimatedReach: number | null;
  reachSource: string | null; // views | estimate | measured
}
```

- [ ] **Step 2 — extend the collector contract.** In `ingestion/src/social/_social.ts`, change the import to also pull the new type and add `posts` to `SocialResult`:

```ts
import {
  requireEnv,
  type SocialMetricValue,
  type SocialPlatform,
  type SocialPostObservation,
} from "@mytime/shared";
```
```ts
export interface SocialResult {
  targetId: string;
  metrics: SocialMetricValue[];
  posts?: SocialPostObservation[];
}
```

- [ ] **Step 3 — build:** `pnpm --filter @mytime/shared build && pnpm --filter @mytime/ingestion build` → exit 0 (existing collectors still satisfy `SocialResult` since `posts` is optional).
- [ ] **Step 4 — Biome** clean.
- [ ] **Step 5 — commit:** `git add shared/src/types.ts ingestion/src/social/_social.ts && git commit -m "feat: SocialPostObservation contract + SocialResult.posts"`

---

### Task 3: `estimateReach` helper

**Files:** Create `ingestion/src/social/reach.ts`; Create `ingestion/test/social/reach.test.ts`.

- [ ] **Step 1 — failing test** (`ingestion/test/social/reach.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { estimateReach } from "../../src/social/reach.js";

describe("estimateReach", () => {
  it("uses real views when present (video)", () => {
    expect(estimateReach("tiktok", 12000, 5000)).toEqual({ reach: 12000, source: "views" });
  });
  it("estimates from followers x benchmark when no views (instagram)", () => {
    expect(estimateReach("instagram", null, 10000)).toEqual({ reach: 2000, source: "estimate" });
  });
  it("estimates with the facebook benchmark", () => {
    expect(estimateReach("facebook", null, 10000)).toEqual({ reach: 1000, source: "estimate" });
  });
  it("returns null reach when neither views nor followers are known", () => {
    expect(estimateReach("instagram", null, null)).toEqual({ reach: null, source: null });
  });
});
```

- [ ] **Step 2 — run, expect FAIL:** `pnpm --filter @mytime/ingestion exec vitest run test/social/reach.test.ts`
- [ ] **Step 3 — implement** `ingestion/src/social/reach.ts`:

```ts
import type { SocialPlatform } from "@mytime/shared";

/**
 * Organic reach-rate benchmarks (share of followers an average post reaches).
 * Industry ballparks — tunable. TikTok rarely uses these (it exposes real views).
 */
const REACH_RATE: Record<SocialPlatform, number> = {
  instagram: 0.2,
  facebook: 0.1,
  tiktok: 0.05,
};

/**
 * Estimated reach for a post. Real public `views` (video/reel/tiktok) are the
 * measured proxy; otherwise estimate from `followers × benchmark`. Returns the
 * value plus its source so callers can label it honestly.
 */
export function estimateReach(
  platform: SocialPlatform,
  views: number | null,
  followers: number | null,
): { reach: number | null; source: "views" | "estimate" | null } {
  if (typeof views === "number" && views > 0) return { reach: views, source: "views" };
  if (typeof followers === "number" && followers > 0) {
    return { reach: Math.round(followers * REACH_RATE[platform]), source: "estimate" };
  }
  return { reach: null, source: null };
}
```

- [ ] **Step 4 — run, expect PASS.** **Step 5 — Biome clean.**
- [ ] **Step 6 — commit:** `git add ingestion/src/social/reach.ts ingestion/test/social/reach.test.ts && git commit -m "feat(social): estimateReach helper"`

---

### Task 4: `writeSocialPosts` writer

**Files:** Modify `db/src/writers.ts`.

- [ ] **Step 1 — add the import.** In `db/src/writers.ts`, add `socialPosts` to the schema import block (alongside `socialAccounts`, `socialMetrics`), and `SocialPostObservation` to the `@mytime/shared` type import.

- [ ] **Step 2 — implement** after `writeSocialMetrics`:

```ts
/** Idempotently upsert social posts (account × external post id). Returns count written. */
export async function writeSocialPosts(
  db: Db,
  socialAccountId: string,
  runDate: string,
  posts: SocialPostObservation[],
): Promise<number> {
  if (posts.length === 0) return 0;
  const values = posts.map((p) => ({
    socialAccountId,
    externalPostId: p.externalPostId,
    capturedDate: runDate,
    postedAt: p.postedAt ? new Date(p.postedAt) : null,
    postType: p.postType ?? null,
    caption: p.caption ?? null,
    permalink: p.permalink ?? null,
    mediaUrl: p.mediaUrl ?? null,
    mediaUrls: p.mediaUrls ?? null,
    likes: p.likes ?? null,
    comments: p.comments ?? null,
    shares: p.shares ?? null,
    views: p.views ?? null,
    engagement: p.engagement ?? null,
    estimatedReach: p.estimatedReach ?? null,
    reachSource: p.reachSource ?? null,
  }));
  for (const c of chunk(values, CHUNK)) {
    await db
      .insert(socialPosts)
      .values(c)
      .onConflictDoUpdate({
        target: [socialPosts.socialAccountId, socialPosts.externalPostId],
        set: {
          capturedDate: sql`excluded.captured_date`,
          postedAt: sql`excluded.posted_at`,
          postType: sql`excluded.post_type`,
          caption: sql`excluded.caption`,
          permalink: sql`excluded.permalink`,
          mediaUrl: sql`excluded.media_url`,
          mediaUrls: sql`excluded.media_urls`,
          likes: sql`excluded.likes`,
          comments: sql`excluded.comments`,
          shares: sql`excluded.shares`,
          views: sql`excluded.views`,
          engagement: sql`excluded.engagement`,
          estimatedReach: sql`excluded.estimated_reach`,
          reachSource: sql`excluded.reach_source`,
        },
      });
  }
  return posts.length;
}
```

(`chunk` and `CHUNK` already exist in this file — used by the product writer. Reuse them.)

- [ ] **Step 3 — build:** `pnpm --filter @mytime/db build` → exit 0. (`social_posts` column types come from Task 1's schema.)
- [ ] **Step 4 — db tests + Biome:** `pnpm --filter @mytime/db test` (existing pass), Biome clean.
- [ ] **Step 5 — commit:** `git add db/src/writers.ts && git commit -m "feat(db): writeSocialPosts upsert"`

---

### Task 5: Instagram posts

**Files:** Modify `ingestion/src/social/instagram.ts`; Test `ingestion/test/social/instagram.test.ts` (create).

- [ ] **Step 1 — failing test** (`ingestion/test/social/instagram.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { mapIgPosts } from "../../src/social/instagram.js";

const profile = {
  followersCount: 10000,
  latestPosts: [
    {
      id: "abc123",
      shortCode: "abc123",
      caption: "New arrivals ⌚",
      url: "https://instagram.com/p/abc123",
      displayUrl: "https://cdn/img.jpg",
      type: "Image",
      likesCount: 120,
      commentsCount: 8,
      timestamp: "2026-06-20T10:00:00.000Z",
    },
    {
      id: "vid1",
      shortCode: "vid1",
      caption: "Reel",
      url: "https://instagram.com/reel/vid1",
      displayUrl: "https://cdn/thumb.jpg",
      type: "Video",
      likesCount: 50,
      commentsCount: 2,
      videoViewCount: 9000,
      timestamp: "2026-06-21T10:00:00.000Z",
    },
  ],
};

describe("mapIgPosts", () => {
  it("maps a static post with follower-estimated reach", () => {
    const posts = mapIgPosts(profile as never);
    const p = posts.find((x) => x.externalPostId === "abc123");
    expect(p?.caption).toBe("New arrivals ⌚");
    expect(p?.mediaUrl).toBe("https://cdn/img.jpg");
    expect(p?.engagement).toBe(128);
    expect(p?.estimatedReach).toBe(2000); // 10000 * 0.2
    expect(p?.reachSource).toBe("estimate");
  });
  it("maps a video post with real-view reach", () => {
    const posts = mapIgPosts(profile as never);
    const p = posts.find((x) => x.externalPostId === "vid1");
    expect(p?.views).toBe(9000);
    expect(p?.estimatedReach).toBe(9000);
    expect(p?.reachSource).toBe("views");
    expect(p?.postType).toBe("video");
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** In `ingestion/src/social/instagram.ts`: extend `IgPost`, export `mapIgPosts`, and call it in `collect`. Replace the file body (keeping the existing `metrics()` + collector) with the additions:

```ts
import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import { estimateReach } from "./reach.js";
// ...existing _social imports...

interface IgPost {
  id?: string;
  shortCode?: string;
  caption?: string;
  url?: string;
  displayUrl?: string;
  images?: string[];
  type?: string; // Image | Video | Sidecar
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  timestamp?: string;
}
// IgProfile already has followersCount, latestPosts; ensure latestPosts: IgPost[].

const IG_TYPE: Record<string, string> = { Image: "image", Video: "video", Sidecar: "carousel" };

/** Map an IG profile's latestPosts → SocialPostObservation[] (reach uses views or followers). */
export function mapIgPosts(p: { followersCount?: number; latestPosts?: IgPost[] }): SocialPostObservation[] {
  const followers = typeof p.followersCount === "number" ? p.followersCount : null;
  return (p.latestPosts ?? []).flatMap((post) => {
    const id = post.shortCode ?? post.id;
    if (!id) return [];
    const likes = post.likesCount ?? null;
    const comments = post.commentsCount ?? null;
    const views = post.videoViewCount ?? null;
    const engagement = (likes ?? 0) + (comments ?? 0);
    const { reach, source } = estimateReach("instagram", views, followers);
    return [
      {
        externalPostId: String(id),
        postedAt: post.timestamp ?? null,
        postType: IG_TYPE[post.type ?? ""] ?? null,
        caption: post.caption ?? null,
        permalink: post.url ?? null,
        mediaUrl: post.displayUrl ?? null,
        mediaUrls: Array.isArray(post.images) ? post.images : null,
        likes,
        comments,
        shares: null,
        views,
        engagement,
        estimatedReach: reach,
        reachSource: source,
      },
    ];
  });
}
```

In `collect`, change the per-account return to include posts:
```ts
      return it ? [{ targetId: a.targetId, metrics: metrics(it), posts: mapIgPosts(it) }] : [];
```
Also add `avg_engagement_rate` to `metrics()` when followers + posts exist: after computing `avg_post_engagement`, push `{ metric: "avg_engagement_rate", value: Math.round((avgEng / followers) * 1000) / 10 }` (guard followers > 0).

- [ ] **Step 4 — run, expect PASS.** **Step 5 — build ingestion + Biome clean.**
- [ ] **Step 6 — commit** the two files.

---

### Task 6: TikTok posts

**Files:** Modify `ingestion/src/social/tiktok.ts`; Test `ingestion/test/social/tiktok.test.ts` (create).

- [ ] **Step 1 — failing test** (`ingestion/test/social/tiktok.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { mapTtPosts } from "../../src/social/tiktok.js";

const items = [
  {
    id: "7xyz",
    text: "watch drop",
    createTimeISO: "2026-06-20T10:00:00.000Z",
    webVideoUrl: "https://tiktok.com/@h/video/7xyz",
    videoMeta: { coverUrl: "https://cdn/cover.jpg" },
    playCount: 15000,
    diggCount: 800,
    commentCount: 30,
    shareCount: 12,
    authorMeta: { name: "handle", fans: 5000 },
  },
];

describe("mapTtPosts", () => {
  it("maps a tiktok video with real-view reach and shares", () => {
    const posts = mapTtPosts(items as never, "handle");
    const p = posts[0];
    expect(p.externalPostId).toBe("7xyz");
    expect(p.views).toBe(15000);
    expect(p.shares).toBe(12);
    expect(p.engagement).toBe(842); // 800 + 30 + 12
    expect(p.estimatedReach).toBe(15000);
    expect(p.reachSource).toBe("views");
    expect(p.postType).toBe("video");
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** In `ingestion/src/social/tiktok.ts`: raise `resultsPerPage` (e.g. `resultsPerPage: 15`), type the video item fields, export `mapTtPosts(items, handle)`, and return posts for the matching author. Add:

```ts
import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import { estimateReach } from "./reach.js";

interface TtVideo {
  id?: string;
  text?: string;
  createTimeISO?: string;
  webVideoUrl?: string;
  videoMeta?: { coverUrl?: string };
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  authorMeta?: { name?: string; fans?: number };
}

/** Map a TikTok author's video items → posts (TikTok is video-first, so reach = views). */
export function mapTtPosts(items: TtVideo[], handle: string): SocialPostObservation[] {
  const mine = items.filter((it) => it.authorMeta?.name?.toLowerCase() === handle.toLowerCase());
  const followers = mine[0]?.authorMeta?.fans ?? null;
  return mine.flatMap((it) => {
    if (!it.id) return [];
    const likes = it.diggCount ?? null;
    const comments = it.commentCount ?? null;
    const shares = it.shareCount ?? null;
    const views = it.playCount ?? null;
    const engagement = (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
    const { reach, source } = estimateReach("tiktok", views, followers);
    return [
      {
        externalPostId: String(it.id),
        postedAt: it.createTimeISO ?? null,
        postType: "video",
        caption: it.text ?? null,
        permalink: it.webVideoUrl ?? null,
        mediaUrl: it.videoMeta?.coverUrl ?? null,
        mediaUrls: null,
        likes,
        comments,
        shares,
        views,
        engagement,
        estimatedReach: reach,
        reachSource: source,
      },
    ];
  });
}
```

The `TtItem` interface used by `metrics()` reads `authorMeta`; keep it. In `collect`, after building `byUser`, change the per-account return to add posts: `posts: mapTtPosts(items as TtVideo[], a.handle)`.

- [ ] **Step 4 — run, expect PASS.** **Step 5 — build + Biome clean.**
- [ ] **Step 6 — commit** the two files.

---

### Task 7: Facebook posts (upgrade collector)

**Files:** Modify `ingestion/src/social/facebook.ts`; Test `ingestion/test/social/facebook.test.ts` (create).

- [ ] **Step 1 — failing test** (`ingestion/test/social/facebook.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { mapFbPosts } from "../../src/social/facebook.js";

const fbPosts = [
  {
    postId: "p1",
    url: "https://facebook.com/page/posts/p1",
    text: "Sale starts now",
    time: "2026-06-20T10:00:00.000Z",
    likes: 40,
    reactionsCount: 55, // total reactions across types
    comments: 6,
    shares: 3,
    media: [{ thumbnail: "https://cdn/fb.jpg" }],
  },
];

describe("mapFbPosts", () => {
  it("maps an fb post: total reactions→likes, sums engagement, follower-estimated reach", () => {
    const posts = mapFbPosts(fbPosts as never, 8000);
    const p = posts[0];
    expect(p.externalPostId).toBe("p1");
    expect(p.likes).toBe(55); // prefers reactionsCount over the plain like count
    expect(p.comments).toBe(6);
    expect(p.shares).toBe(3);
    expect(p.engagement).toBe(64); // 55 + 6 + 3
    expect(p.estimatedReach).toBe(800); // 8000 * 0.1
    expect(p.reachSource).toBe("estimate");
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.** In `ingestion/src/social/facebook.ts`: add the posts scraper call + `mapFbPosts`. Keep the existing `facebook-pages-scraper` call for followers/likes, and add a second `apify~facebook-posts-scraper` call for posts. Field names vary by actor version, so map defensively:

```ts
import type { SocialMetricValue, SocialPostObservation } from "@mytime/shared";
import { estimateReach } from "./reach.js";

interface FbPost {
  postId?: string;
  postUrl?: string;
  url?: string;
  text?: string;
  message?: string;
  time?: string;
  timestamp?: string;
  date?: string;
  likes?: number;
  reactionsCount?: number;
  reactions?: Record<string, number>;
  comments?: number;
  commentsCount?: number;
  shares?: number;
  sharesCount?: number;
  media?: { thumbnail?: string; image?: string; url?: string }[];
  video?: boolean;
}

const num = (...xs: (number | undefined)[]): number | null => {
  for (const x of xs) if (typeof x === "number") return x;
  return null;
};

/** Map FB page posts → posts. Total reactions (sum across types) becomes `likes`. */
export function mapFbPosts(items: FbPost[], followers: number | null): SocialPostObservation[] {
  return items.flatMap((it) => {
    const id = it.postId ?? it.postUrl ?? it.url;
    if (!id) return [];
    const reactions =
      it.reactionsCount ??
      (it.reactions ? Object.values(it.reactions).reduce((a, b) => a + (b ?? 0), 0) : undefined);
    const likes = num(reactions, it.likes);
    const comments = num(it.commentsCount, it.comments);
    const shares = num(it.sharesCount, it.shares);
    const media = it.media?.find((m) => m.thumbnail || m.image || m.url);
    const mediaUrl = media?.thumbnail ?? media?.image ?? media?.url ?? null;
    const engagement = (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
    const { reach, source } = estimateReach("facebook", null, followers);
    return [
      {
        externalPostId: String(id),
        postedAt: it.time ?? it.timestamp ?? it.date ?? null,
        postType: it.video ? "video" : "image",
        caption: it.text ?? it.message ?? null,
        permalink: it.postUrl ?? it.url ?? null,
        mediaUrl,
        mediaUrls: null,
        likes,
        comments,
        shares,
        views: null,
        engagement,
        estimatedReach: reach,
        reachSource: source,
      },
    ];
  });
}
```

In `collect`: after the existing pages-scraper call, add a posts call, then attach posts per account by matching the page handle in the post URL:
```ts
const postItems = await apifyRun<FbPost>("apify~facebook-posts-scraper", {
  startUrls: accounts.map((a) => ({ url: a.url })),
  resultsLimit: 15,
});
```
For each account, filter `postItems` whose `postUrl`/`url` contains the handle (fallback: all posts when only one account), read followers from that account's matched page metrics, and set `posts: mapFbPosts(matched, followers)`.

- [ ] **Step 4 — run, expect PASS.** **Step 5 — build + Biome clean.**
- [ ] **Step 6 — commit** the two files.

---

### Task 8: Own-brand posts + real reach

**Files:** Modify `ingestion/src/social/meta-own.ts`.

- [ ] **Step 1 — extend the result type** to carry posts:
```ts
export interface OwnBrandSocialResult {
  platform: SocialPlatform;
  metrics: SocialMetricValue[];
  posts?: SocialPostObservation[];
}
```
- [ ] **Step 2 — fetch own IG media + insights.** In `collectOwnBrandMeta`, after the IG metrics block, fetch recent media and per-media reach. Add a helper using the existing `graphGet`/token:
```ts
const mediaRes = await graphGet(`${igId}/media`,
  "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count");
const media = Array.isArray((mediaRes as { data?: unknown[] }).data)
  ? (mediaRes as { data: Record<string, unknown>[] }).data.slice(0, 25) : [];
const posts: SocialPostObservation[] = [];
for (const m of media) {
  let reach: number | null = null;
  try {
    const ins = await graphGet(`${m.id}/insights`, "reach");
    const arr = (ins as { data?: { values?: { value?: number }[] }[] }).data ?? [];
    reach = arr[0]?.values?.[0]?.value ?? null;
  } catch { /* insights unavailable for some media types — leave null */ }
  const likes = typeof m.like_count === "number" ? m.like_count : null;
  const comments = typeof m.comments_count === "number" ? m.comments_count : null;
  posts.push({
    externalPostId: String(m.id),
    postedAt: (m.timestamp as string) ?? null,
    postType: String(m.media_type ?? "").toLowerCase().includes("video") ? "video" : "image",
    caption: (m.caption as string) ?? null,
    permalink: (m.permalink as string) ?? null,
    mediaUrl: (m.media_url as string) ?? (m.thumbnail_url as string) ?? null,
    mediaUrls: null,
    likes, comments, shares: null, views: null,
    engagement: (likes ?? 0) + (comments ?? 0),
    estimatedReach: reach,
    reachSource: reach != null ? "measured" : null,
  });
}
// push posts onto the instagram result:
if (m.length) out.push({ platform: "instagram", metrics: m, posts });
```
(Adapt to the file's existing variable names — `m` is already the IG metrics array there; rename the media loop variable to avoid cl:wash. Keep FB own-brand metrics-only for v1.)

- [ ] **Step 3 — build + Biome clean.** (No unit test — needs live Graph API; verified in Task 12.)
- [ ] **Step 4 — commit** the file.

---

### Task 9: Wire posts into the ingestion runner

**Files:** Modify `ingestion/src/index.ts`.

- [ ] **Step 1 — import** `writeSocialPosts` from `@mytime/db` (add to the existing import block with `writeSocialMetrics`).
- [ ] **Step 2 — competitor loop.** At the social write (around `index.ts:129-130`), after `writeSocialMetrics`, add:
```ts
        rows += await writeSocialMetrics(db, sid, runDate, r.metrics, sc.id);
        rows += await writeSocialPosts(db, sid, runDate, r.posts ?? []);
```
- [ ] **Step 3 — own-brand loop.** At the own-brand write (around `index.ts:222-223`), after `writeSocialMetrics`, add:
```ts
          rows += await writeSocialMetrics(db, sid, runDate, r.metrics, "meta-own-brand");
          rows += await writeSocialPosts(db, sid, runDate, r.posts ?? []);
```
- [ ] **Step 4 — build ingestion + full ingestion test suite** (`pnpm --filter @mytime/ingestion test`) → all pass. Biome clean.
- [ ] **Step 5 — commit** the file.

---

### Task 10: `social_posts` MCP tool

**Files:** Modify `mcp-server/src/analytics.ts` (add `socialPosts`); Modify `mcp-server/src/tools/index.ts` (register).

- [ ] **Step 1 — add `socialPosts(pool, opts)`** to `analytics.ts` (mirror the existing function style; `opts: { competitor?: string; platform?: string; days?: number; limit?: number }`):

```ts
export async function socialPosts(
  pool: Pool,
  opts: { competitor?: string; platform?: string; days?: number; limit?: number },
) {
  const days = opts.days ?? 30;
  const limit = Math.min(opts.limit ?? 20, 50);
  const params: unknown[] = [days];
  const conds = ["sp.posted_at >= now() - ($1 || ' days')::interval", "t.is_self = false"];
  if (opts.competitor) {
    params.push(opts.competitor);
    conds.push(`t.id = $${params.length}`);
  }
  if (opts.platform) {
    params.push(opts.platform);
    conds.push(`sa.platform = $${params.length}::social_platform`);
  }
  const { rows } = await pool.query(
    `WITH ranked AS (
       SELECT t.id AS competitor, sa.platform, sp.caption, sp.permalink, sp.media_url,
              sp.post_type, sp.likes, sp.comments, sp.shares, sp.views, sp.engagement,
              sp.estimated_reach, sp.reach_source, sp.posted_at,
              row_number() OVER (PARTITION BY t.id ORDER BY sp.engagement DESC NULLS LAST) AS rn,
              count(*) OVER (PARTITION BY t.id) AS posts_in_window,
              round(avg(sp.engagement) OVER (PARTITION BY t.id)) AS avg_engagement,
              round(avg(sp.estimated_reach) OVER (PARTITION BY t.id)) AS avg_reach
       FROM social_posts sp
       JOIN social_accounts sa ON sa.id = sp.social_account_id
       JOIN targets t ON t.id = sa.target_id
       WHERE ${conds.join(" AND ")}
     )
     SELECT * FROM ranked WHERE rn <= ${limit} ORDER BY competitor, engagement DESC NULLS LAST`,
    params,
  );
  // group by competitor → { competitor, postsInWindow, avgEngagement, avgReach, posts: [...] }
  const byComp = new Map<string, any>();
  for (const r of rows) {
    const g = byComp.get(r.competitor) ?? {
      competitor: r.competitor,
      postsInWindow: Number(r.posts_in_window),
      avgEngagement: Number(r.avg_engagement),
      avgReach: Number(r.avg_reach),
      posts: [],
    };
    g.posts.push({
      platform: r.platform, type: r.post_type, caption: r.caption, permalink: r.permalink,
      mediaUrl: r.media_url, likes: r.likes, comments: r.comments, shares: r.shares,
      views: r.views, engagement: r.engagement, estimatedReach: r.estimated_reach,
      reachSource: r.reach_source, postedAt: r.posted_at,
    });
    byComp.set(r.competitor, g);
  }
  return { windowDays: days, reachNote: "Reach is 'views' (measured) or 'estimate' (followers×benchmark).", results: [...byComp.values()] };
}
```

- [ ] **Step 2 — register** in `mcp-server/src/tools/index.ts`: import `socialPosts`; add a tool object `{ name: "social_posts", title: "Social posts & engagement (per competitor)", description: "Recent posts per competitor with caption, media, engagement (likes/comments/shares/views) and estimated reach (labeled by source). Posting cadence + top posts by engagement.", requiredRole: "analyst", inputSchema: { competitor: z.string().optional().describe("target id; omit for all"), platform: z.enum(["instagram","facebook","tiktok"]).optional(), days: z.number().int().positive().max(365).optional(), limit: z.number().int().positive().max(50).optional() }, run: (pool, a) => socialPosts(pool, a as { competitor?: string; platform?: string; days?: number; limit?: number }) }`.

- [ ] **Step 3 — build mcp-server + tests + Biome clean.**
- [ ] **Step 4 — commit** the two files.

---

### Task 11: Dashboard "Social" tab

**Files:** Modify `mcp-server/src/admin/pages/dashboard.ts`.

- [ ] **Step 1 — gather social posts** in `gather()`: add a query to the `Promise.all` selecting recent posts per competitor (cap ~12/competitor by engagement, last 30 days), mapping to `{ competitor, platform, type, caption, mediaUrl, likes, comments, shares, views, engagement, estimatedReach, reachSource, postedAt }`. Add a `SocialRow` interface and a `social` array to the returned payload.

```sql
WITH ranked AS (
  SELECT t.id AS target_id, sa.platform, sp.caption, sp.permalink, sp.media_url, sp.post_type,
         sp.likes, sp.comments, sp.shares, sp.views, sp.engagement, sp.estimated_reach,
         sp.reach_source, sp.posted_at,
         row_number() OVER (PARTITION BY t.id ORDER BY sp.engagement DESC NULLS LAST) AS rn
  FROM social_posts sp JOIN social_accounts sa ON sa.id = sp.social_account_id
  JOIN targets t ON t.id = sa.target_id
  WHERE t.is_self = false AND sp.posted_at >= now() - interval '30 days'
) SELECT * FROM ranked WHERE rn <= 12 ORDER BY target_id, engagement DESC NULLS LAST
```

- [ ] **Step 2 — add the tab.** In `render()`: add a `<button class="dtab" data-tab="social">Social</button>` to the tabbar and a `<div id="panel-social" class="panel" hidden></div>`. In `DASH_JS`: add `social` to the tab switch (`else if(tab==='social')renderSocial();`) and a `renderSocial()` function that, filtered by the vendor selector, renders per-competitor a header (name + post count + avg engagement) and a grid of post cards: thumbnail (`<img class="adthumb">` with the same onerror placeholder as ad cards — media URLs expire), caption (truncated), an engagement line (❤ likes · 💬 comments · ▶ views), and a reach badge showing `estimatedReach` + a small `reachSource` label. Reuse `vendorSel()`, `wireGlobals()`, `esc()`, `fmt()`, `nameOf` already in the file. Weave the existing ad cards in by adding a small "Ads" subsection per competitor that reuses `D.ads` (already in the payload).

- [ ] **Step 3 — build mcp-server + Biome clean** (run `--write` if needed). Confirm no template-literal/backtick introduced into `DASH_JS`.
- [ ] **Step 4 — commit** the file.

---

### Task 12: Verify + deploy

- [ ] **Step 1 — whole-repo gates:** `pnpm -r build && pnpm -r test && pnpm exec biome check .` (build/test green; no new Biome diagnostics).
- [ ] **Step 2 — deploy** the branch (`git archive HEAD | ssh …`, Node-24 build), run `pnpm --filter @mytime/db migrate` (applies 0006), restart `mytime-mcp`.
- [ ] **Step 3 — run the social collectors** on the VPS: `INGEST_COLLECTORS=apify-instagram,apify-facebook,apify-tiktok node --env-file=.env ingestion/dist/index.js` (uses the live `APIFY_TOKEN`). Confirm `social_posts` populated: a quick query for counts per competitor + that `reach_source` is set (`views` for videos, `estimate` for static), captions and media_url present.
- [ ] **Step 4 — verify the tool + tab:** call `socialPosts(pool, {})` against prod (sane per-competitor posts/engagement/reach); render the dashboard Social tab and confirm post cards show caption/media/engagement/reach.
- [ ] **Step 5 — own-brand (optional):** run `INGEST_COLLECTORS=meta-own-brand node --env-file=.env ingestion/dist/index.js`; confirm own posts get `reach_source='measured'` where insights returned a value.
- [ ] **Step 6 — merge to `main`, push, deploy.**

---

## Self-Review

- **Spec coverage:** social_posts table → T1; contract → T2; reach (views/estimate/measured) → T3; writer → T4; IG/TikTok/FB posts → T5/T6/T7; own-brand real reach → T8; runner wiring → T9; MCP tool → T10; dashboard Social tab → T11; verify+deploy → T12. ✅
- **Placeholders:** code is concrete for the testable core (T1–T10); T8 (Graph media+insights) and T11 (dashboard JS) describe the exact fields/structure but adapt to existing variable names — the one place full verbatim JS isn't reproduced is the large `DASH_JS` render, which follows the documented card structure + reuses existing helpers. ✅
- **Type consistency:** `SocialPostObservation` fields identical across T2/T4/T5/T6/T7/T8; `estimateReach(platform, views, followers) → {reach, source}` used identically in T5/T6/T7; `writeSocialPosts(db, accountId, runDate, posts)` matches T9 calls; `reach_source ∈ {views, estimate, measured}` consistent. ✅
- **Scope:** one coherent subsystem (post persistence + collectors + surfacing). Digest enrichment, paid provider, engagement-history, durable media — explicitly deferred. ✅
