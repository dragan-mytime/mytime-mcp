import { sql } from "drizzle-orm";
import type { Db } from "./index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompetitorDigest {
  targetId: string;
  sales: {
    newlyDiscounted: number;
    ended: number;
    onSaleToday: number;
    avgPct: number | null;
    samples: { name: string; was: number | null; now: number | null; pct: number | null }[];
  };
  ads: {
    activeToday: number;
    new: {
      adTitle: string | null;
      linkUrl: string | null;
      daysRunning: number | null;
      snapshotUrl: string | null;
    }[];
    stoppedCount: number;
    longestRunning: { daysRunning: number | null; adTitle: string | null } | null;
  };
  social: { followers: Record<string, number> };
  inventory: {
    newProducts: number;
    newStockouts: string[];
    priceMoves: { name: string; from: number; to: number }[];
  };
}

export interface DigestResult {
  generatedFor: string;
  note: string;
  competitors: CompetitorDigest[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Unwrap rows from a node-postgres or drizzle execute result. */
const rows = <T>(r: unknown): T[] => {
  if (Array.isArray(r)) return r as T[];
  const obj = r as Record<string, unknown>;
  if (Array.isArray(obj.rows)) return obj.rows as T[];
  return [];
};

// ---------------------------------------------------------------------------
// Signal-group queries
// ---------------------------------------------------------------------------

// ── 1. SALES ────────────────────────────────────────────────────────────────

interface SalesAggRow {
  target_id: string;
  today_date: string | null;
  prior_date: string | null;
  on_sale_today: string | null; // bigint → string from PG
  avg_pct: string | null;
  newly_discounted: string | null;
  ended: string | null;
}

interface SalesSampleRow {
  target_id: string;
  name: string;
  was: string | null;
  now: string | null;
  pct: string | null;
}

async function querySales(
  db: Db,
  competitorFilter: string | undefined,
): Promise<{ agg: SalesAggRow[]; samples: SalesSampleRow[] }> {
  const filterClause = competitorFilter ? sql`AND p.target_id = ${competitorFilter}` : sql``;

  const aggResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT pr.captured_date
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
      ORDER BY pr.captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    today_prices AS (
      SELECT pr.product_id, pr.price::float8 AS price, pr.sale_price::float8 AS sale_price,
             pr.discount_pct::float8 AS discount_pct, p.target_id
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE pr.captured_date = (SELECT d FROM today_date)
        ${filterClause}
    ),
    prior_prices AS (
      SELECT pr.product_id, pr.discount_pct::float8 AS discount_pct
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE pr.captured_date = (SELECT d FROM prior_date)
        ${filterClause}
    )
    SELECT
      tp.target_id,
      (SELECT d FROM today_date)  AS today_date,
      (SELECT d FROM prior_date)  AS prior_date,
      COUNT(*) FILTER (WHERE tp.discount_pct > 0)                                    AS on_sale_today,
      AVG(tp.discount_pct) FILTER (WHERE tp.discount_pct > 0)                        AS avg_pct,
      COUNT(*) FILTER (WHERE tp.discount_pct > 0 AND (pp.discount_pct IS NULL OR pp.discount_pct = 0)) AS newly_discounted,
      COUNT(*) FILTER (WHERE (tp.discount_pct IS NULL OR tp.discount_pct = 0) AND pp.discount_pct > 0) AS ended
    FROM today_prices tp
    LEFT JOIN prior_prices pp ON pp.product_id = tp.product_id
    GROUP BY tp.target_id
  `);

  const sampleResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT pr.captured_date
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
      ORDER BY pr.captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    newly_disc AS (
      SELECT
        p.target_id,
        p.name,
        pp.price::float8      AS was,
        tp.sale_price::float8 AS now,
        tp.discount_pct::float8 AS pct,
        ROW_NUMBER() OVER (PARTITION BY p.target_id ORDER BY tp.discount_pct DESC) AS rn
      FROM prices tp
      JOIN products p ON p.id = tp.product_id
      LEFT JOIN prices pp ON pp.product_id = tp.product_id
        AND pp.captured_date = (SELECT d FROM prior_date)
      WHERE tp.captured_date = (SELECT d FROM today_date)
        AND tp.discount_pct > 0
        AND (pp.discount_pct IS NULL OR pp.discount_pct = 0)
        AND p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    )
    SELECT target_id, name, was, now, pct
    FROM newly_disc
    WHERE rn <= 5
    ORDER BY target_id, pct DESC
  `);

  return {
    agg: rows<SalesAggRow>(aggResult),
    samples: rows<SalesSampleRow>(sampleResult),
  };
}

// ── 2. ADS ──────────────────────────────────────────────────────────────────

interface AdsAggRow {
  target_id: string;
  active_today: string | null;
  stopped_count: string | null;
  longest_days: number | null;
  longest_title: string | null;
}

interface NewAdRow {
  target_id: string;
  ad_title: string | null;
  link_url: string | null;
  days_running: number | null;
  snapshot_url: string | null;
}

async function queryAds(
  db: Db,
  competitorFilter: string | undefined,
): Promise<{ agg: AdsAggRow[]; newAds: NewAdRow[] }> {
  const filterClause = competitorFilter ? sql`AND a.target_id = ${competitorFilter}` : sql``;

  const filterClauseBase = competitorFilter ? sql`AND target_id = ${competitorFilter}` : sql``;

  const aggResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT captured_date
      FROM ad_observations
      WHERE target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClauseBase}
      ORDER BY captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    today_ads AS (
      SELECT a.target_id, a.ad_archive_id, a.days_running, a.ad_title
      FROM ad_observations a
      WHERE a.captured_date = (SELECT d FROM today_date)
        AND a.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    ),
    prior_ads AS (
      SELECT a.ad_archive_id
      FROM ad_observations a
      WHERE a.captured_date = (SELECT d FROM prior_date)
        AND a.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    ),
    longest AS (
      SELECT DISTINCT ON (target_id)
        target_id, days_running, ad_title
      FROM today_ads
      ORDER BY target_id, days_running DESC NULLS LAST
    )
    SELECT
      ta.target_id,
      COUNT(*)                                                                   AS active_today,
      COUNT(*) FILTER (WHERE pa.ad_archive_id IS NULL AND (SELECT d FROM prior_date) IS NOT NULL
                             AND (SELECT d FROM today_date) <> (SELECT d FROM prior_date))
        AS stopped_count_placeholder,
      l.days_running                                                             AS longest_days,
      l.ad_title                                                                 AS longest_title,
      SUM(CASE WHEN pa.ad_archive_id IS NOT NULL THEN 1 ELSE 0 END)            AS prior_count
    FROM today_ads ta
    LEFT JOIN prior_ads pa ON pa.ad_archive_id = ta.ad_archive_id
    LEFT JOIN longest l ON l.target_id = ta.target_id
    GROUP BY ta.target_id, l.days_running, l.ad_title
  `);

  // Stopped count: ads in prior not in today
  const stoppedResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT captured_date
      FROM ad_observations
      WHERE target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClauseBase}
      ORDER BY captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd)
    SELECT a.target_id, COUNT(*) AS stopped_count
    FROM ad_observations a
    WHERE a.captured_date = (SELECT d FROM prior_date)
      AND (SELECT d FROM prior_date) IS NOT NULL
      AND (SELECT d FROM today_date) <> (SELECT d FROM prior_date)
      AND a.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
      ${filterClause}
      AND a.ad_archive_id NOT IN (
        SELECT ad_archive_id FROM ad_observations
        WHERE captured_date = (SELECT d FROM today_date)
          AND target_id = a.target_id
      )
    GROUP BY a.target_id
  `);

  const newAdsResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT captured_date
      FROM ad_observations
      WHERE target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClauseBase}
      ORDER BY captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    new_ads AS (
      SELECT
        a.target_id,
        a.ad_title,
        a.link_url,
        a.days_running,
        a.snapshot_url,
        ROW_NUMBER() OVER (PARTITION BY a.target_id ORDER BY a.days_running ASC NULLS LAST) AS rn
      FROM ad_observations a
      WHERE a.captured_date = (SELECT d FROM today_date)
        AND a.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
        AND NOT EXISTS (
          SELECT 1 FROM ad_observations prev
          WHERE prev.ad_archive_id = a.ad_archive_id
            AND prev.target_id = a.target_id
            AND prev.captured_date = (SELECT d FROM prior_date)
        )
    )
    SELECT target_id, ad_title, link_url, days_running, snapshot_url
    FROM new_ads
    WHERE rn <= 5
    ORDER BY target_id
  `);

  // Merge stopped counts into agg rows
  const stoppedMap = new Map<string, number>();
  for (const r of rows<{ target_id: string; stopped_count: string }>(stoppedResult)) {
    stoppedMap.set(r.target_id, parseInt(r.stopped_count, 10) || 0);
  }

  const aggRows = rows<AdsAggRow & { stopped_count_placeholder?: unknown }>(aggResult).map((r) => ({
    target_id: r.target_id,
    active_today: r.active_today,
    stopped_count: String(stoppedMap.get(r.target_id) ?? 0),
    longest_days: r.longest_days,
    longest_title: r.longest_title,
  }));

  return {
    agg: aggRows,
    newAds: rows<NewAdRow>(newAdsResult),
  };
}

// ── 3. SOCIAL ───────────────────────────────────────────────────────────────

interface SocialRow {
  target_id: string;
  platform: string;
  today_val: string | null;
  prior_val: string | null;
}

async function querySocial(db: Db, competitorFilter: string | undefined): Promise<SocialRow[]> {
  const filterClause = competitorFilter ? sql`AND sa.target_id = ${competitorFilter}` : sql``;

  const result = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT sm.captured_date
      FROM social_metrics sm
      JOIN social_accounts sa ON sa.id = sm.social_account_id
      WHERE sm.metric = 'followers'
        AND sa.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
      ORDER BY sm.captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    today_m AS (
      SELECT sa.target_id, sa.platform::text, sm.value::float8 AS val
      FROM social_metrics sm
      JOIN social_accounts sa ON sa.id = sm.social_account_id
      WHERE sm.captured_date = (SELECT d FROM today_date)
        AND sm.metric = 'followers'
        AND sa.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    ),
    prior_m AS (
      SELECT sa.target_id, sa.platform::text, sm.value::float8 AS val
      FROM social_metrics sm
      JOIN social_accounts sa ON sa.id = sm.social_account_id
      WHERE sm.captured_date = (SELECT d FROM prior_date)
        AND sm.metric = 'followers'
        AND sa.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    )
    SELECT
      tm.target_id,
      tm.platform,
      tm.val  AS today_val,
      pm.val  AS prior_val
    FROM today_m tm
    LEFT JOIN prior_m pm ON pm.target_id = tm.target_id AND pm.platform = tm.platform
    WHERE pm.val IS NOT NULL  -- only include platforms where both dates exist
    ORDER BY tm.target_id, tm.platform
  `);

  return rows<SocialRow>(result);
}

// ── 4. INVENTORY ────────────────────────────────────────────────────────────

interface InvAggRow {
  target_id: string;
  new_products: string | null;
}

interface StockoutRow {
  target_id: string;
  name: string;
}

interface PriceMoveRow {
  target_id: string;
  name: string;
  from_price: string;
  to_price: string;
}

async function queryInventory(
  db: Db,
  competitorFilter: string | undefined,
): Promise<{
  agg: InvAggRow[];
  stockouts: StockoutRow[];
  priceMoves: PriceMoveRow[];
}> {
  const filterClause = competitorFilter ? sql`AND p.target_id = ${competitorFilter}` : sql``;

  // New products: earliest inventory date equals today's date (first seen today)
  const aggResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT inv.captured_date
      FROM inventory_snapshots inv
      JOIN products p ON p.id = inv.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
      ORDER BY inv.captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd)
    SELECT p.target_id, COUNT(*) AS new_products
    FROM products p
    WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
      ${filterClause}
      AND (
        SELECT MIN(inv.captured_date)
        FROM inventory_snapshots inv
        WHERE inv.product_id = p.id
      ) = (SELECT d FROM today_date)
    GROUP BY p.target_id
  `);

  // New stockouts: in_stock on prior date, out_of_stock on today
  const stockoutsResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT inv.captured_date
      FROM inventory_snapshots inv
      JOIN products p ON p.id = inv.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
      ORDER BY inv.captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    stockouts AS (
      SELECT
        p.target_id,
        p.name,
        ROW_NUMBER() OVER (PARTITION BY p.target_id ORDER BY p.name) AS rn
      FROM inventory_snapshots today_inv
      JOIN products p ON p.id = today_inv.product_id
      JOIN inventory_snapshots prior_inv
        ON prior_inv.product_id = today_inv.product_id
       AND prior_inv.captured_date = (SELECT d FROM prior_date)
      WHERE today_inv.captured_date = (SELECT d FROM today_date)
        AND today_inv.stock_status = 'out_of_stock'
        AND prior_inv.stock_status = 'in_stock'
        AND (SELECT d FROM prior_date) IS NOT NULL
        AND (SELECT d FROM today_date) <> (SELECT d FROM prior_date)
        AND p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    )
    SELECT target_id, name
    FROM stockouts
    WHERE rn <= 8
    ORDER BY target_id, name
  `);

  // Price moves: price changed by >5% between the two most recent prices dates
  const priceMovesResult = await db.execute(sql`
    WITH dd AS (
      SELECT DISTINCT pr.captured_date
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
      ORDER BY pr.captured_date DESC
      LIMIT 2
    ),
    today_date AS (SELECT MAX(captured_date) AS d FROM dd),
    prior_date AS (SELECT MIN(captured_date) AS d FROM dd),
    moves AS (
      SELECT
        p.target_id,
        p.name,
        pr_prior.price::float8  AS from_price,
        pr_today.price::float8  AS to_price,
        ROW_NUMBER() OVER (
          PARTITION BY p.target_id
          ORDER BY ABS(pr_today.price::float8 - pr_prior.price::float8) / NULLIF(pr_prior.price::float8, 0) DESC
        ) AS rn
      FROM prices pr_today
      JOIN products p ON p.id = pr_today.product_id
      JOIN prices pr_prior
        ON pr_prior.product_id = pr_today.product_id
       AND pr_prior.captured_date = (SELECT d FROM prior_date)
      WHERE pr_today.captured_date = (SELECT d FROM today_date)
        AND (SELECT d FROM prior_date) IS NOT NULL
        AND (SELECT d FROM today_date) <> (SELECT d FROM prior_date)
        AND pr_prior.price::float8 > 0
        AND ABS(pr_today.price::float8 - pr_prior.price::float8) / pr_prior.price::float8 > 0.05
        AND p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    )
    SELECT target_id, name, from_price, to_price
    FROM moves
    WHERE rn <= 8
    ORDER BY target_id
  `);

  return {
    agg: rows<InvAggRow>(aggResult),
    stockouts: rows<StockoutRow>(stockoutsResult),
    priceMoves: rows<PriceMoveRow>(priceMovesResult),
  };
}

// ---------------------------------------------------------------------------
// generatedFor: latest prices captured_date across all competitors
// ---------------------------------------------------------------------------

async function fetchLatestPricesDate(db: Db): Promise<string> {
  const result = await db.execute(sql`
    SELECT MAX(pr.captured_date)::text AS d
    FROM prices pr
    JOIN products p ON p.id = pr.product_id
    WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
  `);
  const data = rows<{ d: string | null }>(result);
  return data[0]?.d ?? new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function dailyDigest(
  db: Db,
  opts: { competitor?: string; days?: number } = {},
): Promise<DigestResult> {
  const filter = opts.competitor;

  // Run all signal groups in parallel
  const [latestDate, salesData, adsData, socialData, inventoryData] = await Promise.all([
    fetchLatestPricesDate(db),
    querySales(db, filter),
    queryAds(db, filter),
    querySocial(db, filter),
    queryInventory(db, filter),
  ]);

  // Collect all target IDs that appear in any signal group
  const allTargetIds = new Set<string>();
  for (const r of salesData.agg) allTargetIds.add(r.target_id);
  for (const r of adsData.agg) allTargetIds.add(r.target_id);
  for (const r of socialData) allTargetIds.add(r.target_id);
  for (const r of inventoryData.agg) allTargetIds.add(r.target_id);
  for (const r of inventoryData.stockouts) allTargetIds.add(r.target_id);
  for (const r of inventoryData.priceMoves) allTargetIds.add(r.target_id);

  // Index data by target_id for fast lookup
  const salesByTarget = new Map(salesData.agg.map((r) => [r.target_id, r]));
  const salesSamplesByTarget = new Map<string, SalesSampleRow[]>();
  for (const s of salesData.samples) {
    const arr = salesSamplesByTarget.get(s.target_id) ?? [];
    arr.push(s);
    salesSamplesByTarget.set(s.target_id, arr);
  }

  const adsByTarget = new Map(adsData.agg.map((r) => [r.target_id, r]));
  const newAdsByTarget = new Map<string, NewAdRow[]>();
  for (const a of adsData.newAds) {
    const arr = newAdsByTarget.get(a.target_id) ?? [];
    arr.push(a);
    newAdsByTarget.set(a.target_id, arr);
  }

  const socialByTarget = new Map<string, SocialRow[]>();
  for (const s of socialData) {
    const arr = socialByTarget.get(s.target_id) ?? [];
    arr.push(s);
    socialByTarget.set(s.target_id, arr);
  }

  const invAggByTarget = new Map(inventoryData.agg.map((r) => [r.target_id, r]));
  const stockoutsByTarget = new Map<string, string[]>();
  for (const s of inventoryData.stockouts) {
    const arr = stockoutsByTarget.get(s.target_id) ?? [];
    arr.push(s.name);
    stockoutsByTarget.set(s.target_id, arr);
  }
  const pricesMovesByTarget = new Map<string, PriceMoveRow[]>();
  for (const p of inventoryData.priceMoves) {
    const arr = pricesMovesByTarget.get(p.target_id) ?? [];
    arr.push(p);
    pricesMovesByTarget.set(p.target_id, arr);
  }

  // Assemble CompetitorDigest per target
  const competitors: CompetitorDigest[] = [];
  for (const targetId of allTargetIds) {
    const sa = salesByTarget.get(targetId);
    const aa = adsByTarget.get(targetId);
    const socialRows = socialByTarget.get(targetId) ?? [];
    const ia = invAggByTarget.get(targetId);

    const salesSamples = (salesSamplesByTarget.get(targetId) ?? []).map((s) => ({
      name: s.name,
      was: s.was != null ? parseFloat(s.was) : null,
      now: s.now != null ? parseFloat(s.now) : null,
      pct: s.pct != null ? parseFloat(s.pct) : null,
    }));

    const newAds = (newAdsByTarget.get(targetId) ?? []).map((a) => ({
      adTitle: a.ad_title,
      linkUrl: a.link_url,
      daysRunning: a.days_running,
      snapshotUrl: a.snapshot_url,
    }));

    const followers: Record<string, number> = {};
    for (const sr of socialRows) {
      if (sr.today_val != null && sr.prior_val != null) {
        followers[sr.platform] = Math.round(parseFloat(sr.today_val) - parseFloat(sr.prior_val));
      }
    }

    const digest: CompetitorDigest = {
      targetId,
      sales: {
        onSaleToday: sa?.on_sale_today != null ? parseInt(sa.on_sale_today, 10) : 0,
        avgPct: sa?.avg_pct != null ? parseFloat(sa.avg_pct) : null,
        newlyDiscounted: sa?.newly_discounted != null ? parseInt(sa.newly_discounted, 10) : 0,
        ended: sa?.ended != null ? parseInt(sa.ended, 10) : 0,
        samples: salesSamples,
      },
      ads: {
        activeToday: aa?.active_today != null ? parseInt(aa.active_today, 10) : 0,
        new: newAds,
        stoppedCount: aa?.stopped_count != null ? parseInt(aa.stopped_count, 10) : 0,
        longestRunning:
          aa != null && (aa.longest_days != null || aa.longest_title != null)
            ? { daysRunning: aa.longest_days, adTitle: aa.longest_title }
            : null,
      },
      social: { followers },
      inventory: {
        newProducts: ia?.new_products != null ? parseInt(ia.new_products, 10) : 0,
        newStockouts: stockoutsByTarget.get(targetId) ?? [],
        priceMoves: (pricesMovesByTarget.get(targetId) ?? []).map((p) => ({
          name: p.name,
          from: parseFloat(p.from_price),
          to: parseFloat(p.to_price),
        })),
      },
    };

    competitors.push(digest);
  }

  // Sort competitors alphabetically for deterministic output
  competitors.sort((a, b) => a.targetId.localeCompare(b.targetId));

  return {
    generatedFor: latestDate,
    note: "Day-over-day competitor changes. Discount/velocity figures are estimates.",
    competitors,
  };
}
