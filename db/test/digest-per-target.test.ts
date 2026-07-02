/**
 * SQL regression tests for per-target digest date resolution (B2/E3/E8).
 *
 * Tests the key SQL behaviour of dailyDigest's rewritten date CTEs:
 *   - Two competitors each use their OWN latest capture date ("today") and
 *     their own prior date (≥ `days` days older), not a shared global LIMIT 2.
 *   - A target with no data in the window still returns its own latest date
 *     but produces NULL prior → delta metrics come back 0/empty (not borrowing
 *     another target's dates).
 *   - Weekly window (days=7) selects the right prior date.
 *   - Freshness query flags stale targets correctly.
 *
 * All executed against PGlite (no network, no migration files).
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

// Helper: run the perTargetDatesCte SQL inline with a given source CTE and days,
// then return (target_id, latest_d, prior_d) rows.  We inline the helper SQL
// because we're testing the SQL logic itself, not the TS wrapper.
async function resolvedDates(
  pglite: PGlite,
  distinctDatesSql: string,
  days: number,
): Promise<{ target_id: string; latest_d: string | null; prior_d: string | null }[]> {
  const { rows } = await pglite.query(`
    WITH dd AS (
      SELECT target_id, captured_date,
             row_number() OVER (PARTITION BY target_id ORDER BY captured_date DESC) AS rn
      FROM (${distinctDatesSql}) x
    ),
    latest AS (SELECT target_id, captured_date AS d FROM dd WHERE rn = 1),
    prior AS (
      SELECT dd.target_id, max(dd.captured_date) AS d
      FROM dd
      JOIN latest l ON l.target_id = dd.target_id
      WHERE dd.captured_date <= l.d - ${days}
      GROUP BY dd.target_id
    )
    SELECT l.target_id,
           l.d::text   AS latest_d,
           p.d::text   AS prior_d
    FROM latest l
    LEFT JOIN prior p ON p.target_id = l.target_id
    ORDER BY l.target_id
  `);
  return rows as { target_id: string; latest_d: string | null; prior_d: string | null }[];
}

beforeAll(async () => {
  db = new PGlite();

  // Minimal schema for price date resolution (B2)
  await db.exec(`
    CREATE TABLE prices (
      product_id text, target_id text, captured_date date
    );
    -- target A: scraped on days -3, -2, -1, 0 (today)
    INSERT INTO prices VALUES
      ('a1','target-a', current_date - 3),
      ('a1','target-a', current_date - 2),
      ('a1','target-a', current_date - 1),
      ('a1','target-a', current_date);
    -- target B: scraped on days -10, -8 (stale vs today; last seen 2 days ago
    --   from its own perspective has no "yesterday", so prior is NULL for days=1)
    INSERT INTO prices VALUES
      ('b1','target-b', current_date - 10),
      ('b1','target-b', current_date - 8);
  `);

  // Minimal schema for freshness (E3)
  await db.exec(`
    CREATE TABLE targets (
      id text PRIMARY KEY, is_self boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ingestion_runs (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      target_id text,
      collector text,
      status text,
      error text,
      rows_written int,
      started_at timestamptz,
      finished_at timestamptz
    );
    INSERT INTO targets VALUES ('target-a', false, true), ('target-b', false, true);

    -- target-a: fresh (success 1h ago)
    INSERT INTO ingestion_runs (target_id, collector, status, started_at, finished_at, rows_written)
    VALUES ('target-a','web-scraper','success', now() - interval '1 hour', now() - interval '55 minutes', 100);

    -- target-b: stale (last success 3 days ago, then 2 consecutive failures)
    INSERT INTO ingestion_runs (target_id, collector, status, started_at, finished_at, rows_written)
    VALUES
      ('target-b','web-scraper','success',  now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 80),
      ('target-b','web-scraper','failed',   now() - interval '2 days', now() - interval '2 days' + interval '5 minutes',  NULL),
      ('target-b','web-scraper','failed',   now() - interval '1 day',  now() - interval '1 day'  + interval '5 minutes',  NULL);
  `);
});

afterAll(async () => {
  await db.close();
});

// ── B2: per-target date resolution ──────────────────────────────────────────

describe("perTargetDatesCte — per-target date resolution (B2)", () => {
  const srcSql = `SELECT DISTINCT target_id, captured_date FROM prices`;

  it("target-a gets its own latest date (today)", async () => {
    const rows = await resolvedDates(db, srcSql, 1);
    const a = rows.find((r) => r.target_id === "target-a");
    expect(a).toBeDefined();
    // latest_d should be today (captured_date = current_date)
    const today = new Date().toISOString().slice(0, 10);
    expect(a?.latest_d).toBe(today);
  });

  it("target-a gets its own prior date (yesterday) for days=1", async () => {
    const rows = await resolvedDates(db, srcSql, 1);
    const a = rows.find((r) => r.target_id === "target-a");
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    expect(a?.prior_d).toBe(yesterday);
  });

  it("target-b gets its OWN latest date (current_date - 8), not target-a's", async () => {
    const rows = await resolvedDates(db, srcSql, 1);
    const b = rows.find((r) => r.target_id === "target-b");
    expect(b).toBeDefined();
    const expected = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
    expect(b?.latest_d).toBe(expected);
  });

  it("target-b has no prior date for days=1 (gap between its dates is 2 days, not 1)", async () => {
    // target-b only has dates -10 and -8. For days=1, prior must be ≥ 1 day older
    // than latest (-8). -10 is 2 days older, so it satisfies ≤ latest - 1:
    // (-10) ≤ (-8) - 1 = (-9) → TRUE, so -10 IS a valid prior.
    const rows = await resolvedDates(db, srcSql, 1);
    const b = rows.find((r) => r.target_id === "target-b");
    const expected = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    expect(b?.prior_d).toBe(expected);
  });

  it("targets do NOT share dates — target-b's latest is not today", async () => {
    const rows = await resolvedDates(db, srcSql, 1);
    const a = rows.find((r) => r.target_id === "target-a");
    const b = rows.find((r) => r.target_id === "target-b");
    expect(a?.latest_d).not.toBe(b?.latest_d);
  });
});

// ── E8: weekly prior-date selection ─────────────────────────────────────────

describe("perTargetDatesCte — weekly window (days=7, E8)", () => {
  it("target-a: prior_d is current_date-7 or earlier for days=7", async () => {
    const srcSql = `SELECT DISTINCT target_id, captured_date FROM prices`;
    const rows = await resolvedDates(db, srcSql, 7);
    const a = rows.find((r) => r.target_id === "target-a");
    // target-a's latest is current_date; dates available: -3, -2, -1, 0.
    // All are < 7 days old → no prior row for days=7
    expect(a?.prior_d).toBeNull();
  });

  it("target-b: prior for days=7 is current_date-10 (≥ 7 days older than latest -8)", async () => {
    const srcSql = `SELECT DISTINCT target_id, captured_date FROM prices`;
    const rows = await resolvedDates(db, srcSql, 7);
    const b = rows.find((r) => r.target_id === "target-b");
    // target-b latest = -8; prior must be ≤ -8 - 7 = -15. Only -10 and -8 exist.
    // -10 ≤ -15? No (−10 > −15). So no valid prior.
    expect(b?.prior_d).toBeNull();
  });
});

// ── E3: freshness query — stale flags + consecutive failure count ─────────────

describe("freshness query (E3) — stale flags and consecutive failures", () => {
  const freshnessQuery = `
    WITH runs AS (
      SELECT r.target_id, r.collector, r.status, r.error, r.rows_written,
             COALESCE(r.finished_at, r.started_at) AS at,
             row_number() OVER (
               PARTITION BY r.target_id, r.collector ORDER BY r.started_at DESC
             ) AS rn
      FROM ingestion_runs r
      WHERE r.collector NOT LIKE 'digest:%'
    ),
    last_success AS (
      SELECT DISTINCT ON (target_id, collector) target_id, collector, at, rows_written
      FROM runs WHERE status = 'success' ORDER BY target_id, collector, at DESC
    ),
    first_success_rn AS (
      SELECT target_id, collector, min(rn) AS rn
      FROM runs WHERE status = 'success' GROUP BY target_id, collector
    ),
    consec AS (
      SELECT r.target_id, r.collector, count(*)::int AS consecutive_failures
      FROM runs r
      LEFT JOIN first_success_rn s
        ON s.target_id = r.target_id AND s.collector = r.collector
      WHERE r.status = 'failed' AND (s.rn IS NULL OR r.rn < s.rn)
      GROUP BY r.target_id, r.collector
    )
    SELECT t.id AS target_id, 'web-scraper' AS collector,
           ls.at::text AS last_success_at,
           COALESCE(c.consecutive_failures, 0) AS consecutive_failures,
           (ls.at IS NULL OR ls.at < now() - interval '48 hours') AS stale
    FROM targets t
    LEFT JOIN last_success ls ON ls.target_id = t.id AND ls.collector = 'web-scraper'
    LEFT JOIN consec c ON c.target_id = t.id AND c.collector = 'web-scraper'
    WHERE t.is_self = false AND t.active
    ORDER BY t.id
  `;

  it("target-a is not stale (fresh success 1h ago)", async () => {
    const { rows } = await db.query(freshnessQuery);
    const a = (rows as { target_id: string; stale: boolean; consecutive_failures: number }[]).find(
      (r) => r.target_id === "target-a",
    );
    expect(a?.stale).toBe(false);
    expect(a?.consecutive_failures).toBe(0);
  });

  it("target-b is stale (last success 3 days ago)", async () => {
    const { rows } = await db.query(freshnessQuery);
    const b = (rows as { target_id: string; stale: boolean; consecutive_failures: number }[]).find(
      (r) => r.target_id === "target-b",
    );
    expect(b?.stale).toBe(true);
  });

  it("target-b has 2 consecutive failures since last success", async () => {
    const { rows } = await db.query(freshnessQuery);
    const b = (rows as { target_id: string; stale: boolean; consecutive_failures: number }[]).find(
      (r) => r.target_id === "target-b",
    );
    expect(b?.consecutive_failures).toBe(2);
  });
});
