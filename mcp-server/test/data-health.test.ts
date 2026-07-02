/**
 * SQL regression tests for the data_health MCP tool (E3): ingestion freshness
 * per target × collector — last success, consecutive failures, stale flag.
 * Executed against a real Postgres engine (PGlite), same pattern as
 * analytics-depletion.test.ts.
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@mytime/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataHealth } from "../src/analytics.js";

let db: PGlite;
let pool: Pool;

beforeAll(async () => {
  db = new PGlite();
  pool = { query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as Pool;

  // The data_health tool queries `ingestion_runs` directly (no Drizzle schema needed).
  await db.exec(`
    CREATE TABLE ingestion_runs (
      id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      target_id  text,
      collector  text NOT NULL,
      status     text NOT NULL,
      error      text,
      rows_written int,
      started_at  timestamptz NOT NULL,
      finished_at timestamptz
    );

    -- target-fresh: one scraper success 1 hour ago → not stale, 0 consecutive failures
    INSERT INTO ingestion_runs (target_id, collector, status, started_at, finished_at, rows_written)
    VALUES
      ('target-fresh', 'web-scraper', 'success', now() - interval '1 hour',
       now() - interval '55 minutes', 120);

    -- target-stale: success 3 days ago, then 2 failures → stale, 2 consecutive failures
    INSERT INTO ingestion_runs (target_id, collector, status, started_at, finished_at, rows_written, error)
    VALUES
      ('target-stale', 'web-scraper', 'success',
       now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', 80, NULL),
      ('target-stale', 'web-scraper', 'failed',
       now() - interval '2 days', now() - interval '2 days' + interval '5 minutes', NULL,
       'connection timeout'),
      ('target-stale', 'web-scraper', 'failed',
       now() - interval '1 day', now() - interval '1 day'  + interval '5 minutes', NULL,
       'HTTP 503');

    -- target-never: only failures, no success at all → stale, 1 consecutive failure
    INSERT INTO ingestion_runs (target_id, collector, status, started_at, finished_at, error)
    VALUES
      ('target-never', 'meta-ads', 'failed',
       now() - interval '30 minutes', now() - interval '25 minutes', 'auth error');

    -- digest runs must be excluded from the result
    INSERT INTO ingestion_runs (target_id, collector, status, started_at, rows_written)
    VALUES ('target-fresh', 'digest:abc123', 'success', now() - interval '2 hours', 1);
  `);
});

afterAll(async () => {
  await db.close();
});

type HealthRow = {
  target_id: string;
  collector: string;
  last_success_at: string | null;
  rows_last_success: number | null;
  last_failure_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  stale: boolean;
};

describe("data_health (E3)", () => {
  it("returns note and staleAfterHours in result shape", async () => {
    const res = await dataHealth(pool);
    expect(res).toHaveProperty("note");
    expect(res.staleAfterHours).toBe(48);
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it("target-fresh/web-scraper is not stale and has 0 consecutive failures", async () => {
    const res = await dataHealth(pool);
    const row = (res.rows as HealthRow[]).find(
      (r) => r.target_id === "target-fresh" && r.collector === "web-scraper",
    );
    expect(row).toBeDefined();
    expect(row?.stale).toBe(false);
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.rows_last_success).toBe(120);
  });

  it("target-stale/web-scraper is stale and has 2 consecutive failures", async () => {
    const res = await dataHealth(pool);
    const row = (res.rows as HealthRow[]).find(
      (r) => r.target_id === "target-stale" && r.collector === "web-scraper",
    );
    expect(row).toBeDefined();
    expect(row?.stale).toBe(true);
    expect(row?.consecutive_failures).toBe(2);
    expect(row?.last_error).toContain("HTTP 503"); // most recent failure
  });

  it("target-never/meta-ads has null last_success_at and is stale", async () => {
    const res = await dataHealth(pool);
    const row = (res.rows as HealthRow[]).find(
      (r) => r.target_id === "target-never" && r.collector === "meta-ads",
    );
    expect(row).toBeDefined();
    expect(row?.last_success_at).toBeNull();
    expect(row?.stale).toBe(true);
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.last_error).toBe("auth error");
  });

  it("excludes digest: collector runs from results", async () => {
    const res = await dataHealth(pool);
    const digestRows = (res.rows as HealthRow[]).filter((r) => r.collector.startsWith("digest:"));
    expect(digestRows).toHaveLength(0);
  });

  it("competitor filter returns only rows for that target", async () => {
    const res = await dataHealth(pool, { competitor: "target-stale" });
    const rows = res.rows as HealthRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.target_id).toBe("target-stale");
    }
  });

  it("consecutive_failures is 0 for a target with no failures at all", async () => {
    const res = await dataHealth(pool, { competitor: "target-fresh" });
    const row = (res.rows as HealthRow[]).find((r) => r.collector === "web-scraper");
    expect(row?.consecutive_failures).toBe(0);
  });
});
