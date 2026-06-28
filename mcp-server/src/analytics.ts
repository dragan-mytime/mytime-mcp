import type { Pool } from "@mytime/shared";

export const DEPLETION_DISCLAIMER =
  "Estimated from inventory depletion, not measured sales. Sites with exact stock counts (B-Watch, Bozinovski, Saat&Saat, Zia) yield 'exact'-basis estimates; others assume 1 unit per stock-out or disappearance ('assumed' basis). Needs ≥2 days of snapshots to produce velocity.";

/**
 * Shared depletion CTE: day-over-day stock deltas → inferred units sold per
 * product per day, with basis (exact|assumed). Restocks (qty up) and gaps count
 * as 0. `$1` = lookback days; an optional target filter is appended by callers.
 */
function depletionCte(targetFilter: string): string {
  return `
    WITH snaps AS (
      SELECT s.product_id, p.target_id, p.name, p.brand, s.captured_date,
             s.stock_quantity, s.stock_status, s.qty_basis,
             lag(s.stock_quantity) OVER w AS prev_qty,
             lag(s.stock_status)  OVER w AS prev_status
      FROM inventory_snapshots s
      JOIN products p ON p.id = s.product_id
      WHERE s.captured_date >= current_date - $1::int ${targetFilter}
      WINDOW w AS (PARTITION BY s.product_id ORDER BY s.captured_date)
    ),
    units AS (
      SELECT target_id, product_id, name, brand, captured_date,
        CASE
          WHEN qty_basis = 'exact' AND prev_qty IS NOT NULL AND stock_quantity < prev_qty
            THEN prev_qty - stock_quantity
          WHEN prev_status IN ('in_stock','low_stock') AND stock_status = 'out_of_stock'
            THEN 1
          ELSE 0
        END AS sold,
        CASE
          WHEN qty_basis = 'exact' AND prev_qty IS NOT NULL AND stock_quantity < prev_qty
            THEN 'exact' ELSE 'assumed'
        END AS basis
      FROM snaps
    )`;
}

/** get_inventory_velocity — estimated units sold by product/competitor over a period. */
export async function inventoryVelocity(
  pool: Pool,
  opts: { competitor?: string; days?: number; limit?: number },
) {
  const days = opts.days ?? 30;
  const limit = Math.min(opts.limit ?? 20, 100);
  const params: unknown[] = [days];
  let filter = "";
  if (opts.competitor) {
    params.push(opts.competitor);
    filter = `AND p.target_id = $${params.length}`;
  }
  const cte = depletionCte(filter);

  const topProducts = await pool.query(
    `${cte}
     SELECT target_id, name AS product, brand, sum(sold)::int AS est_units,
            CASE WHEN bool_or(basis = 'exact') THEN 'exact' ELSE 'assumed' END AS basis
     FROM units WHERE sold > 0
     GROUP BY target_id, product_id, name, brand
     ORDER BY est_units DESC LIMIT ${limit}`,
    params,
  );
  const byCompetitor = await pool.query(
    `${cte}
     SELECT target_id, sum(sold)::int AS est_units,
            count(*) FILTER (WHERE sold > 0 AND basis = 'exact') AS exact_events,
            count(*) FILTER (WHERE sold > 0 AND basis = 'assumed') AS assumed_events
     FROM units GROUP BY target_id HAVING sum(sold) > 0 ORDER BY est_units DESC`,
    params,
  );
  return {
    period_days: days,
    disclaimer: DEPLETION_DISCLAIMER,
    by_competitor: byCompetitor.rows,
    top_products: topProducts.rows,
  };
}

/** compare_market_share — MY:TIME vs a competitor on assortment, price, velocity. */
export async function compareMarketShare(pool: Pool, opts: { competitor: string; days?: number }) {
  const days = opts.days ?? 30;
  const ids = ["mytime", opts.competitor];

  const assortment = await pool.query(
    `SELECT p.target_id,
            count(*) FILTER (WHERE p.active) AS active_skus,
            count(DISTINCT p.brand) AS brands,
            round(avg(lp.price)) AS avg_price,
            round(min(lp.price)) AS min_price,
            round(max(lp.price)) AS max_price
     FROM products p
     LEFT JOIN LATERAL (
       SELECT price FROM prices pr WHERE pr.product_id = p.id ORDER BY captured_date DESC LIMIT 1
     ) lp ON true
     WHERE p.target_id = ANY($1) GROUP BY p.target_id`,
    [ids],
  );

  const velocity = await pool.query(
    `${depletionCte("AND p.target_id = ANY($2)")}
     SELECT target_id, sum(sold)::int AS est_units_sold FROM units GROUP BY target_id`,
    [days, ids],
  );

  // Brands the competitor carries that MY:TIME also carries (head-to-head overlap).
  const overlap = await pool.query(
    `SELECT count(*)::int AS shared_brands FROM (
       SELECT lower(brand) b FROM products WHERE target_id='mytime' AND brand IS NOT NULL
       INTERSECT
       SELECT lower(brand) FROM products WHERE target_id=$1 AND brand IS NOT NULL
     ) t`,
    [opts.competitor],
  );

  return {
    competitor: opts.competitor,
    period_days: days,
    disclaimer: DEPLETION_DISCLAIMER,
    assortment: assortment.rows,
    velocity: velocity.rows,
    shared_brands: overlap.rows[0]?.shared_brands ?? 0,
  };
}

/** social_benchmark — latest public social metrics, brand vs competitors. */
export async function socialBenchmark(pool: Pool, opts: { platform?: string; metric?: string }) {
  const metric = opts.metric ?? "followers";
  const params: unknown[] = [metric];
  let platformFilter = "";
  if (opts.platform) {
    params.push(opts.platform);
    platformFilter = `AND sa.platform = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (sa.target_id, sa.platform)
            sa.target_id, sa.platform, sm.metric, sm.value::numeric AS value, sm.captured_date
     FROM social_metrics sm
     JOIN social_accounts sa ON sa.id = sm.social_account_id
     WHERE sm.metric = $1 ${platformFilter}
     ORDER BY sa.target_id, sa.platform, sm.captured_date DESC`,
    params,
  );
  return {
    metric,
    platform: opts.platform ?? "all",
    note: "Competitor social = public metrics only. MY:TIME own-brand metrics arrive with Step F (official APIs).",
    rows,
  };
}

/** price_assortment — price ranges and assortment, by competitor/brand. */
export async function priceAssortment(pool: Pool, opts: { competitor?: string; brand?: string }) {
  const params: unknown[] = [];
  const conds: string[] = ["p.active"];
  if (opts.competitor) {
    params.push(opts.competitor);
    conds.push(`p.target_id = $${params.length}`);
  }
  if (opts.brand) {
    params.push(opts.brand.toLowerCase());
    conds.push(`lower(p.brand) = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT p.target_id,
            count(*) AS skus,
            count(*) FILTER (WHERE lp.sale_price IS NOT NULL) AS on_sale,
            round(min(lp.price)) AS min_price,
            round(max(lp.price)) AS max_price,
            round(avg(lp.price)) AS avg_price,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY lp.price)) AS median_price
     FROM products p
     JOIN LATERAL (
       SELECT price, sale_price FROM prices pr WHERE pr.product_id = p.id
       ORDER BY captured_date DESC LIMIT 1
     ) lp ON true
     WHERE ${conds.join(" AND ")}
     GROUP BY p.target_id ORDER BY skus DESC`,
    params,
  );
  return { currency: "MKD", filters: { competitor: opts.competitor, brand: opts.brand }, rows };
}
