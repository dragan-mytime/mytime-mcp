import { type SQL, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { getAppSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Freshness of one collector family's data for a target (from ingestion_runs). */
export interface FreshnessInfo {
  /** Timestamp of the last successful ingestion run, or null if none recorded. */
  lastSuccessAt: string | null;
  /** True when the last success is missing or older than 48h — zeros may be misleading. */
  stale: boolean;
}

export interface CompetitorDigest {
  targetId: string;
  /**
   * Per-target data freshness (B2/E3): a competitor whose scrape failed shows
   * stale=true here instead of silently reading as "went quiet". Families:
   * products (web/feed collectors → sales+inventory), ads (meta-ads),
   * social (apify-* + meta-own-brand).
   */
  dataFreshness: {
    products: FreshnessInfo;
    ads: FreshnessInfo;
    social: FreshnessInfo;
  };
  sales: {
    newlyDiscounted: number;
    ended: number;
    onSaleToday: number;
    avgPct: number | null;
    samples: { name: string; was: number | null; now: number | null; pct: number | null }[];
    // Today's on-sale products grouped (top 5 each) — which brands/categories are discounted.
    byBrand: { brand: string; count: number; avgPct: number | null }[];
    byCategory: { category: string; count: number; avgPct: number | null }[];
  };
  ads: {
    activeToday: number;
    new: {
      adTitle: string | null;
      linkUrl: string | null;
      daysRunning: number | null;
      snapshotUrl: string | null;
      mediaUrl: string | null;
      mediaType: string | null;
    }[];
    stoppedCount: number;
    // "Best performing" proxy = longest-running ad, with its creative for a visual hero.
    longestRunning: {
      adTitle: string | null;
      daysRunning: number | null;
      mediaUrl: string | null;
      mediaType: string | null;
      snapshotUrl: string | null;
      linkUrl: string | null;
    } | null;
  };
  social: { followers: Record<string, number> };
  inventory: {
    newProducts: number;
    newStockouts: string[];
    priceMoves: { name: string; from: number; to: number }[];
  };
  /**
   * Price undercuts (E2): SKUs where the competitor's effective price moved BELOW
   * MY:TIME's effective price (newlyUndercut) or above it (resolved) between the
   * target's own two most recent capture dates. Uses the same matching rules as
   * compareSkus: normalized ref + brand agreement, no slug-derived refs.
   */
  priceUndercuts: {
    newlyUndercut: {
      ref: string;
      name: string;
      brand: string | null;
      mtPrice: number;
      compPrice: number;
      deltaPct: number | null;
    }[];
    resolved: {
      ref: string;
      name: string;
      brand: string | null;
      mtPrice: number;
      compPrice: number;
      deltaPct: number | null;
    }[];
    totalNewlyUndercut: number;
    totalResolved: number;
  };
}

export interface DigestResult {
  generatedFor: string;
  /** Comparison window in days (1 = day-over-day, 7 = weekly). */
  windowDays: number;
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

/**
 * Shared per-target date-resolution CTE (B2/C2). Given a query producing
 * DISTINCT (target_id, captured_date) rows for one source table, emits three
 * CTEs usable as `WITH ${perTargetDatesCte(src, days)}, ...`:
 *
 *   dd     — every (target_id, captured_date), rn = 1 for the newest per target
 *   latest — each target's own newest capture date ("today" for that target)
 *   prior  — each target's newest capture date that is ≥ `days` days older than
 *            its latest (day-over-day when days=1; weekly when days=7). A
 *            target with no old-enough capture simply has no prior row —
 *            delta metrics then read 0/empty instead of borrowing another
 *            competitor's dates (the old global `LIMIT 2` bug made a failed
 *            scrape indistinguishable from real inactivity).
 */
export function perTargetDatesCte(distinctDates: SQL, days: number): SQL {
  return sql`
    dd AS (
      SELECT target_id, captured_date,
             row_number() OVER (PARTITION BY target_id ORDER BY captured_date DESC) AS rn
      FROM (${distinctDates}) x
    ),
    latest AS (SELECT target_id, captured_date AS d FROM dd WHERE rn = 1),
    prior AS (
      SELECT dd.target_id, max(dd.captured_date) AS d
      FROM dd
      JOIN latest l ON l.target_id = dd.target_id
      WHERE dd.captured_date <= l.d - ${days}::int
      GROUP BY dd.target_id
    )`;
}

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

interface DiscountGroupRow {
  target_id: string;
  label: string; // brand or category
  cnt: string | null;
  avg_pct: string | null;
}

/** DISTINCT (target_id, captured_date) over prices for non-self targets. */
function pricesDates(competitorFilter: string | undefined): SQL {
  const filterClause = competitorFilter ? sql`AND p.target_id = ${competitorFilter}` : sql``;
  return sql`
      SELECT DISTINCT p.target_id, pr.captured_date
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}`;
}

async function querySales(
  db: Db,
  competitorFilter: string | undefined,
  days: number,
): Promise<{
  agg: SalesAggRow[];
  samples: SalesSampleRow[];
  byBrand: DiscountGroupRow[];
  byCategory: DiscountGroupRow[];
}> {
  const dates = () => perTargetDatesCte(pricesDates(competitorFilter), days);

  const aggResult = await db.execute(sql`
    WITH ${dates()},
    today_prices AS (
      SELECT pr.product_id, pr.discount_pct::float8 AS discount_pct, p.target_id
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      JOIN latest l ON l.target_id = p.target_id AND pr.captured_date = l.d
    ),
    prior_prices AS (
      SELECT pr.product_id, pr.discount_pct::float8 AS discount_pct
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      JOIN prior q ON q.target_id = p.target_id AND pr.captured_date = q.d
    )
    SELECT
      tp.target_id,
      l.d::text AS today_date,
      q.d::text AS prior_date,
      COUNT(*) FILTER (WHERE tp.discount_pct > 0)                                    AS on_sale_today,
      AVG(tp.discount_pct) FILTER (WHERE tp.discount_pct > 0)                        AS avg_pct,
      COUNT(*) FILTER (WHERE q.d IS NOT NULL AND tp.discount_pct > 0
                             AND (pp.discount_pct IS NULL OR pp.discount_pct = 0))   AS newly_discounted,
      COUNT(*) FILTER (WHERE (tp.discount_pct IS NULL OR tp.discount_pct = 0)
                             AND pp.discount_pct > 0)                                AS ended
    FROM today_prices tp
    JOIN latest l ON l.target_id = tp.target_id
    LEFT JOIN prior q ON q.target_id = tp.target_id
    LEFT JOIN prior_prices pp ON pp.product_id = tp.product_id
    GROUP BY tp.target_id, l.d, q.d
  `);

  const sampleResult = await db.execute(sql`
    WITH ${dates()},
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
      JOIN latest l ON l.target_id = p.target_id AND tp.captured_date = l.d
      JOIN prior q ON q.target_id = p.target_id
      LEFT JOIN prices pp ON pp.product_id = tp.product_id AND pp.captured_date = q.d
      WHERE tp.discount_pct > 0
        AND (pp.discount_pct IS NULL OR pp.discount_pct = 0)
    )
    SELECT target_id, name, was, now, pct
    FROM newly_disc
    WHERE rn <= 5
    ORDER BY target_id, pct DESC
  `);

  // Today's on-sale products grouped by brand / category (top 5 each, by count then depth).
  const groupQuery = (col: "brand" | "category") => sql`
    WITH ${dates()},
    ranked AS (
      SELECT
        p.target_id,
        p.${sql.raw(col)} AS label,
        COUNT(*) AS cnt,
        AVG(pr.discount_pct::float8) AS avg_pct,
        ROW_NUMBER() OVER (
          PARTITION BY p.target_id
          ORDER BY COUNT(*) DESC, AVG(pr.discount_pct::float8) DESC
        ) AS rn
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      JOIN latest l ON l.target_id = p.target_id AND pr.captured_date = l.d
      WHERE pr.discount_pct > 0
        AND p.${sql.raw(col)} IS NOT NULL
      GROUP BY p.target_id, p.${sql.raw(col)}
    )
    SELECT target_id, label, cnt, avg_pct FROM ranked WHERE rn <= 5 ORDER BY target_id, cnt DESC
  `;
  const [byBrandResult, byCategoryResult] = await Promise.all([
    db.execute(groupQuery("brand")),
    db.execute(groupQuery("category")),
  ]);

  return {
    agg: rows<SalesAggRow>(aggResult),
    samples: rows<SalesSampleRow>(sampleResult),
    byBrand: rows<DiscountGroupRow>(byBrandResult),
    byCategory: rows<DiscountGroupRow>(byCategoryResult),
  };
}

// ── 2. ADS ──────────────────────────────────────────────────────────────────

interface AdsAggRow {
  target_id: string;
  active_today: string | null;
  stopped_count: string | null;
  longest_days: number | null;
  longest_title: string | null;
  longest_media: string | null;
  longest_media_type: string | null;
  longest_snapshot: string | null;
  longest_link: string | null;
}

interface NewAdRow {
  target_id: string;
  ad_title: string | null;
  link_url: string | null;
  days_running: number | null;
  snapshot_url: string | null;
  media_url: string | null;
  media_type: string | null;
}

/** DISTINCT (target_id, captured_date) over ad_observations for non-self targets. */
function adsDates(competitorFilter: string | undefined): SQL {
  const filterClause = competitorFilter ? sql`AND target_id = ${competitorFilter}` : sql``;
  return sql`
      SELECT DISTINCT target_id, captured_date
      FROM ad_observations
      WHERE target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}`;
}

async function queryAds(
  db: Db,
  competitorFilter: string | undefined,
  days: number,
): Promise<{ agg: AdsAggRow[]; newAds: NewAdRow[] }> {
  const dates = () => perTargetDatesCte(adsDates(competitorFilter), days);

  const aggResult = await db.execute(sql`
    WITH ${dates()},
    today_ads AS (
      SELECT a.target_id, a.ad_archive_id, a.days_running, a.ad_title,
             a.media_url, a.media_type, a.snapshot_url, a.link_url
      FROM ad_observations a
      JOIN latest l ON l.target_id = a.target_id AND a.captured_date = l.d
    ),
    longest AS (
      SELECT DISTINCT ON (target_id)
        target_id, days_running, ad_title, media_url, media_type, snapshot_url, link_url
      FROM today_ads
      ORDER BY target_id, days_running DESC NULLS LAST
    )
    SELECT
      ta.target_id,
      COUNT(*)           AS active_today,
      lo.days_running    AS longest_days,
      lo.ad_title        AS longest_title,
      lo.media_url       AS longest_media,
      lo.media_type      AS longest_media_type,
      lo.snapshot_url    AS longest_snapshot,
      lo.link_url        AS longest_link
    FROM today_ads ta
    LEFT JOIN longest lo ON lo.target_id = ta.target_id
    GROUP BY ta.target_id, lo.days_running, lo.ad_title, lo.media_url, lo.media_type,
             lo.snapshot_url, lo.link_url
  `);

  // Stopped count: ads present on the target's prior date but gone on its latest.
  const stoppedResult = await db.execute(sql`
    WITH ${dates()}
    SELECT a.target_id, COUNT(*) AS stopped_count
    FROM ad_observations a
    JOIN prior q ON q.target_id = a.target_id AND a.captured_date = q.d
    JOIN latest l ON l.target_id = a.target_id
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_observations cur
      WHERE cur.target_id = a.target_id
        AND cur.ad_archive_id = a.ad_archive_id
        AND cur.captured_date = l.d
    )
    GROUP BY a.target_id
  `);

  const newAdsResult = await db.execute(sql`
    WITH ${dates()},
    new_ads AS (
      SELECT
        a.target_id,
        a.ad_title,
        a.link_url,
        a.days_running,
        a.snapshot_url,
        a.media_url,
        a.media_type,
        ROW_NUMBER() OVER (PARTITION BY a.target_id ORDER BY a.days_running ASC NULLS LAST) AS rn
      FROM ad_observations a
      JOIN latest l ON l.target_id = a.target_id AND a.captured_date = l.d
      JOIN prior q ON q.target_id = a.target_id
      WHERE NOT EXISTS (
        SELECT 1 FROM ad_observations prev
        WHERE prev.ad_archive_id = a.ad_archive_id
          AND prev.target_id = a.target_id
          AND prev.captured_date = q.d
      )
    )
    SELECT target_id, ad_title, link_url, days_running, snapshot_url, media_url, media_type
    FROM new_ads
    WHERE rn <= 5
    ORDER BY target_id
  `);

  // Merge stopped counts into agg rows
  const stoppedMap = new Map<string, number>();
  for (const r of rows<{ target_id: string; stopped_count: string }>(stoppedResult)) {
    stoppedMap.set(r.target_id, parseInt(r.stopped_count, 10) || 0);
  }

  const aggRows = rows<Omit<AdsAggRow, "stopped_count">>(aggResult).map((r) => ({
    ...r,
    stopped_count: String(stoppedMap.get(r.target_id) ?? 0),
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

/** DISTINCT (target_id, captured_date) over follower metrics for non-self targets. */
function socialDates(competitorFilter: string | undefined): SQL {
  const filterClause = competitorFilter ? sql`AND sa.target_id = ${competitorFilter}` : sql``;
  return sql`
      SELECT DISTINCT sa.target_id, sm.captured_date
      FROM social_metrics sm
      JOIN social_accounts sa ON sa.id = sm.social_account_id
      WHERE sm.metric = 'followers'
        AND sa.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}`;
}

async function querySocial(
  db: Db,
  competitorFilter: string | undefined,
  days: number,
): Promise<SocialRow[]> {
  const result = await db.execute(sql`
    WITH ${perTargetDatesCte(socialDates(competitorFilter), days)},
    today_m AS (
      SELECT sa.target_id, sa.platform::text, sm.value::float8 AS val
      FROM social_metrics sm
      JOIN social_accounts sa ON sa.id = sm.social_account_id
      JOIN latest l ON l.target_id = sa.target_id AND sm.captured_date = l.d
      WHERE sm.metric = 'followers'
    ),
    prior_m AS (
      SELECT sa.target_id, sa.platform::text, sm.value::float8 AS val
      FROM social_metrics sm
      JOIN social_accounts sa ON sa.id = sm.social_account_id
      JOIN prior q ON q.target_id = sa.target_id AND sm.captured_date = q.d
      WHERE sm.metric = 'followers'
    )
    SELECT
      tm.target_id,
      tm.platform,
      tm.val  AS today_val,
      pm.val  AS prior_val
    FROM today_m tm
    JOIN prior_m pm ON pm.target_id = tm.target_id AND pm.platform = tm.platform
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

/** DISTINCT (target_id, captured_date) over inventory snapshots for non-self targets. */
function inventoryDates(competitorFilter: string | undefined): SQL {
  const filterClause = competitorFilter ? sql`AND p.target_id = ${competitorFilter}` : sql``;
  return sql`
      SELECT DISTINCT p.target_id, inv.captured_date
      FROM inventory_snapshots inv
      JOIN products p ON p.id = inv.product_id
      WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}`;
}

async function queryInventory(
  db: Db,
  competitorFilter: string | undefined,
  days: number,
  moveThresholdPct: number,
): Promise<{
  agg: InvAggRow[];
  stockouts: StockoutRow[];
  priceMoves: PriceMoveRow[];
}> {
  const invDates = () => perTargetDatesCte(inventoryDates(competitorFilter), days);

  // New products: first snapshot inside the window (after the target's prior
  // date; equal to its latest date when the target has no prior).
  const aggResult = await db.execute(sql`
    WITH ${invDates()},
    firsts AS (
      SELECT inv.product_id, MIN(inv.captured_date) AS first_date
      FROM inventory_snapshots inv
      GROUP BY inv.product_id
    )
    SELECT p.target_id, COUNT(*) AS new_products
    FROM products p
    JOIN firsts f ON f.product_id = p.id
    JOIN latest l ON l.target_id = p.target_id
    LEFT JOIN prior q ON q.target_id = p.target_id
    WHERE f.first_date <= l.d
      AND f.first_date > COALESCE(q.d, l.d - 1)
    GROUP BY p.target_id
  `);

  // New stockouts: in_stock on the target's prior date, out_of_stock on its latest.
  const stockoutsResult = await db.execute(sql`
    WITH ${invDates()},
    stockouts AS (
      SELECT
        p.target_id,
        p.name,
        ROW_NUMBER() OVER (PARTITION BY p.target_id ORDER BY p.name) AS rn
      FROM inventory_snapshots today_inv
      JOIN products p ON p.id = today_inv.product_id
      JOIN latest l ON l.target_id = p.target_id AND today_inv.captured_date = l.d
      JOIN prior q ON q.target_id = p.target_id
      JOIN inventory_snapshots prior_inv
        ON prior_inv.product_id = today_inv.product_id
       AND prior_inv.captured_date = q.d
      WHERE today_inv.stock_status = 'out_of_stock'
        AND prior_inv.stock_status = 'in_stock'
    )
    SELECT target_id, name
    FROM stockouts
    WHERE rn <= 8
    ORDER BY target_id, name
  `);

  // Price moves: price changed by more than the admin-set threshold
  // (discount_threshold_pct, default 5%) between the target's own two dates.
  const moveThresholdFrac = moveThresholdPct / 100;
  const priceMovesResult = await db.execute(sql`
    WITH ${perTargetDatesCte(pricesDates(competitorFilter), days)},
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
      JOIN latest l ON l.target_id = p.target_id AND pr_today.captured_date = l.d
      JOIN prior q ON q.target_id = p.target_id
      JOIN prices pr_prior
        ON pr_prior.product_id = pr_today.product_id
       AND pr_prior.captured_date = q.d
      WHERE pr_prior.price::float8 > 0
        AND ABS(pr_today.price::float8 - pr_prior.price::float8) / pr_prior.price::float8 > ${moveThresholdFrac}
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

// ── 5. PRICE UNDERCUTS (E2) ─────────────────────────────────────────────────

interface UndercutRow {
  target_id: string;
  key: string;
  name: string;
  brand: string | null;
  mt_price_today: string;
  comp_price_today: string;
  mt_price_prior: string | null;
  comp_price_prior: string | null;
}

/**
 * Detect newly-undercut and resolved SKUs day-over-day (or week-over-week with
 * days > 1). Uses the same normalized-ref + brand-gate matching rules as
 * compareSkus:
 *  - ref normalized to uppercase alphanumerics, ≥5 chars, must have a digit
 *    (slug-derived refs excluded)
 *  - brand agreement required when either side has a known brand
 *  - MY:TIME vs every competitor, one query (not per-competitor loops)
 *
 * Cap: top 10 newly-undercut + 10 resolved per competitor (by |deltaPct| desc).
 */
async function queryPriceUndercuts(
  db: Db,
  competitorFilter: string | undefined,
  days: number,
): Promise<UndercutRow[]> {
  const filterClause = competitorFilter ? sql`AND comp_p.target_id = ${competitorFilter}` : sql``;
  const result = await db.execute(sql`
    WITH
    -- Latest two capture dates per target (prices side)
    ${perTargetDatesCte(pricesDates(competitorFilter), days)},

    -- Normalized ref + brand for MY:TIME products (active, non-slug refs)
    mt_norm AS (
      SELECT
        p.id                                                                AS product_id,
        regexp_replace(upper(p.model_ref), '[^A-Z0-9]', '', 'g')           AS key,
        p.name,
        CASE WHEN upper(coalesce(p.brand,'')) LIKE 'CASIO%' THEN 'CASIO'
             ELSE upper(coalesce(p.brand,'')) END                           AS bkey
      FROM products p
      WHERE p.target_id IN (SELECT id FROM targets WHERE is_self = true)
        AND p.active
        AND p.model_ref IS NOT NULL
        AND length(regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g')) >= 5
        AND regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g') ~ '[0-9]'
    ),
    -- Latest MY:TIME effective price (single most recent row per product)
    mt_latest_price AS (
      SELECT DISTINCT ON (pr.product_id)
        pr.product_id,
        COALESCE(pr.sale_price, pr.price)::float8 AS eff
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      WHERE p.target_id IN (SELECT id FROM targets WHERE is_self = true)
      ORDER BY pr.product_id, pr.captured_date DESC
    ),

    -- Competitor effective prices on today's and prior capture dates
    comp_today AS (
      SELECT p.target_id, p.id AS product_id,
        regexp_replace(upper(p.model_ref), '[^A-Z0-9]', '', 'g') AS key,
        p.name, p.brand,
        CASE WHEN upper(coalesce(p.brand,'')) LIKE 'CASIO%' THEN 'CASIO'
             ELSE upper(coalesce(p.brand,'')) END AS bkey,
        COALESCE(pr.sale_price, pr.price)::float8 AS eff
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      JOIN latest l ON l.target_id = p.target_id AND pr.captured_date = l.d
      WHERE NOT p.target_id IN (SELECT id FROM targets WHERE is_self = true)
        AND p.active
        AND p.model_ref IS NOT NULL
        AND length(regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g')) >= 5
        AND regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g') ~ '[0-9]'
        ${filterClause}
    ),
    comp_prior AS (
      SELECT p.target_id, p.id AS product_id,
        regexp_replace(upper(p.model_ref), '[^A-Z0-9]', '', 'g') AS key,
        COALESCE(pr.sale_price, pr.price)::float8 AS eff
      FROM prices pr
      JOIN products p ON p.id = pr.product_id
      JOIN prior q ON q.target_id = p.target_id AND pr.captured_date = q.d
      WHERE NOT p.target_id IN (SELECT id FROM targets WHERE is_self = true)
        ${filterClause}
    ),

    -- Match: one coherent MT row + one coherent competitor row per key
    mt_by_key AS (
      SELECT DISTINCT ON (key) key, name, bkey, product_id
      FROM mt_norm
      ORDER BY key
    ),
    comp_today_by_key AS (
      SELECT DISTINCT ON (target_id, key) target_id, key, name, brand, bkey, eff, product_id
      FROM comp_today
      ORDER BY target_id, key, eff ASC
    ),
    comp_prior_by_key AS (
      SELECT DISTINCT ON (target_id, key) target_id, key, eff
      FROM comp_prior
      ORDER BY target_id, key, eff ASC
    ),

    -- Join: brand gate + gshock handled via bkey (G-SHOCK products in name excluded
    -- when brands disagree — exact same predicate as compareSkus)
    matched AS (
      SELECT
        ct.target_id,
        mt.key,
        ct.name,
        ct.brand,
        mlp.eff                  AS mt_price_today,
        ct.eff                   AS comp_price_today,
        mlp_prior.eff_p          AS mt_price_prior,
        cp.eff                   AS comp_price_prior
      FROM mt_by_key mt
      JOIN mt_latest_price mlp ON mlp.product_id = mt.product_id
      -- MT prior price (best available from any captured_date in prior dates across all competitors)
      LEFT JOIN LATERAL (
        SELECT COALESCE(pr.sale_price, pr.price)::float8 AS eff_p
        FROM prices pr
        WHERE pr.product_id = mt.product_id
          AND pr.captured_date IN (SELECT d FROM prior)
        ORDER BY pr.captured_date DESC LIMIT 1
      ) mlp_prior ON true
      JOIN comp_today_by_key ct
        ON ct.key = mt.key
        AND (mt.bkey = ct.bkey OR (mt.bkey = '' AND ct.bkey = ''))
      LEFT JOIN comp_prior_by_key cp
        ON cp.target_id = ct.target_id AND cp.key = ct.key
    )
    SELECT target_id, key, name, brand,
           mt_price_today::text, comp_price_today::text,
           mt_price_prior::text, comp_price_prior::text
    FROM matched
    ORDER BY target_id, abs(comp_price_today - mt_price_today) DESC
  `);
  return rows<UndercutRow>(result);
}

// ── 6. FRESHNESS (E3) ───────────────────────────────────────────────────────

interface FreshnessRow {
  target_id: string;
  family: string; // 'products' | 'ads' | 'social'
  last_success_at: string | null;
  stale: boolean;
}

/**
 * Last successful ingestion run per (active, non-self) target per collector
 * family, flagged stale when missing or older than 48h. Social + meta-ads
 * collectors record run-level rows (target_id IS NULL) — those apply to every
 * target, since one Apify run covers all accounts/pages.
 */
async function queryFreshness(
  db: Db,
  competitorFilter: string | undefined,
): Promise<FreshnessRow[]> {
  const filterClause = competitorFilter ? sql`AND t.id = ${competitorFilter}` : sql``;
  const result = await db.execute(sql`
    WITH runs AS (
      SELECT r.target_id, r.status,
             COALESCE(r.finished_at, r.started_at) AS at,
             CASE
               WHEN r.collector = 'meta-ads' THEN 'ads'
               WHEN r.collector LIKE 'apify-%' OR r.collector = 'meta-own-brand' THEN 'social'
               WHEN r.collector LIKE 'digest:%' THEN NULL
               ELSE 'products'
             END AS family
      FROM ingestion_runs r
    )
    SELECT
      t.id AS target_id,
      r.family,
      MAX(r.at) FILTER (WHERE r.status = 'success')::text AS last_success_at,
      (MAX(r.at) FILTER (WHERE r.status = 'success') IS NULL
        OR MAX(r.at) FILTER (WHERE r.status = 'success') < now() - interval '48 hours') AS stale
    FROM targets t
    JOIN runs r ON (r.target_id = t.id OR r.target_id IS NULL)
    WHERE t.is_self = false AND t.active AND r.family IS NOT NULL
      ${filterClause}
    GROUP BY t.id, r.family
  `);
  return rows<FreshnessRow>(result);
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

const STALE_FALLBACK: FreshnessInfo = { lastSuccessAt: null, stale: true };

/**
 * Competitor digest over each target's own capture dates (B2): "today" is the
 * target's latest snapshot, "prior" its latest snapshot ≥ `days` days older
 * (default 1 = day-over-day; 7 = weekly rollup, E8). Targets with stale
 * ingestion (no successful run in 48h) are flagged in `dataFreshness` (E3).
 */
export async function dailyDigest(
  db: Db,
  opts: { competitor?: string; days?: number } = {},
): Promise<DigestResult> {
  const filter = opts.competitor;
  const days = Math.max(1, Math.floor(opts.days ?? 1));

  // Admin knobs (discount_threshold_pct drives the price-move cutoff below).
  const settings = await getAppSettings(db);

  // Run all signal groups in parallel
  const [latestDate, salesData, adsData, socialData, inventoryData, freshnessData, undercutRows] =
    await Promise.all([
      fetchLatestPricesDate(db),
      querySales(db, filter, days),
      queryAds(db, filter, days),
      querySocial(db, filter, days),
      queryInventory(db, filter, days, settings.discountThresholdPct),
      queryFreshness(db, filter),
      queryPriceUndercuts(db, filter, days),
    ]);

  // Build undercut maps per target
  type UndercutItem = {
    ref: string;
    name: string;
    brand: string | null;
    mtPrice: number;
    compPrice: number;
    deltaPct: number | null;
  };
  const newlyUndercutByTarget = new Map<string, UndercutItem[]>();
  const resolvedByTarget = new Map<string, UndercutItem[]>();

  for (const r of undercutRows) {
    const mtToday = parseFloat(r.mt_price_today);
    const compToday = parseFloat(r.comp_price_today);
    const mtPrior = r.mt_price_prior != null ? parseFloat(r.mt_price_prior) : null;
    const compPrior = r.comp_price_prior != null ? parseFloat(r.comp_price_prior) : null;

    const item: UndercutItem = {
      ref: r.key,
      name: r.name,
      brand: r.brand,
      mtPrice: Math.round(mtToday),
      compPrice: Math.round(compToday),
      deltaPct: compToday > 0 ? Math.round(((compToday - mtToday) / compToday) * 100) : null,
    };

    // Newly undercut: competitor now cheaper than MT, but wasn't before
    // (or we have no prior data — treat as newly undercut when first seen as undercut)
    const undercutToday = compToday < mtToday;
    const undercutPrior = compPrior != null && mtPrior != null ? compPrior < mtPrior : false;

    if (undercutToday && !undercutPrior) {
      const arr = newlyUndercutByTarget.get(r.target_id) ?? [];
      arr.push(item);
      newlyUndercutByTarget.set(r.target_id, arr);
    } else if (!undercutToday && undercutPrior) {
      // Resolved: competitor was cheaper but is no longer
      const arr = resolvedByTarget.get(r.target_id) ?? [];
      arr.push(item);
      resolvedByTarget.set(r.target_id, arr);
    }
  }

  // Collect all target IDs that appear in any signal group. Freshness rows
  // count too: a competitor whose scrapes all fail must still show up (stale),
  // not silently vanish from the digest.
  const allTargetIds = new Set<string>();
  for (const r of salesData.agg) allTargetIds.add(r.target_id);
  for (const r of adsData.agg) allTargetIds.add(r.target_id);
  for (const r of socialData) allTargetIds.add(r.target_id);
  for (const r of inventoryData.agg) allTargetIds.add(r.target_id);
  for (const r of inventoryData.stockouts) allTargetIds.add(r.target_id);
  for (const r of inventoryData.priceMoves) allTargetIds.add(r.target_id);
  for (const r of freshnessData) allTargetIds.add(r.target_id);
  for (const [tid] of newlyUndercutByTarget) allTargetIds.add(tid);
  for (const [tid] of resolvedByTarget) allTargetIds.add(tid);

  // Exclude own brand (is_self) — this is a competitor digest. Belt-and-suspenders
  // in case any signal source slipped a self target in.
  for (const r of rows<{ id: string }>(
    await db.execute(sql`SELECT id FROM targets WHERE is_self = true`),
  )) {
    allTargetIds.delete(r.id);
  }

  // Index data by target_id for fast lookup
  const salesByTarget = new Map(salesData.agg.map((r) => [r.target_id, r]));
  const salesSamplesByTarget = new Map<string, SalesSampleRow[]>();
  for (const s of salesData.samples) {
    const arr = salesSamplesByTarget.get(s.target_id) ?? [];
    arr.push(s);
    salesSamplesByTarget.set(s.target_id, arr);
  }
  const byBrandByTarget = new Map<string, DiscountGroupRow[]>();
  for (const b of salesData.byBrand) {
    const arr = byBrandByTarget.get(b.target_id) ?? [];
    arr.push(b);
    byBrandByTarget.set(b.target_id, arr);
  }
  const byCategoryByTarget = new Map<string, DiscountGroupRow[]>();
  for (const cgr of salesData.byCategory) {
    const arr = byCategoryByTarget.get(cgr.target_id) ?? [];
    arr.push(cgr);
    byCategoryByTarget.set(cgr.target_id, arr);
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

  const freshnessByTarget = new Map<string, Map<string, FreshnessInfo>>();
  for (const f of freshnessData) {
    const m = freshnessByTarget.get(f.target_id) ?? new Map<string, FreshnessInfo>();
    m.set(f.family, { lastSuccessAt: f.last_success_at, stale: f.stale });
    freshnessByTarget.set(f.target_id, m);
  }

  // Assemble CompetitorDigest per target
  const competitors: CompetitorDigest[] = [];
  for (const targetId of allTargetIds) {
    const sa = salesByTarget.get(targetId);
    const aa = adsByTarget.get(targetId);
    const socialRows = socialByTarget.get(targetId) ?? [];
    const ia = invAggByTarget.get(targetId);
    const fresh = freshnessByTarget.get(targetId);

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
      mediaUrl: a.media_url,
      mediaType: a.media_type,
    }));

    const toGroup = (r: DiscountGroupRow) => ({
      count: r.cnt != null ? parseInt(r.cnt, 10) : 0,
      avgPct: r.avg_pct != null ? parseFloat(r.avg_pct) : null,
    });
    const byBrand = (byBrandByTarget.get(targetId) ?? []).map((r) => ({
      brand: r.label,
      ...toGroup(r),
    }));
    const byCategory = (byCategoryByTarget.get(targetId) ?? []).map((r) => ({
      category: r.label,
      ...toGroup(r),
    }));

    const followers: Record<string, number> = {};
    for (const sr of socialRows) {
      if (sr.today_val != null && sr.prior_val != null) {
        followers[sr.platform] = Math.round(parseFloat(sr.today_val) - parseFloat(sr.prior_val));
      }
    }

    const digest: CompetitorDigest = {
      targetId,
      dataFreshness: {
        products: fresh?.get("products") ?? STALE_FALLBACK,
        ads: fresh?.get("ads") ?? STALE_FALLBACK,
        social: fresh?.get("social") ?? STALE_FALLBACK,
      },
      sales: {
        onSaleToday: sa?.on_sale_today != null ? parseInt(sa.on_sale_today, 10) : 0,
        avgPct: sa?.avg_pct != null ? parseFloat(sa.avg_pct) : null,
        newlyDiscounted: sa?.newly_discounted != null ? parseInt(sa.newly_discounted, 10) : 0,
        ended: sa?.ended != null ? parseInt(sa.ended, 10) : 0,
        samples: salesSamples,
        byBrand,
        byCategory,
      },
      ads: {
        activeToday: aa?.active_today != null ? parseInt(aa.active_today, 10) : 0,
        new: newAds,
        stoppedCount: aa?.stopped_count != null ? parseInt(aa.stopped_count, 10) : 0,
        longestRunning:
          aa != null && (aa.longest_days != null || aa.longest_title != null)
            ? {
                adTitle: aa.longest_title,
                daysRunning: aa.longest_days,
                mediaUrl: aa.longest_media,
                mediaType: aa.longest_media_type,
                snapshotUrl: aa.longest_snapshot,
                linkUrl: aa.longest_link,
              }
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
      priceUndercuts: {
        newlyUndercut: (newlyUndercutByTarget.get(targetId) ?? []).slice(0, 10),
        resolved: (resolvedByTarget.get(targetId) ?? []).slice(0, 10),
        totalNewlyUndercut: (newlyUndercutByTarget.get(targetId) ?? []).length,
        totalResolved: (resolvedByTarget.get(targetId) ?? []).length,
      },
    };

    competitors.push(digest);
  }

  // Sort competitors alphabetically for deterministic output
  competitors.sort((a, b) => a.targetId.localeCompare(b.targetId));

  return {
    generatedFor: latestDate,
    windowDays: days,
    note:
      days === 1
        ? "Day-over-day competitor changes, each competitor compared on its OWN latest vs prior capture dates. Targets with dataFreshness.stale=true have no successful scrape in 48h — treat their zeros as 'no fresh data', not inactivity. Discount/velocity figures are estimates."
        : `Competitor changes over a ~${days}-day window: each competitor's latest capture vs its latest capture at least ${days} days earlier. Targets with dataFreshness.stale=true have no successful scrape in 48h — treat their zeros as 'no fresh data', not inactivity. Discount/velocity figures are estimates.`,
    competitors,
  };
}
