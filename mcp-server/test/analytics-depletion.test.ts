import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@mytime/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareMarketShare, inventoryVelocity } from "../src/analytics.js";

/**
 * Regression tests for the depletion CTE (drops + disappearance union, B3) and
 * its N-day window semantics (B11), plus compareMarketShare's active-only price
 * aggregates (A10) — executed against a real Postgres engine (PGlite).
 */
let db: PGlite;
let pool: Pool;

beforeAll(async () => {
  db = new PGlite();
  pool = { query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as Pool;
  await db.exec(`
    CREATE TABLE products (
      id text PRIMARY KEY, target_id text, name text, brand text,
      active boolean NOT NULL DEFAULT true, last_seen_date date NOT NULL
    );
    CREATE TABLE inventory_snapshots (
      product_id text, captured_date date, stock_quantity int,
      stock_status text, qty_basis text
    );
    CREATE TABLE prices (
      product_id text, captured_date date, price numeric, sale_price numeric
    );

    -- t-drop: plain exact drop 5 -> 3 across two snapshots = 2 units.
    INSERT INTO products VALUES ('a','t-drop','Watch A','Seiko',true, current_date - 1);
    INSERT INTO inventory_snapshots VALUES
      ('a', current_date - 2, 5, 'in_stock', 'exact'),
      ('a', current_date - 1, 3, 'in_stock', 'exact');

    -- t-gone: disappearance — last snapshot qty 4, now inactive, last_seen before
    -- the target's latest snapshot (anchor product proves the target kept scraping).
    INSERT INTO products VALUES ('b','t-gone','Watch B','Casio',false, current_date - 2);
    INSERT INTO inventory_snapshots VALUES ('b', current_date - 2, 4, 'in_stock', 'exact');
    INSERT INTO products VALUES ('b2','t-gone','Anchor','Casio',true, current_date - 1);
    INSERT INTO inventory_snapshots VALUES
      ('b2', current_date - 2, 1, 'in_stock', 'exact'),
      ('b2', current_date - 1, 1, 'in_stock', 'exact');

    -- t-zero: drop-then-disappear must not double count — 6 -> 0 counts 6 via the
    -- drop; the disappearance adds nothing because the last known quantity is 0.
    INSERT INTO products VALUES ('c','t-zero','Watch C','Tissot',false, current_date - 1);
    INSERT INTO inventory_snapshots VALUES
      ('c', current_date - 2, 6, 'in_stock', 'exact'),
      ('c', current_date - 1, 0, 'out_of_stock', 'exact');
    INSERT INTO products VALUES ('c2','t-zero','Anchor','Tissot',true, current_date);
    INSERT INTO inventory_snapshots VALUES
      ('c2', current_date - 1, 1, 'in_stock', 'exact'),
      ('c2', current_date,     1, 'in_stock', 'exact');

    -- t-back: reactivated product — vanished once but is active again, so no
    -- disappearance event (and its lone snapshot produces no lag drop).
    INSERT INTO products VALUES ('d','t-back','Watch D','Orient',true, current_date - 5);
    INSERT INTO inventory_snapshots VALUES ('d', current_date - 5, 3, 'in_stock', 'exact');
    INSERT INTO products VALUES ('d2','t-back','Anchor','Orient',true, current_date);
    INSERT INTO inventory_snapshots VALUES
      ('d2', current_date - 1, 1, 'in_stock', 'exact'),
      ('d2', current_date,     1, 'in_stock', 'exact');

    -- t-edge: window boundary. days=3 covers [current_date-2, current_date].
    -- e-in  disappeared exactly on the boundary (current_date-2) -> counted (2).
    -- e-out disappeared one day earlier (current_date-3)         -> excluded (5).
    INSERT INTO products VALUES ('e-in','t-edge','Watch In','Certina',false, current_date - 2);
    INSERT INTO inventory_snapshots VALUES ('e-in', current_date - 2, 2, 'in_stock', 'exact');
    INSERT INTO products VALUES ('e-out','t-edge','Watch Out','Certina',false, current_date - 3);
    INSERT INTO inventory_snapshots VALUES ('e-out', current_date - 3, 5, 'in_stock', 'exact');
    INSERT INTO products VALUES ('e2','t-edge','Anchor','Certina',true, current_date);
    INSERT INTO inventory_snapshots VALUES
      ('e2', current_date - 1, 1, 'in_stock', 'exact'),
      ('e2', current_date,     1, 'in_stock', 'exact');

    -- A10: an inactive product's price must not skew the aggregates.
    INSERT INTO products VALUES ('m1','mytime','MT Watch','Seiko',true, current_date - 1);
    INSERT INTO products VALUES ('m2','mytime','MT Old','Seiko',false, current_date - 90);
    INSERT INTO prices VALUES
      ('m1', current_date - 1, 100, NULL),
      ('m2', current_date - 90, 9000, NULL);
  `);
});

afterAll(async () => {
  await db.close();
});

const unitsFor = (
  res: Awaited<ReturnType<typeof inventoryVelocity>>,
  target: string,
): number | undefined =>
  (res.by_competitor as { target_id: string; est_units: number }[]).find(
    (r) => r.target_id === target,
  )?.est_units;

describe("depletion CTE (drops + disappearances)", () => {
  it("counts a plain snapshot-to-snapshot quantity drop", async () => {
    const res = await inventoryVelocity(pool, { days: 30 });
    expect(unitsFor(res, "t-drop")).toBe(2);
  });

  it("counts the last known quantity of a product that disappeared from the feed", async () => {
    const res = await inventoryVelocity(pool, { days: 30 });
    expect(unitsFor(res, "t-gone")).toBe(4);
  });

  it("does not double count a drop-to-zero followed by disappearance", async () => {
    const res = await inventoryVelocity(pool, { days: 30 });
    expect(unitsFor(res, "t-zero")).toBe(6);
  });

  it("excludes reactivated products from disappearance events", async () => {
    const res = await inventoryVelocity(pool, { days: 30 });
    expect(unitsFor(res, "t-back")).toBeUndefined();
  });

  it("applies the window boundary inclusively at day N-1 (period_days is exact)", async () => {
    const res = await inventoryVelocity(pool, { days: 3 });
    expect(unitsFor(res, "t-edge")).toBe(2); // e-in counted, e-out excluded
    const wide = await inventoryVelocity(pool, { days: 30 });
    expect(unitsFor(wide, "t-edge")).toBe(7); // both counted in a wide window
  });
});

describe("compareMarketShare active-only aggregates (A10)", () => {
  it("excludes inactive products from the price aggregates", async () => {
    const res = await compareMarketShare(pool, { competitor: "t-drop" });
    const mt = (
      res.assortment as { target_id: string; active_skus: string; avg_price: string }[]
    ).find((r) => r.target_id === "mytime");
    expect(Number(mt?.active_skus)).toBe(1);
    expect(Number(mt?.avg_price)).toBe(100);
  });
});
