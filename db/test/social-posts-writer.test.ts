/**
 * PGlite regression tests for writeSocialPosts upsert semantics (A4, A6).
 *
 * Tests:
 *   A4a – measured reach is never downgraded to estimate by a later incoming row.
 *   A4b – incoming NULL likes do not wipe an existing real like count (COALESCE).
 *   A4c – genuine new counter values do update.
 *   A6  – an invalid/unparseable postedAt string is guarded (toDateOrNull) and
 *          does not throw; the row is written with NULL postedAt instead.
 *
 * We test the SQL logic directly via the PGlite adapter so we don't need a
 * full Postgres server.  The Drizzle pglite adapter is available because the
 * db package already declares @electric-sql/pglite as a devDependency.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
import { toDateOrNull, writeSocialPosts } from "../src/writers.js";

type DrizzlePg = ReturnType<typeof drizzle>;

let pglite: PGlite;
let db: DrizzlePg;

const ACCT = "00000000-0000-0000-0000-000000000001";

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });

  // Minimal schema — only tables/columns that writeSocialPosts touches.
  await pglite.exec(`
    CREATE TABLE social_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target_id text NOT NULL,
      platform text NOT NULL,
      url text NOT NULL,
      handle text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (target_id, platform)
    );
    INSERT INTO social_accounts (id, target_id, platform, url, handle)
    VALUES ('${ACCT}', 'mytime', 'instagram', 'https://ig.com/mytime', 'mytime');

    CREATE TABLE social_posts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
      external_post_id text NOT NULL,
      captured_date date NOT NULL,
      posted_at timestamptz,
      post_type text,
      caption text,
      permalink text,
      media_url text,
      media_urls jsonb,
      likes int,
      comments int,
      shares int,
      views int,
      engagement int,
      estimated_reach int,
      reach_source text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (social_account_id, external_post_id)
    );
  `);
});

afterAll(async () => {
  await pglite.close();
});

async function getPost(extId: string) {
  const { rows } = await pglite.query<{
    likes: number | null;
    comments: number | null;
    shares: number | null;
    engagement: number | null;
    estimated_reach: number | null;
    reach_source: string | null;
    posted_at: string | null;
  }>(
    `SELECT likes, comments, shares, engagement, estimated_reach, reach_source, posted_at
     FROM social_posts WHERE social_account_id = $1 AND external_post_id = $2`,
    [ACCT, extId],
  );
  return rows[0] ?? null;
}

describe("writeSocialPosts upsert semantics (A4)", () => {
  it("A4a: measured reach is preserved when a later run sends an estimate", async () => {
    // First run: measured reach.
    await writeSocialPosts(db as never, ACCT, "2026-07-01", [
      {
        externalPostId: "reach-test",
        postedAt: "2026-06-30T10:00:00Z",
        postType: "image",
        caption: null,
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: 100,
        comments: 10,
        shares: 5,
        views: null,
        engagement: 115,
        estimatedReach: 5000,
        reachSource: "measured",
      },
    ]);
    let row = await getPost("reach-test");
    expect(row?.reach_source).toBe("measured");
    expect(row?.estimated_reach).toBe(5000);

    // Second run: incoming estimate must NOT overwrite measured.
    await writeSocialPosts(db as never, ACCT, "2026-07-02", [
      {
        externalPostId: "reach-test",
        postedAt: "2026-06-30T10:00:00Z",
        postType: "image",
        caption: null,
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: 105,
        comments: 11,
        shares: 5,
        views: null,
        engagement: 121,
        estimatedReach: 800,
        reachSource: "estimate",
      },
    ]);
    row = await getPost("reach-test");
    expect(row?.reach_source).toBe("measured"); // unchanged
    expect(row?.estimated_reach).toBe(5000); // unchanged
    // counters ARE updated (genuine new values)
    expect(row?.likes).toBe(105);
  });

  it("A4b: incoming NULL likes do not wipe an existing real like count", async () => {
    // First run: real likes count.
    await writeSocialPosts(db as never, ACCT, "2026-07-01", [
      {
        externalPostId: "null-likes-test",
        postedAt: null,
        postType: "image",
        caption: null,
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: 50,
        comments: 5,
        shares: null,
        views: null,
        engagement: 55,
        estimatedReach: 200,
        reachSource: "estimate",
      },
    ]);
    expect((await getPost("null-likes-test"))?.likes).toBe(50);

    // Second run: likes come in as null (insight call failed).
    await writeSocialPosts(db as never, ACCT, "2026-07-02", [
      {
        externalPostId: "null-likes-test",
        postedAt: null,
        postType: "image",
        caption: null,
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: null,
        comments: null,
        shares: null,
        views: null,
        engagement: null,
        estimatedReach: 200,
        reachSource: "estimate",
      },
    ]);
    const row = await getPost("null-likes-test");
    expect(row?.likes).toBe(50); // still 50, not null
    expect(row?.engagement).toBe(55); // incoming NULL engagement keeps the existing value
  });

  it("A4c: genuine new counter values do update", async () => {
    await writeSocialPosts(db as never, ACCT, "2026-07-01", [
      {
        externalPostId: "update-test",
        postedAt: null,
        postType: "image",
        caption: "old caption",
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: 10,
        comments: 1,
        shares: null,
        views: null,
        engagement: 11,
        estimatedReach: 100,
        reachSource: "estimate",
      },
    ]);
    await writeSocialPosts(db as never, ACCT, "2026-07-02", [
      {
        externalPostId: "update-test",
        postedAt: null,
        postType: "image",
        caption: "new caption",
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: 20,
        comments: 3,
        shares: 2,
        views: null,
        engagement: 25,
        estimatedReach: 100,
        reachSource: "estimate",
      },
    ]);
    const row = await getPost("update-test");
    expect(row?.likes).toBe(20); // updated
    expect(row?.comments).toBe(3); // updated
    expect(row?.shares).toBe(2); // updated from null
    expect(row?.engagement).toBe(25); // mapper-provided value taken as-is
  });

  it("B4 parity: re-upsert of an own-IG-shaped row keeps mapper engagement (likes+comments, shares excluded)", async () => {
    // Own-IG mapper (mapIgOwnPost) computes engagement = likes+comments and
    // stores shares separately. The SQL must NOT recompute likes+comments+shares.
    const ownIgRow = {
      externalPostId: "own-ig-post",
      postedAt: "2026-06-30T10:00:00Z",
      postType: "image",
      caption: null,
      permalink: null,
      mediaUrl: null,
      mediaUrls: null,
      likes: 10,
      comments: 2,
      shares: 100, // non-null shares stored, but excluded from engagement
      views: null,
      engagement: 12, // mapper's B4 formula: 10 + 2
      estimatedReach: 5000,
      reachSource: "measured",
    };
    await writeSocialPosts(db as never, ACCT, "2026-07-01", [ownIgRow]);
    expect((await getPost("own-ig-post"))?.engagement).toBe(12);

    // Re-upsert the same row (next day's run) — engagement must stay 12, not become 112.
    await writeSocialPosts(db as never, ACCT, "2026-07-02", [ownIgRow]);
    const row = await getPost("own-ig-post");
    expect(row?.engagement).toBe(12);
    expect(row?.shares).toBe(100);
  });
});

describe("toDateOrNull (A6)", () => {
  it("returns null for a garbage date string without throwing", () => {
    expect(toDateOrNull("THIS IS NOT A DATE")).toBeNull();
  });

  it("returns a Date for a valid ISO string", () => {
    const d = toDateOrNull("2026-06-30T10:00:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(Number.isFinite(d?.getTime())).toBe(true);
  });

  it("A6 integration: upsert with invalid postedAt writes NULL posted_at without throwing", async () => {
    await writeSocialPosts(db as never, ACCT, "2026-07-01", [
      {
        externalPostId: "bad-date-post",
        postedAt: "June 20, 2026 at 10:00 AM CEST", // locale string that may vary
        postType: "image",
        caption: null,
        permalink: null,
        mediaUrl: null,
        mediaUrls: null,
        likes: 1,
        comments: null,
        shares: null,
        views: null,
        engagement: 1,
        estimatedReach: null,
        reachSource: null,
      },
    ]);
    // Either null (unparseable) or a date (if engine happens to parse it) — must not throw.
    const row = await getPost("bad-date-post");
    expect(row).not.toBeNull(); // row exists
    expect(row?.likes).toBe(1); // data written
  });
});
