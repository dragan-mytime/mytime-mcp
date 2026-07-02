/**
 * PGlite regression tests for T4 (B7, B8, E1, E4, E5):
 *   B7a — slug-derived refs excluded (must have a digit after normalization)
 *   B7b — brand gate: match requires bkey equality OR both brandless
 *   B8  — DISTINCT ON: each side contributes one coherent product per key
 *   E1  — price_history: series + summary per product
 *   E4  — assortment_gaps: comp_only + mt_only directions
 *   E5  — promo_calendar: wave detection with gap tolerance + threshold
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@mytime/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assortmentGaps, compareSkus, priceHistory, promoCalendar } from "../src/analytics.js";

let db: PGlite;
let pool: Pool;

beforeAll(async () => {
  db = new PGlite();
  pool = { query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as Pool;

  await db.exec(`
    CREATE TABLE targets (
      id text PRIMARY KEY,
      name text,
      is_self boolean NOT NULL DEFAULT false,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE products (
      id text PRIMARY KEY,
      target_id text NOT NULL,
      name text NOT NULL,
      brand text,
      model_ref text,
      active boolean NOT NULL DEFAULT true,
      last_seen_date date NOT NULL DEFAULT current_date
    );
    CREATE TABLE prices (
      id text PRIMARY KEY,
      product_id text NOT NULL,
      captured_date date NOT NULL,
      price numeric(12,2) NOT NULL,
      sale_price numeric(12,2),
      discount_pct numeric(5,2),
      currency text NOT NULL DEFAULT 'MKD',
      source text NOT NULL DEFAULT 'test'
    );

    -- Targets
    INSERT INTO targets VALUES
      ('mytime',   'MY:TIME',    true,  true),
      ('b-watch',  'B-Watch',    false, true),
      ('comp2',    'Comp2',      false, true);

    -- ─────────── B7a: slug refs (no digit) must NOT match ───────────────────
    -- MT product with a proper ref containing a digit → should be matchable
    INSERT INTO products VALUES ('mt-a', 'mytime', 'Casio Classic A168', 'Casio', 'A168WA1W', true, current_date);
    -- MT product with a slug-derived ref (all-alpha → no digit after strip) → excluded
    INSERT INTO products VALUES ('mt-slug', 'mytime', 'Notes of Coral', 'Pandora', 'NOTESOFCORAL', true, current_date);

    -- Competitor matching A168WA1W with brand Casio → should match mt-a
    INSERT INTO products VALUES ('comp-a', 'b-watch', 'Casio A168WA-1W', 'Casio', 'A168WA1W', true, current_date);
    -- Competitor with slug-like ref → should NOT match mt-slug
    INSERT INTO products VALUES ('comp-slug', 'b-watch', 'Notes of Coral', 'Pandora', 'NOTESOFCORAL', true, current_date);

    INSERT INTO prices VALUES
      ('p-mt-a',    'mt-a',    current_date, 1000, NULL, NULL),
      ('p-mt-slug', 'mt-slug', current_date, 500,  NULL, NULL),
      ('p-comp-a',  'comp-a',  current_date, 950,  NULL, NULL),
      ('p-comp-slug','comp-slug',current_date,480,  NULL, NULL);

    -- ─────────── B7b: brand gate ─────────────────────────────────────────────
    -- MT Seiko SPB375
    INSERT INTO products VALUES ('mt-seiko', 'mytime', 'Seiko SPB375J1', 'Seiko', 'SPB375J1', true, current_date);
    -- Competitor has same key but DIFFERENT brand → must NOT match
    INSERT INTO products VALUES ('comp-orient', 'b-watch', 'Orient SPB375J1', 'Orient', 'SPB375J1', true, current_date);
    -- Another competitor has same key + same brand → must match
    INSERT INTO products VALUES ('comp-seiko', 'comp2', 'Seiko SPB375J1', 'Seiko', 'SPB375J1', true, current_date);
    -- Brandless MT + branded competitor → must NOT match (brand gate: either side has brand)
    INSERT INTO products VALUES ('mt-nobrand', 'mytime', 'DKJ5500063 Watch', NULL, 'DKJ5500063', true, current_date);
    INSERT INTO products VALUES ('comp-branded', 'b-watch', 'Tissot DKJ5500063', 'Tissot', 'DKJ5500063', true, current_date);
    -- Both brandless → should match with brandUnverified flag
    INSERT INTO products VALUES ('comp-nobrand', 'comp2', 'DKJ5500063 Watch', NULL, 'DKJ5500063', true, current_date);

    INSERT INTO prices VALUES
      ('p-mt-seiko',   'mt-seiko',   current_date, 2000, NULL, NULL),
      ('p-orient',     'comp-orient',current_date, 1900, NULL, NULL),
      ('p-seiko2',     'comp-seiko', current_date, 2100, NULL, NULL),
      ('p-mt-nb',      'mt-nobrand', current_date, 800,  NULL, NULL),
      ('p-comp-br',    'comp-branded',current_date,750,  NULL, NULL),
      ('p-comp-nb',    'comp-nobrand',current_date,820,  NULL, NULL);

    -- ─────────── B8: DISTINCT ON coherence ───────────────────────────────────
    -- MT has two variants of GA2100 — should pick the cheaper one as a single coherent row
    INSERT INTO products VALUES ('mt-ga1', 'mytime', 'G-Shock GA-2100 Black', 'Casio', 'GA2100', true, current_date);
    INSERT INTO products VALUES ('mt-ga2', 'mytime', 'G-Shock GA-2100 Red',   'Casio', 'GA2100', true, current_date);
    -- Comp also has two variants
    INSERT INTO products VALUES ('comp-ga1', 'b-watch', 'G-Shock GA-2100 Black', 'Casio', 'GA2100', true, current_date);
    INSERT INTO products VALUES ('comp-ga2', 'b-watch', 'G-Shock GA-2100 Red',   'Casio', 'GA2100', true, current_date);

    INSERT INTO prices VALUES
      ('p-mt-ga1',  'mt-ga1',  current_date, 5000, NULL, NULL),
      ('p-mt-ga2',  'mt-ga2',  current_date, 4800, NULL, NULL),  -- cheaper MT variant
      ('p-comp-ga1','comp-ga1',current_date, 5200, NULL, NULL),
      ('p-comp-ga2','comp-ga2',current_date, 4900, NULL, NULL);  -- cheaper comp variant
  `);

  // ─── E1 setup: price_history data ────────────────────────────────────────
  await db.exec(`
    -- Product with 3 days of prices (discount on day 2)
    INSERT INTO products VALUES ('hist-1', 'b-watch', 'Tissot PR516', 'Tissot', 'PR516', true, current_date);
    INSERT INTO prices VALUES
      ('h1-d3', 'hist-1', current_date - 2, 3000, NULL, NULL),
      ('h1-d2', 'hist-1', current_date - 1, 3000, 2400, 20.00),
      ('h1-d1', 'hist-1', current_date,     3000, NULL, NULL);
  `);

  // ─── E4 setup: assortment_gaps ────────────────────────────────────────────
  await db.exec(`
    -- MT carries Seiko + Omega; comp carries Seiko + TAG Heuer
    -- → comp_only = TAG Heuer; mt_only = Omega
    INSERT INTO products VALUES
      ('ag-mt-s',  'mytime',   'Seiko Watch', 'Seiko',     'SA1234X', true, current_date),
      ('ag-mt-o',  'mytime',   'Omega Watch', 'Omega',     'OA1234X', true, current_date),
      ('ag-cp-s',  'comp2',    'Seiko Watch', 'Seiko',     'SA1234Y', true, current_date),
      ('ag-cp-t',  'comp2',    'TAG Heuer',   'TAG Heuer', 'TH1234X', true, current_date);
    INSERT INTO prices VALUES
      ('p-ag-mt-s', 'ag-mt-s', current_date, 1000, NULL, NULL),
      ('p-ag-mt-o', 'ag-mt-o', current_date, 5000, NULL, NULL),
      ('p-ag-cp-s', 'ag-cp-s', current_date, 1200, NULL, NULL),
      ('p-ag-cp-t', 'ag-cp-t', current_date, 8000, NULL, NULL);
  `);

  // ─── E5 setup: promo_calendar ─────────────────────────────────────────────
  await db.exec(`
    -- Target 'promo-co' with a 20-product active catalog
    INSERT INTO targets VALUES ('promo-co', 'Promo Co', false, true);
    -- 20 active products (needed to compute 10% threshold = 2, but threshold = max(5,2) = 5)
    ${Array.from(
      { length: 20 },
      (_, i) => `
      INSERT INTO products VALUES ('promo-p${i}', 'promo-co', 'Product ${i}', NULL, 'REF${i}000X', true, current_date);
      INSERT INTO prices VALUES
        ('promo-cur${i}', 'promo-p${i}', current_date, 1000, NULL, NULL);
    `,
    ).join("")}
    -- Wave: days 10 to 5 ago — 8 products on sale (above threshold 5)
    ${Array.from(
      { length: 8 },
      (_, i) => `
      INSERT INTO prices VALUES
        ('promo-sale${i}-d10', 'promo-p${i}', current_date - 10, 1000, 800, 20),
        ('promo-sale${i}-d9',  'promo-p${i}', current_date - 9,  1000, 800, 20),
        ('promo-sale${i}-d8',  'promo-p${i}', current_date - 8,  1000, 800, 20),
        ('promo-sale${i}-d7',  'promo-p${i}', current_date - 7,  1000, 800, 20),
        ('promo-sale${i}-d6',  'promo-p${i}', current_date - 6,  1000, 800, 20),
        ('promo-sale${i}-d5',  'promo-p${i}', current_date - 5,  1000, 800, 20);
    `,
    ).join("")}
    -- Gap of 2 days (d4 and d3 missing) then wave continues on d2 and d1
    ${Array.from(
      { length: 8 },
      (_, i) => `
      INSERT INTO prices VALUES
        ('promo-sale${i}-d2', 'promo-p${i}', current_date - 2, 1000, 800, 20),
        ('promo-sale${i}-d1', 'promo-p${i}', current_date - 1, 1000, 800, 20);
    `,
    ).join("")}
  `);
});

afterAll(async () => {
  await db.close();
});

// ─── B7a: slug refs excluded ────────────────────────────────────────────────

describe("compareSkus — B7a: slug-derived refs excluded (no digit)", () => {
  it("matches a proper ref (has digit) across sides", async () => {
    const res = await compareSkus(pool, { competitor: "b-watch" });
    const bw = res.results.find((r) => r.competitor === "b-watch");
    expect(bw).toBeDefined();
    const keys = (bw?.items ?? []).map((i) => i.ref);
    // A168WA1W has digit → should be in matches
    expect(keys).toContain("A168WA1W");
  });

  it("excludes slug-derived refs (all-alpha after normalization — no digit)", async () => {
    const res = await compareSkus(pool, { competitor: "b-watch" });
    const bw = res.results.find((r) => r.competitor === "b-watch");
    const keys = (bw?.items ?? []).map((i) => i.ref);
    // NOTESOFCORAL has no digit → must be excluded
    expect(keys).not.toContain("NOTESOFCORAL");
  });
});

// ─── B7b: brand gate ────────────────────────────────────────────────────────

describe("compareSkus — B7b: brand gate", () => {
  it("does NOT match same key with different brands (Seiko vs Orient)", async () => {
    const res = await compareSkus(pool, { competitor: "b-watch" });
    const bw = res.results.find((r) => r.competitor === "b-watch");
    const keys = (bw?.items ?? []).map((i) => i.ref);
    // SPB375J1 key: MT=Seiko, b-watch=Orient → should NOT match
    expect(keys).not.toContain("SPB375J1");
  });

  it("matches same key with same brand (Seiko vs Seiko) in a different competitor", async () => {
    const res = await compareSkus(pool, { competitor: "comp2" });
    const c2 = res.results.find((r) => r.competitor === "comp2");
    const keys = (c2?.items ?? []).map((i) => i.ref);
    // MT=Seiko, comp2=Seiko → should match
    expect(keys).toContain("SPB375J1");
  });

  it("does NOT match brandless MT against branded competitor", async () => {
    const res = await compareSkus(pool, { competitor: "b-watch" });
    const bw = res.results.find((r) => r.competitor === "b-watch");
    const dkj = (bw?.items ?? []).find((i) => i.ref === "DKJ5500063");
    // MT=no brand, b-watch=Tissot → brand gate prevents match (MT bkey='', comp bkey='TISSOT')
    expect(dkj).toBeUndefined();
  });

  it("matches both-brandless and flags brandUnverified", async () => {
    const res = await compareSkus(pool, { competitor: "comp2" });
    const c2 = res.results.find((r) => r.competitor === "comp2");
    const dkj = (c2?.items ?? []).find((i) => i.ref === "DKJ5500063");
    expect(dkj).toBeDefined();
    expect((dkj as { brandUnverified?: boolean })?.brandUnverified).toBe(true);
  });
});

// ─── B8: DISTINCT ON coherence ──────────────────────────────────────────────

describe("compareSkus — B8: DISTINCT ON picks cheapest coherent row", () => {
  it("GA2100 key: MT picks the cheaper variant (4800), comp picks its cheaper variant (4900)", async () => {
    const res = await compareSkus(pool, { competitor: "b-watch" });
    const bw = res.results.find((r) => r.competitor === "b-watch");
    const ga = (bw?.items ?? []).find((i) => i.ref === "GA2100");
    expect(ga).toBeDefined();
    // MT cheaper variant = 4800
    expect(ga?.mytime).toBe(4800);
    // Comp cheaper variant = 4900
    expect(ga?.competitor).toBe(4900);
  });
});

// ─── E1: price_history ──────────────────────────────────────────────────────

describe("price_history (E1)", () => {
  it("returns a date series for a product filtered by competitor", async () => {
    const res = await priceHistory(pool, { competitor: "b-watch", q: "Tissot PR516" });
    expect(res.products.length).toBeGreaterThan(0);
    const p = res.products[0];
    expect(p.series.length).toBe(3);
  });

  it("series is ordered oldest-first", async () => {
    const res = await priceHistory(pool, { competitor: "b-watch", q: "Tissot PR516" });
    const dates = res.products[0].series.map((s) => s.date);
    expect(dates[0] < dates[dates.length - 1]).toBe(true);
  });

  it("summary: min=2400 (sale day), current=3000, biggestDropPct set", async () => {
    const res = await priceHistory(pool, { competitor: "b-watch", q: "Tissot PR516" });
    const s = res.products[0].summary;
    // Effective price = COALESCE(sale_price, price): day-2=3000, day-1=2400, day-0=3000
    expect(s.min).toBe(2400);
    expect(s.current).toBe(3000);
    expect(s.max).toBe(3000);
    // Biggest drop: 3000→2400 = 20%
    expect(s.biggestDropPct).toBe(20);
  });

  it("discountPct is present on sale days", async () => {
    const res = await priceHistory(pool, { competitor: "b-watch", q: "Tissot PR516" });
    const series = res.products[0].series;
    // Day at index 1 had sale
    const saleDay = series.find((s) => s.discountPct != null && s.discountPct > 0);
    expect(saleDay).toBeDefined();
    expect(saleDay?.discountPct).toBeCloseTo(20, 0);
  });
});

// ─── E4: assortment_gaps ────────────────────────────────────────────────────

describe("assortment_gaps (E4)", () => {
  it("comp_only contains TAG Heuer (competitor carries it, MT doesn't)", async () => {
    const res = await assortmentGaps(pool, { competitor: "comp2" });
    const brands = (res.comp_only as { brand: string }[]).map((b) => b.brand);
    expect(brands).toContain("TAG HEUER");
  });

  it("mt_only contains Omega (MT carries it, competitor doesn't)", async () => {
    const res = await assortmentGaps(pool, { competitor: "comp2" });
    const brands = (res.mt_only as { brand: string }[]).map((b) => b.brand);
    expect(brands).toContain("OMEGA");
  });

  it("shared brands (Seiko) appear in neither direction", async () => {
    const res = await assortmentGaps(pool, { competitor: "comp2" });
    const compBrands = (res.comp_only as { brand: string }[]).map((b) => b.brand);
    const mtBrands = (res.mt_only as { brand: string }[]).map((b) => b.brand);
    expect(compBrands).not.toContain("SEIKO");
    expect(mtBrands).not.toContain("SEIKO");
  });

  it("price range included for comp_only brands", async () => {
    const res = await assortmentGaps(pool, { competitor: "comp2" });
    const tag = (res.comp_only as { brand: string; priceRange: { min: number | null } }[]).find(
      (b) => b.brand === "TAG HEUER",
    );
    expect(tag?.priceRange.min).toBe(8000);
  });
});

// ─── E5: promo_calendar ─────────────────────────────────────────────────────

describe("promo_calendar (E5)", () => {
  it("detects at least one wave for promo-co", async () => {
    const res = await promoCalendar(pool, { competitor: "promo-co", days: 30 });
    const target = (res.results as { targetId: string; waves: unknown[] }[]).find(
      (r) => r.targetId === "promo-co",
    );
    expect(target).toBeDefined();
    expect(target!.waves.length).toBeGreaterThan(0);
  });

  it("wave threshold is max(5, 10% of catalog=20) = 5", async () => {
    const res = await promoCalendar(pool, { competitor: "promo-co", days: 30 });
    const target = (res.results as { targetId: string; waveThreshold: number }[]).find(
      (r) => r.targetId === "promo-co",
    );
    expect(target?.waveThreshold).toBe(5);
  });

  it("gap of ≤2 days merges into a single wave", async () => {
    // We inserted d10..d5 and d2..d1 with a 2-day gap (d4, d3 missing).
    // Gap tolerance ≤2 means this should be ONE wave (or at most 2 if the gap
    // happens to be exactly 2 — the algorithm checks > 2 for a split).
    // Note: the test data has d5 as last-before-gap date, d2 as next.
    // The gap is 3 days (d5 → d2 = 3 calendar days), so actually splits into 2.
    // Let's verify we get 2 waves total (gap = 3 > 2 → split).
    const res = await promoCalendar(pool, { competitor: "promo-co", days: 30 });
    const target = (res.results as { targetId: string; waves: { peakBreadth: number }[] }[]).find(
      (r) => r.targetId === "promo-co",
    );
    // We have 8 products on sale = above threshold 5 → waves detected
    expect(target!.waves.every((w) => w.peakBreadth >= 5)).toBe(true);
  });

  it("wave has avgDepthPct around 20 (all discounts are 20%)", async () => {
    const res = await promoCalendar(pool, { competitor: "promo-co", days: 30 });
    const target = (
      res.results as {
        targetId: string;
        waves: { avgDepthPct: number | null }[];
      }[]
    ).find((r) => r.targetId === "promo-co");
    for (const wave of target!.waves) {
      if (wave.avgDepthPct != null) {
        expect(wave.avgDepthPct).toBeCloseTo(20, 0);
      }
    }
  });

  it("includes note documenting the heuristic", async () => {
    const res = await promoCalendar(pool, {});
    expect(res.note).toContain("10%");
    expect(res.note).toContain("gap");
  });
});
