# Own-brand Social Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per task + two-stage review. Steps use `- [ ]`.

**Goal:** Make `mytime` a first-class target in `social_posts` + `social_benchmark` (engagement/cadence), populated from the existing Meta Graph API, comparable to competitors via a shared `engagementRate`.

**Architecture:** Own data already flows through the ingestion `meta-own` collector into the same `social_posts` table (schema parity solved). Expand that collector (FB posts + graceful measured/estimate reach), stop filtering `is_self` out of the tools, and add `engagementRate` + the missing benchmark metrics. No live Meta fetch in the MCP handler.

**Graph v23.0 facts (probed live):** IG media insights are permission-denied today (`#10`) → fall back to estimate, auto-upgrade to measured when granted. FB reach metrics retired (`#100`); FB organic engagement via `post_activity_by_action_type` works (returns `{like, share, comment,…}`). Spec: `docs/superpowers/specs/2026-07-01-own-brand-social-benchmark-design.md`.

**Order:** Task 1 (collector) → Task 2 (socialPosts) → Task 3 (socialBenchmark) → Task 4 (verify/deploy).

---

### Task 1 — Own FB posts + graceful measured/estimate reach (`meta-own.ts`)

**Files:** Modify `ingestion/src/social/meta-own.ts`; Create `ingestion/test/social/meta-own.test.ts`.

- [ ] **Step 1 — failing test** (`ingestion/test/social/meta-own.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { mapFbActions, mapIgOwnPost } from "../../src/social/meta-own.js";

describe("mapFbActions", () => {
  it("splits organic action counts into likes/comments/shares + engagement", () => {
    expect(mapFbActions({ like: 9, share: 1, comment: 2 }, 8000)).toMatchObject({
      likes: 9,
      comments: 2,
      shares: 1,
      engagement: 12,
      estimatedReach: 800, // 8000 * 0.1 (fb reach retired → estimate)
      reachSource: "estimate",
    });
  });
  it("returns null engagement when the action map is empty", () => {
    expect(mapFbActions({}, 8000).engagement).toBeNull();
  });
});

describe("mapIgOwnPost reach basis", () => {
  const base = { id: "m1", like_count: 10, comments_count: 2, timestamp: "2026-06-30T10:00:00+0000", media_type: "IMAGE" };
  it("uses measured reach when the insight returns a value", () => {
    const p = mapIgOwnPost(base as never, { reach: 5000, views: null, shares: 3 }, 10000);
    expect(p.estimatedReach).toBe(5000);
    expect(p.reachSource).toBe("measured");
    expect(p.shares).toBe(3);
    expect(p.engagement).toBe(15); // 10 + 2 + 3
  });
  it("falls back to estimate when insights are unavailable (today's #10)", () => {
    const p = mapIgOwnPost(base as never, { reach: null, views: null, shares: null }, 10000);
    expect(p.estimatedReach).toBe(2000); // 10000 * 0.2
    expect(p.reachSource).toBe("estimate");
    expect(p.engagement).toBe(12); // 10 + 2
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement in `ingestion/src/social/meta-own.ts`:**
  (a) import `estimateReach` from `./reach.js`.
  (b) Add exported pure mappers:

```ts
/** FB organic engagement from post_activity_by_action_type → the competitor field shape. */
export function mapFbActions(
  acts: Record<string, number>,
  followers: number | null,
): { likes: number | null; comments: number | null; shares: number | null; engagement: number | null; estimatedReach: number | null; reachSource: string | null } {
  const g = (k: string) => (typeof acts[k] === "number" ? acts[k] : null);
  const likes = g("like");
  const comments = g("comment");
  const shares = g("share");
  const engagement =
    likes === null && comments === null && shares === null
      ? null
      : (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
  const { reach, source } = estimateReach("facebook", null, followers); // FB post reach retired in v23
  return { likes, comments, shares, engagement, estimatedReach: reach, reachSource: source };
}

/** IG own post: measured reach when insights are permitted, else the followers-benchmark estimate. */
export function mapIgOwnPost(
  post: { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number },
  ins: { reach: number | null; views: number | null; shares: number | null },
  followers: number | null,
): import("@mytime/shared").SocialPostObservation {
  const likes = typeof post.like_count === "number" ? post.like_count : null;
  const comments = typeof post.comments_count === "number" ? post.comments_count : null;
  const shares = ins.shares;
  const isVideo = String(post.media_type ?? "").toUpperCase().includes("VIDEO");
  const engagement =
    likes === null && comments === null && shares === null
      ? null
      : (likes ?? 0) + (comments ?? 0) + (shares ?? 0);
  const measured = ins.reach != null;
  const est = estimateReach("instagram", ins.views, followers);
  return {
    externalPostId: String(post.id),
    postedAt: post.timestamp ?? null,
    postType: isVideo ? "video" : "image",
    caption: post.caption ?? null,
    permalink: post.permalink ?? null,
    mediaUrl: post.media_url ?? post.thumbnail_url ?? null,
    mediaUrls: null,
    likes,
    comments,
    shares,
    views: ins.views,
    engagement,
    estimatedReach: measured ? ins.reach : est.reach,
    reachSource: measured ? "measured" : est.source,
  };
}
```

  (c) Add a `graphInsightObj(postId, metric)` helper (returns the value OBJECT, for `post_activity_by_action_type`), alongside the existing `graphInsight`:

```ts
async function graphInsightObj(id: string, metric: string): Promise<Record<string, number> | null> {
  const token = requireEnv("META_ACCESS_TOKEN");
  const url = `${GRAPH}/${id}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json()) as { data?: { values?: { value?: unknown }[] }[]; error?: unknown };
  if (json.error) return null;
  const v = json.data?.[0]?.values?.[0]?.value;
  return v && typeof v === "object" ? (v as Record<string, number>) : null;
}
```

  (d) Rewrite the IG media loop to use `mapIgOwnPost` with a per-post insight pull (try/catch already wraps the block): for each media, `const ins = { reach: await graphInsight(id, "reach"), views: await graphInsight(id, "views"), shares: await graphInsight(id, "shares") };` then `posts.push(mapIgOwnPost(post, ins, igFollowers))` where `igFollowers` is the `followers_count` read for the account. Cap `.slice(0, 25)` stays; a comment notes 90-day paging is a follow-up bounded by competitor coverage.

  (e) Replace the FB block: after reading page `followers_count`/`fan_count` metrics, fetch posts:
```ts
    const fbPosts: SocialPostObservation[] = [];
    try {
      const res = await graphGet(
        `${pageId}/published_posts`,
        "id,message,created_time,permalink_url,full_picture",
      );
      const items = Array.isArray((res as { data?: unknown[] }).data)
        ? (res as { data: Record<string, unknown>[] }).data.slice(0, 25)
        : [];
      const fbFollowers = typeof fb.followers_count === "number" ? fb.followers_count : null;
      for (const post of items) {
        const acts = (await graphInsightObj(String(post.id), "post_activity_by_action_type")) ?? {};
        const e = mapFbActions(acts, fbFollowers);
        fbPosts.push({
          externalPostId: String(post.id),
          postedAt: (post.created_time as string) ?? null,
          postType: "image",
          caption: (post.message as string) ?? null,
          permalink: (post.permalink_url as string) ?? null,
          mediaUrl: (post.full_picture as string) ?? null,
          mediaUrls: null,
          likes: e.likes,
          comments: e.comments,
          shares: e.shares,
          views: null,
          engagement: e.engagement,
          estimatedReach: e.estimatedReach,
          reachSource: e.reachSource,
        });
      }
    } catch {
      // published_posts/insights unavailable — page metrics still write.
    }
    if (m.length || fbPosts.length) out.push({ platform: "facebook", metrics: m, posts: fbPosts });
```
  (replacing the old FB `if (m.length) out.push({ platform:"facebook", metrics:m })`).

- [ ] **Step 4 — run, expect PASS.** **Step 5 — build ingestion + full suite + Biome clean.**
- [ ] **Step 6 — commit** the two files.

---

### Task 2 — `socialPosts`: include mytime + engagementRate (`mcp-server/src/analytics.ts`)

**Files:** Modify `mcp-server/src/analytics.ts`.

- [ ] **Step 1 — remove the exclusion + add followers/engagementRate.** In `socialPosts`, change the `conds` array to drop `"t.is_self = false"` (keep the window + optional competitor/platform filters). In the `ranked` CTE, add a lateral join for the account's latest follower count and compute engagementRate:

```sql
       FROM social_posts sp
       JOIN social_accounts sa ON sa.id = sp.social_account_id
       JOIN targets t ON t.id = sa.target_id
       LEFT JOIN LATERAL (
         SELECT value::numeric AS followers FROM social_metrics sm
         WHERE sm.social_account_id = sa.id AND sm.metric = 'followers'
         ORDER BY sm.captured_date DESC LIMIT 1
       ) f ON true
```
Add to the `ranked` SELECT list: `round(100.0 * sp.engagement / NULLIF(f.followers,0), 2) AS engagement_rate` and window aggregate `round(avg(100.0 * sp.engagement / NULLIF(f.followers,0)) OVER (PARTITION BY t.id), 2) AS avg_engagement_rate`.

- [ ] **Step 2 — thread the new fields through the JS mapping.** Add `engagement_rate`/`avg_engagement_rate` to `SocialPostQueryRow`. Add `avgEngagementRate: r.avg_engagement_rate === null ? null : Number(r.avg_engagement_rate)` to each competitor group object, and `engagementRate: r.engagement_rate` to each post. Update `reachNote` to: `"Compare on engagementRate (engagement ÷ followers) — reach is 'views' (measured) or 'estimate' (followers×benchmark) or 'measured' (own-brand insights when permitted)."`

- [ ] **Step 3 — build mcp-server + tests + Biome clean.** **Step 4 — commit.**

---

### Task 3 — `socialBenchmark`: engagement + cadence metrics (`mcp-server/src/analytics.ts`)

**Files:** Modify `mcp-server/src/analytics.ts`.

- [ ] **Step 1 — branch on metric.** At the top of `socialBenchmark`, if `metric === "engagement" || metric === "cadence"`, compute from `social_posts` (last 30d, all targets incl mytime) instead of `social_metrics`:

```ts
  if (metric === "engagement" || metric === "cadence") {
    const p: unknown[] = [];
    let pf = "";
    if (opts.platform) {
      p.push(opts.platform);
      pf = `AND sa.platform = $${p.length}::social_platform`;
    }
    const { rows } = await pool.query(
      `SELECT t.id AS target_id, sa.platform,
              count(*)::int AS posts_in_window,
              round(avg(sp.engagement)) AS avg_engagement,
              round(avg(100.0 * sp.engagement / NULLIF(fol.followers,0)), 2) AS avg_engagement_rate
       FROM social_posts sp
       JOIN social_accounts sa ON sa.id = sp.social_account_id
       JOIN targets t ON t.id = sa.target_id
       LEFT JOIN LATERAL (
         SELECT value::numeric AS followers FROM social_metrics sm
         WHERE sm.social_account_id = sa.id AND sm.metric = 'followers'
         ORDER BY sm.captured_date DESC LIMIT 1
       ) fol ON true
       WHERE sp.posted_at >= now() - interval '30 days' ${pf}
       GROUP BY t.id, sa.platform ORDER BY t.id, sa.platform`,
      p,
    );
    return {
      metric,
      platform: opts.platform ?? "all",
      note:
        metric === "cadence"
          ? "Posts per target×platform in the last 30 days (posting cadence), incl. MY:TIME."
          : "Avg engagement + engagementRate (engagement÷followers) per target×platform, last 30 days, incl. MY:TIME. Prefer engagementRate for cross-comparison.",
      rows,
    };
  }
```

- [ ] **Step 2 — keep the existing `social_metrics` path** for all other metrics (followers, etc.) unchanged, but update its `note` to drop the "Step F" placeholder: `"Latest social metrics per target×platform (own-brand + competitors)."`

- [ ] **Step 3 — build + tests + Biome clean.** **Step 4 — commit.**

---

### Task 4 — Verify + deploy  *(controller-run)*

- [ ] Whole-repo `pnpm -r build && pnpm -r test && pnpm exec biome check .` (green; no new diagnostics).
- [ ] Deploy the branch to the VPS (`git archive`, Node-24 build), restart `mytime-mcp`. (No migration — no schema change.)
- [ ] Run the own-brand collector: `INGEST_COLLECTORS=meta-own-brand node --env-file=.env ingestion/dist/index.js`. Confirm `mytime` FB + IG posts land in `social_posts` with organic engagement and `reachSource='estimate'` (today).
- [ ] Live-verify via the analytics fns against prod: `socialPosts({})` includes a `mytime` block with `avgEngagementRate` + posts; `socialPosts({competitor:'mytime'})` works; `socialBenchmark({metric:'engagement'})` and `({metric:'cadence'})` return non-empty rows incl `mytime`; competitor rows unchanged (spot check one competitor's counts vs before). Spot-check the Karl Lagerfeld FB post's engagement is organic.
- [ ] Merge to `main`, push. (Note: MCP reads now hit primary, so the tool sees the data immediately.)

---

## Self-Review
- **Spec coverage:** include mytime → T2/T3; own FB posts + graceful measured/estimate → T1; engagement parity (likes+comments+shares organic) → T1; engagementRate everywhere → T2/T3; fill benchmark engagement/cadence → T3; verify/deploy/organic-check → T4. ✅
- **Placeholders:** code is concrete; the 90-day paging is explicitly a bounded follow-up (competitor coverage is scraper-limited), not a gap. ✅
- **Type consistency:** `mapFbActions(acts, followers)→{likes,comments,shares,engagement,estimatedReach,reachSource}`, `mapIgOwnPost(post, ins, followers)→SocialPostObservation`, `engagement=likes+comments+(shares??0)` identical to competitors; `engagementRate` = `round(100*engagement/NULLIF(followers,0),2)` used identically in T2/T3; `reachSource` ∈ {views,estimate,measured}. The measured path auto-activates (ins.reach != null). ✅
