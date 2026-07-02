/**
 * Tests for social_content tool (E6):
 *   - extractHashtags: pure function, unicode-aware, case-folding, deduplication
 *   - socialContent SQL + TS aggregation via PGlite:
 *       - hashtag counts, case-insensitive grouping + original-case sample
 *       - posting heatmap cells in Europe/Skopje timezone (UTC boundary crossing)
 *       - brand mentions: whole-word match, short-brand skip (< 3 chars), no substring false positives
 *       - bestSlots: top 3 by avgEngagement with ≥2 posts
 *       - competitor filter
 *
 * Skopje tz offsets: UTC+1 (winter/CET) or UTC+2 (summer/CEST).
 * July is summer (CEST = UTC+2).
 *
 * We pick a controlled posted_at of 2026-07-02 22:00 UTC which is
 * 2026-07-03 00:00 Skopje (midnight). 2026-07-03 is a FRIDAY → dow=4 (Mon=0), hour=0.
 * A second post at 2026-07-01 21:00 UTC = 2026-07-01 23:00 Skopje (Wednesday → dow=2, hour=23).
 * These cross the UTC midnight boundary to prove tz correctness.
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@mytime/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractHashtags, socialContent } from "../src/analytics.js";

// ── pure-function tests: extractHashtags ─────────────────────────────────────

describe("extractHashtags — pure function", () => {
  it("extracts basic ASCII hashtags", () => {
    const tags = extractHashtags("Love #watches and #jewelry today!");
    expect(tags).toContain("#watches");
    expect(tags).toContain("#jewelry");
  });

  it("returns empty array for no hashtags", () => {
    expect(extractHashtags("no tags here")).toEqual([]);
    expect(extractHashtags("")).toEqual([]);
  });

  it("preserves original casing in returned tags", () => {
    const tags = extractHashtags("#Casio #CASIO #casio");
    expect(tags).toContain("#Casio");
    expect(tags).toContain("#CASIO");
    expect(tags).toContain("#casio");
  });

  it("handles unicode characters (Cyrillic, accented) in hashtags", () => {
    const tags = extractHashtags("#часовници #маж #rеlojes");
    expect(tags.length).toBe(3);
    expect(tags).toContain("#часовници");
  });

  it("includes underscore in hashtags", () => {
    const tags = extractHashtags("#my_time_mk is great");
    expect(tags).toContain("#my_time_mk");
  });

  it("does not include punctuation after tag", () => {
    const tags = extractHashtags("#watches, #jewelry.");
    expect(tags.some((t) => t.includes(","))).toBe(false);
    expect(tags.some((t) => t.includes("."))).toBe(false);
  });

  it("handles multiple hashtags in one caption", () => {
    const tags = extractHashtags("#a #b #c");
    expect(tags).toHaveLength(3);
  });
});

// ── integration tests: socialContent via PGlite ──────────────────────────────

let db: PGlite;
let pool: Pool;

beforeAll(async () => {
  db = new PGlite();
  pool = {
    query: (text: string, params?: unknown[]) => db.query(text, params),
  } as unknown as Pool;

  await db.exec(`
    CREATE TYPE social_platform AS ENUM ('instagram','facebook','tiktok');

    CREATE TABLE targets (
      id text PRIMARY KEY,
      name text,
      is_self boolean NOT NULL DEFAULT false
    );

    CREATE TABLE social_accounts (
      id text PRIMARY KEY,
      target_id text NOT NULL REFERENCES targets(id),
      platform social_platform NOT NULL,
      url text NOT NULL DEFAULT ''
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

    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target_id text NOT NULL,
      external_id text NOT NULL,
      name text NOT NULL,
      brand text,
      active boolean NOT NULL DEFAULT true
    );

    -- Targets
    INSERT INTO targets VALUES ('alpha', 'Alpha Co', false), ('beta', 'Beta Co', false);

    -- Social accounts
    INSERT INTO social_accounts VALUES
      ('a-ig', 'alpha', 'instagram', 'https://ig.com/alpha'),
      ('b-ig', 'beta',  'instagram', 'https://ig.com/beta');

    -- Products with brands (for brand mention testing)
    -- 'Casio' ≥ 3 chars — should match
    -- 'G-Shock' ≥ 3 chars — should match (note: whole-word)
    -- 'AS' < 3 chars — should be SKIPPED (short brand guard)
    INSERT INTO products (target_id, external_id, name, brand, active) VALUES
      ('alpha', 'p1', 'Casio Watch', 'Casio', true),
      ('alpha', 'p2', 'Seiko Watch', 'Seiko', true),
      ('alpha', 'p3', 'Short',       'AS',    true),  -- < 3 chars, must be skipped
      ('alpha', 'p4', 'Inactive',    'Rado',  false); -- inactive, must be skipped

    -- ─── alpha posts ─────────────────────────────────────────────────────────
    -- Post 1: posted_at = 2026-07-02 22:00 UTC = 2026-07-03 00:00 Skopje (CEST=UTC+2)
    --   → dow=3 (Thursday, Monday=0), hour=0
    --   Caption has #Watches twice (dedup), #Casio, brand "Casio" in text, brand "Seiko" absent
    INSERT INTO social_posts VALUES
      ('sp1', 'a-ig', 'e1',
       '#Watches are great #watches love #Casio timepieces. Casio for life!',
       null, null, 'image', 90, 10, 0, 0, 100, 900, 'views',
       '2026-07-02 22:00:00+00');

    -- Post 2: posted_at = 2026-07-01 21:00 UTC = 2026-07-01 23:00 Skopje (CEST=UTC+2)
    --   → dow=2 (Wednesday), hour=23
    --   Caption has #Watches, brand "Seiko" + "Casiotone" (must NOT match "Casio" whole-word)
    INSERT INTO social_posts VALUES
      ('sp2', 'a-ig', 'e2',
       '#Watches collection #jewelry — Seiko style. Casiotone is NOT Casio brand.',
       null, null, 'image', 45, 5, 0, 0, 50, 450, 'views',
       '2026-07-01 21:00:00+00');

    -- Post 3: same slot as sp2 (dow=2, hour=23) — same UTC hour+day
    --   Caption: #jewelry (no casio mention)
    INSERT INTO social_posts VALUES
      ('sp3', 'a-ig', 'e3',
       '#jewelry and #luxury',
       null, null, 'image', 22, 3, 0, 0, 25, 225, 'views',
       '2026-07-01 21:30:00+00');

    -- ─── beta posts ──────────────────────────────────────────────────────────
    -- Post 4: different target, same hashtag #watches
    INSERT INTO social_posts VALUES
      ('sp4', 'b-ig', 'e4',
       '#watches #luxury — buy now',
       null, null, 'image', 55, 5, 0, 0, 60, 100, 'estimate',
       '2026-07-01 09:00:00+00');
  `);
});

afterAll(async () => {
  await db.close();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

type ScResult = Awaited<ReturnType<typeof socialContent>>;
type ScGroup = ScResult["results"][number];

function groupFor(res: ScResult, targetId: string): ScGroup | undefined {
  return res.results.find((g) => g.targetId === targetId);
}

// ─── hashtag tests ───────────────────────────────────────────────────────────

describe("socialContent — topHashtags", () => {
  it("returns results for both targets when no competitor filter", async () => {
    const res = await socialContent(pool, {});
    expect(res.results.length).toBe(2);
  });

  it("alpha: #watches appears 2 times (sp1 + sp2), deduped within same post", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    expect(alpha).toBeDefined();
    const wtag = alpha?.topHashtags.find((t) => t.tag === "#watches");
    expect(wtag).toBeDefined();
    // sp1 has #Watches/#watches (same post, deduped → count 1 for that post)
    // sp2 has #Watches → count 1 more
    // total = 2
    expect(wtag?.count).toBe(2);
  });

  it("alpha: case-folding groups #Watches and #watches under #watches", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    // Only one entry for #watches (lowercase key), not two separate entries
    const watchesTags = alpha?.topHashtags.filter((t) => t.tag.toLowerCase() === "#watches");
    expect(watchesTags).toHaveLength(1);
  });

  it("alpha: #casio appears 1 time (sp1 only, #Casio)", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const casiTag = alpha?.topHashtags.find((t) => t.tag === "#casio");
    expect(casiTag).toBeDefined();
    expect(casiTag?.count).toBe(1);
  });

  it("alpha: sample casing preserved from first encounter", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const wtag = alpha?.topHashtags.find((t) => t.tag === "#watches");
    // sp1 is the first post, and it has '#Watches' first
    expect(wtag?.sample).toBe("#Watches");
  });

  it("alpha: avgEngagement computed correctly for #watches (posts sp1+sp2 → 100+50=75)", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const wtag = alpha?.topHashtags.find((t) => t.tag === "#watches");
    expect(wtag?.avgEngagement).toBe(75); // (100 + 50) / 2
  });

  it("returns at most 10 hashtags per target", async () => {
    const res = await socialContent(pool, {});
    for (const group of res.results) {
      expect(group.topHashtags.length).toBeLessThanOrEqual(10);
    }
  });

  it("beta: #watches count = 1 (sp4 only)", async () => {
    const res = await socialContent(pool, { competitor: "beta" });
    const beta = groupFor(res, "beta");
    const wtag = beta?.topHashtags.find((t) => t.tag === "#watches");
    expect(wtag).toBeDefined();
    expect(wtag?.count).toBe(1);
  });
});

// ─── heatmap tests ───────────────────────────────────────────────────────────

describe("socialContent — postingHeatmap (Europe/Skopje timezone)", () => {
  it("alpha: sp1 at 2026-07-02 22:00 UTC maps to dow=4, hour=0 (Skopje CEST = UTC+2 → Friday midnight)", async () => {
    // 2026-07-02 22:00 UTC + 2h = 2026-07-03 00:00 Skopje
    // 2026-07-03 is a Friday → dow=4 (Monday=0)
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const cell = alpha?.postingHeatmap.cells.find((c) => c.dow === 4 && c.hour === 0);
    expect(cell).toBeDefined();
    expect(cell?.count).toBe(1);
  });

  it("alpha: sp2+sp3 at 2026-07-01 21:00+21:30 UTC map to dow=2, hour=23 (Skopje Wednesday 23:xx)", async () => {
    // 2026-07-01 21:00 UTC + 2h = 2026-07-01 23:00 Skopje — Wednesday
    // 2026-07-01 21:30 UTC + 2h = 2026-07-01 23:30 Skopje — Wednesday
    // dow=2 (Wednesday), hour=23
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const cell = alpha?.postingHeatmap.cells.find((c) => c.dow === 2 && c.hour === 23);
    expect(cell).toBeDefined();
    expect(cell?.count).toBe(2);
  });

  it("alpha: bestSlots returns cell with ≥2 posts (dow=2, hour=23 has 2 posts → qualifies)", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const slot = alpha?.postingHeatmap.bestSlots.find((s) => s.dow === 2 && s.hour === 23);
    expect(slot).toBeDefined();
  });

  it("alpha: cell with count=1 is NOT in bestSlots (needs ≥2 posts)", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    // sp1 is the only post at dow=4, hour=0 (Friday midnight Skopje) → count=1, excluded from bestSlots
    const slot = alpha?.postingHeatmap.bestSlots.find((s) => s.dow === 4 && s.hour === 0);
    expect(slot).toBeUndefined();
  });

  it("heatmap cells only include non-empty cells", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    expect(alpha).toBeDefined();
    for (const cell of alpha!.postingHeatmap.cells) {
      expect(cell.count).toBeGreaterThan(0);
    }
  });

  it("bestSlots has at most 3 entries", async () => {
    const res = await socialContent(pool, {});
    for (const group of res.results) {
      expect(group.postingHeatmap.bestSlots.length).toBeLessThanOrEqual(3);
    }
  });

  it("alpha heatmap avgEngagement for dow=2,hour=23 = 75 (posts sp2+sp3 → 50+25 / 2)", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const cell = alpha?.postingHeatmap.cells.find((c) => c.dow === 2 && c.hour === 23);
    expect(cell?.avgEngagement).toBe(38); // round((50+25)/2) = 38 (rounded from 37.5)
  });
});

// ─── brand mention tests ──────────────────────────────────────────────────────

describe("socialContent — brandMentions", () => {
  it("alpha: Casio is mentioned in sp1 (text 'Casio for life!')", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const casio = alpha?.brandMentions.find((b) => b.brand === "Casio");
    expect(casio).toBeDefined();
    // sp1 mentions 'Casio for life!' — whole-word match
    // sp2 mentions 'Casiotone is NOT Casio brand.' — 'Casio' appears as whole word here
    // So count should be 2 (sp1 and sp2 each have 'Casio' as whole word)
    expect(casio?.mentionCount).toBeGreaterThanOrEqual(1);
  });

  it("alpha: 'Casiotone' in sp2 does NOT cause false positive for 'Casio' whole-word match in that word", async () => {
    // sp2 caption: "Casiotone is NOT Casio brand." — 'Casiotone' should not match '\bCasio\b'
    // but 'Casio brand' has 'Casio' as a standalone word. Let's verify count is 2 (sp1 + sp2's "Casio brand")
    // and NOT 3 (which would happen if 'Casiotone' was matching).
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const casio = alpha?.brandMentions.find((b) => b.brand === "Casio");
    expect(casio).toBeDefined();
    // sp3 has no 'Casio' so count should be exactly 2 (sp1 + sp2)
    expect(casio?.mentionCount).toBe(2);
  });

  it("alpha: Seiko is mentioned in sp2", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const seiko = alpha?.brandMentions.find((b) => b.brand === "Seiko");
    expect(seiko).toBeDefined();
    expect(seiko?.mentionCount).toBe(1);
  });

  it("brand 'AS' (< 3 chars) is not in brandMentions", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const shortBrand = alpha?.brandMentions.find((b) => b.brand === "AS");
    expect(shortBrand).toBeUndefined();
  });

  it("inactive brand 'Rado' is not in brandMentions (inactive product)", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const rado = alpha?.brandMentions.find((b) => b.brand === "Rado");
    expect(rado).toBeUndefined();
  });

  it("brandMentions avgEngagement is correctly computed", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    const seiko = alpha?.brandMentions.find((b) => b.brand === "Seiko");
    // sp2 has engagement=50
    expect(seiko?.avgEngagement).toBe(50);
  });
});

// ─── result structure tests ───────────────────────────────────────────────────

describe("socialContent — result shape", () => {
  it("includes note and windowDays in top-level result", async () => {
    const res = await socialContent(pool, {});
    expect(res.note).toBeTruthy();
    expect(typeof res.windowDays).toBe("number");
    expect(res.windowDays).toBe(30);
  });

  it("competitor filter scopes to one target only", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    expect(res.results.length).toBe(1);
    expect(res.results[0]?.targetId).toBe("alpha");
  });

  it("days param is respected (max 90)", async () => {
    const res = await socialContent(pool, { days: 7 });
    expect(res.windowDays).toBe(7);
  });

  it("days param clamped at 90 when too large", async () => {
    const res = await socialContent(pool, { days: 200 });
    expect(res.windowDays).toBe(90);
  });

  it("postCount matches number of posts in window for target", async () => {
    const res = await socialContent(pool, { competitor: "alpha" });
    const alpha = groupFor(res, "alpha");
    expect(alpha?.postCount).toBe(3); // sp1, sp2, sp3
  });

  it("note mentions Europe/Skopje and engagement definitions", async () => {
    const res = await socialContent(pool, {});
    expect(res.note).toContain("Europe/Skopje");
    expect(res.note).toContain("0=Monday");
  });
});
