/**
 * SQL regression tests for socialPosts + socialBenchmark (B5, B6, B9):
 *   B5 — per-platform aggregates (not blended across IG+FB)
 *   B9 — pctEstimatedReach in perPlatform, top-level aggregate, and benchmark rows
 *   B6 — postsPerWeek derived from timestamp span in socialBenchmark cadence
 *
 * Executed against a real Postgres engine (PGlite). Same pattern as
 * analytics-depletion.test.ts and data-health.test.ts.
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@mytime/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { socialBenchmark, socialPosts } from "../src/analytics.js";

let db: PGlite;
let pool: Pool;

beforeAll(async () => {
  db = new PGlite();
  pool = { query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as Pool;

  // PGlite does not ship with the social_platform enum; create it so the ::social_platform
  // casts inside socialPosts/socialBenchmark are accepted.
  await db.exec(`
    CREATE TYPE social_platform AS ENUM ('instagram','facebook','tiktok');

    CREATE TABLE targets (
      id text PRIMARY KEY, name text, is_self boolean NOT NULL DEFAULT false
    );

    CREATE TABLE social_accounts (
      id text PRIMARY KEY,
      target_id text NOT NULL REFERENCES targets(id),
      platform social_platform NOT NULL
    );

    CREATE TABLE social_metrics (
      id text PRIMARY KEY,
      social_account_id text NOT NULL REFERENCES social_accounts(id),
      metric text NOT NULL,
      value text NOT NULL,
      captured_date date NOT NULL
    );

    CREATE TABLE social_posts (
      id text PRIMARY KEY,
      social_account_id text NOT NULL REFERENCES social_accounts(id),
      external_post_id text,
      caption text,
      permalink text,
      media_url text,
      post_type text,
      likes int,
      comments int,
      shares int,
      views int,
      engagement int,
      estimated_reach int,
      reach_source text,
      posted_at timestamptz NOT NULL
    );

    -- Targets
    -- alpha: IG (measured reach) + FB (estimated reach)
    -- beta:  IG only (mix of measured + estimated reach)
    INSERT INTO targets VALUES ('alpha','Alpha Co',false),('beta','Beta Co',false);

    -- social_accounts
    INSERT INTO social_accounts VALUES
      ('a-ig', 'alpha', 'instagram'),
      ('a-fb', 'alpha', 'facebook'),
      ('b-ig', 'beta',  'instagram');

    -- followers (latest snapshot for each account)
    INSERT INTO social_metrics VALUES
      ('m1','a-ig','followers','1000', current_date),
      ('m2','a-fb','followers','2000', current_date),
      ('m3','b-ig','followers','500',  current_date);

    -- alpha IG: 3 posts, all reach_source='views' (measured)
    --   engagements: 100, 50, 25  → avg = 58 (rounded), engRate per post: 10.00, 5.00, 2.50
    --   avg engRate = avg(10.00+5.00+2.50)/3 = 5.83
    INSERT INTO social_posts VALUES
      ('p1','a-ig','e1',null,null,null,'image',90,10,0,0,100,900,'views',
       now() - interval '5 days'),
      ('p2','a-ig','e2',null,null,null,'image',45,5,0,0,50,450,'views',
       now() - interval '15 days'),
      ('p3','a-ig','e3',null,null,null,'image',22,3,0,0,25,225,'views',
       now() - interval '25 days');

    -- alpha FB: 2 posts, both reach_source='estimate'
    --   engagements: 200, 100  → avg = 150, engRate: 10.00, 5.00  → avg = 7.50
    INSERT INTO social_posts VALUES
      ('p4','a-fb','e4',null,null,null,'image',180,20,0,0,200,4000,'estimate',
       now() - interval '8 days'),
      ('p5','a-fb','e5',null,null,null,'image',90,10,0,0,100,2000,'estimate',
       now() - interval '20 days');

    -- beta IG: 2 posts — one 'estimate', one 'views'
    --   engagements: 60, 40  → avg = 50
    INSERT INTO social_posts VALUES
      ('p6','b-ig','e6',null,null,null,'image',55,5,0,0,60,100,'estimate',
       now() - interval '3 days'),
      ('p7','b-ig','e7',null,null,null,'image',35,5,0,0,40,300,'views',
       now() - interval '10 days');
  `);
});

afterAll(async () => {
  await db.close();
});

// ─── helpers ───────────────────────────────────────────────────────────────

type SpResult = Awaited<ReturnType<typeof socialPosts>>;
type SpGroup = SpResult["results"][number];

function groupFor(res: SpResult, competitor: string): SpGroup | undefined {
  return res.results.find((g) => g.competitor === competitor);
}

function ppFor(g: SpGroup, platform: string): SpGroup["perPlatform"][number] | undefined {
  return g.perPlatform.find((p) => p.platform === platform);
}

// ─── socialPosts: top-level (backwards-compat) fields ─────────────────────

describe("socialPosts — top-level cross-platform fields (B5 backwards-compat)", () => {
  it("emits postsInWindow, avgEngagement, avgReach, avgEngagementRate for each competitor", async () => {
    const res = await socialPosts(pool, {});
    const alpha = groupFor(res, "alpha");
    expect(alpha).toBeDefined();
    // alpha has 5 posts total (3 IG + 2 FB)
    expect(alpha!.postsInWindow).toBe(5);
    // cross-platform avg engagement = (100+50+25+200+100)/5 = 475/5 = 95
    expect(alpha!.avgEngagement).toBe(95);
  });

  it("pctEstimatedReach at top level: alpha has 2/5 posts estimated = 40%", async () => {
    const res = await socialPosts(pool, {});
    const alpha = groupFor(res, "alpha");
    expect(alpha!.pctEstimatedReach).toBe(40);
  });

  it("pctEstimatedReach: beta has 1/2 posts estimated = 50%", async () => {
    const res = await socialPosts(pool, {});
    const beta = groupFor(res, "beta");
    expect(beta!.pctEstimatedReach).toBe(50);
  });
});

// ─── socialPosts: perPlatform blocks (B5) ─────────────────────────────────

describe("socialPosts — perPlatform blocks (B5)", () => {
  it("alpha has perPlatform entries for both instagram and facebook", async () => {
    const res = await socialPosts(pool, {});
    const alpha = groupFor(res, "alpha");
    expect(alpha!.perPlatform).toHaveLength(2);
    const platforms = alpha!.perPlatform.map((p) => p.platform).sort();
    expect(platforms).toEqual(["facebook", "instagram"]);
  });

  it("alpha IG perPlatform: postsInWindow=3, pctEstimatedReach=0 (all views)", async () => {
    const res = await socialPosts(pool, {});
    const ig = ppFor(groupFor(res, "alpha")!, "instagram");
    expect(ig).toBeDefined();
    expect(ig!.postsInWindow).toBe(3);
    expect(ig!.pctEstimatedReach).toBe(0);
    // avg engagement IG = (100+50+25)/3 = 58 (rounded)
    expect(ig!.avgEngagement).toBe(58);
  });

  it("alpha FB perPlatform: postsInWindow=2, pctEstimatedReach=100 (all estimate)", async () => {
    const res = await socialPosts(pool, {});
    const fb = ppFor(groupFor(res, "alpha")!, "facebook");
    expect(fb).toBeDefined();
    expect(fb!.postsInWindow).toBe(2);
    expect(fb!.pctEstimatedReach).toBe(100);
    // avg engagement FB = (200+100)/2 = 150
    expect(fb!.avgEngagement).toBe(150);
  });

  it("alpha FB perPlatform avgEngagementRate uses FB followers (2000)", async () => {
    const res = await socialPosts(pool, {});
    const fb = ppFor(groupFor(res, "alpha")!, "facebook");
    // rates: 200/2000*100=10.00, 100/2000*100=5.00 → avg=7.50
    expect(fb!.avgEngagementRate).toBe(7.5);
  });

  it("alpha IG perPlatform avgEngagementRate uses IG followers (1000)", async () => {
    const res = await socialPosts(pool, {});
    const ig = ppFor(groupFor(res, "alpha")!, "instagram");
    // rates: 100/1000*100=10.00, 50/1000*100=5.00, 25/1000*100=2.50 → avg≈5.83
    expect(ig!.avgEngagementRate).toBeCloseTo(5.83, 1);
  });

  it("beta IG perPlatform: pctEstimatedReach=50 (1 of 2 posts estimated)", async () => {
    const res = await socialPosts(pool, {});
    const ig = ppFor(groupFor(res, "beta")!, "instagram");
    expect(ig!.pctEstimatedReach).toBe(50);
  });
});

// ─── socialPosts: post list unchanged ─────────────────────────────────────

describe("socialPosts — post list fields unchanged", () => {
  it("posts carry platform, engagement, reachSource, engagementRate fields", async () => {
    const res = await socialPosts(pool, {});
    const alpha = groupFor(res, "alpha");
    const topPost = alpha!.posts[0] as {
      platform: string;
      engagement: number;
      reachSource: string;
      engagementRate: number;
    };
    expect(topPost.platform).toBeDefined();
    expect(typeof topPost.engagement).toBe("number");
    expect(topPost.reachSource).toBeDefined();
    expect(topPost.engagementRate).toBeDefined();
  });
});

// ─── socialBenchmark: engagement metric (B9) ──────────────────────────────

describe("socialBenchmark engagement — pctEstimatedReach (B9)", () => {
  it("rows include pct_estimated_reach", async () => {
    const res = await socialBenchmark(pool, { metric: "engagement" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      pct_estimated_reach: string | null;
      avg_engagement: string;
      avg_engagement_rate: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    // every row must have the pct_estimated_reach column (may be 0 or null)
    for (const r of rows) {
      expect(Object.hasOwn(r, "pct_estimated_reach")).toBe(true);
    }
  });

  it("alpha IG: pct_estimated_reach=0 (all views)", async () => {
    const res = await socialBenchmark(pool, { metric: "engagement" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      pct_estimated_reach: string | null;
    }[];
    const row = rows.find((r) => r.target_id === "alpha" && r.platform === "instagram");
    expect(row).toBeDefined();
    expect(Number(row!.pct_estimated_reach)).toBe(0);
  });

  it("alpha FB: pct_estimated_reach=100 (all estimate)", async () => {
    const res = await socialBenchmark(pool, { metric: "engagement" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      pct_estimated_reach: string | null;
    }[];
    const row = rows.find((r) => r.target_id === "alpha" && r.platform === "facebook");
    expect(row).toBeDefined();
    expect(Number(row!.pct_estimated_reach)).toBe(100);
  });
});

// ─── socialBenchmark: cadence metric (B6) ─────────────────────────────────

describe("socialBenchmark cadence — postsPerWeek span math (B6)", () => {
  it("rows include both posts_in_window and posts_per_week", async () => {
    const res = await socialBenchmark(pool, { metric: "cadence" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      posts_in_window: string;
      posts_per_week: string | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.hasOwn(r, "posts_in_window")).toBe(true);
      expect(Object.hasOwn(r, "posts_per_week")).toBe(true);
    }
  });

  it("alpha IG: posts_in_window=3; postsPerWeek derived from ~20-day span → ~1.05", async () => {
    const res = await socialBenchmark(pool, { metric: "cadence" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      posts_in_window: string;
      posts_per_week: string | null;
    }[];
    const row = rows.find((r) => r.target_id === "alpha" && r.platform === "instagram");
    expect(row).toBeDefined();
    expect(Number(row!.posts_in_window)).toBe(3);
    // span = 25 - 5 = 20 days; posts_per_week = 3/20*7 = 1.05
    expect(Number(row!.posts_per_week)).toBeCloseTo(1.05, 1);
  });

  it("alpha FB: posts_in_window=2; postsPerWeek derived from ~12-day span → ~1.17", async () => {
    const res = await socialBenchmark(pool, { metric: "cadence" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      posts_in_window: string;
      posts_per_week: string | null;
    }[];
    const row = rows.find((r) => r.target_id === "alpha" && r.platform === "facebook");
    expect(row).toBeDefined();
    expect(Number(row!.posts_in_window)).toBe(2);
    // span = 20 - 8 = 12 days; posts_per_week = 2/12*7 ≈ 1.17
    expect(Number(row!.posts_per_week)).toBeCloseTo(1.17, 1);
  });

  it("beta IG: posts_in_window=2; postsPerWeek from ~7-day span → ~2.00", async () => {
    const res = await socialBenchmark(pool, { metric: "cadence" });
    const rows = res.rows as {
      target_id: string;
      platform: string;
      posts_in_window: string;
      posts_per_week: string | null;
    }[];
    const row = rows.find((r) => r.target_id === "beta" && r.platform === "instagram");
    expect(row).toBeDefined();
    expect(Number(row!.posts_in_window)).toBe(2);
    // span = 10 - 3 = 7 days; posts_per_week = 2/7*7 = 2.00
    expect(Number(row!.posts_per_week)).toBeCloseTo(2.0, 1);
  });

  it("cadence note mentions scraper depth cap", async () => {
    const res = await socialBenchmark(pool, { metric: "cadence" });
    expect(res.note).toContain("scraper-depth-capped");
    expect(res.note).toContain("postsPerWeek");
  });

  it("cadence includes pct_estimated_reach", async () => {
    const res = await socialBenchmark(pool, { metric: "cadence" });
    const rows = res.rows as { pct_estimated_reach: string | null }[];
    for (const r of rows) {
      expect(Object.hasOwn(r, "pct_estimated_reach")).toBe(true);
    }
  });
});

// ─── socialBenchmark: followers metric unchanged ───────────────────────────

describe("socialBenchmark followers metric — unchanged", () => {
  it("returns rows with target_id, platform, metric, value, captured_date", async () => {
    const res = await socialBenchmark(pool, { metric: "followers" });
    expect(res.metric).toBe("followers");
    expect(Array.isArray(res.rows)).toBe(true);
    const rows = res.rows as { target_id: string; value: unknown }[];
    expect(rows.length).toBeGreaterThan(0);
  });
});
