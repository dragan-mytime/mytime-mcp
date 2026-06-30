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

/** competitor_ads — active Meta Ad Library ads per competitor, with longevity + creative details. */
export async function competitorAds(pool: Pool, args: { competitor?: string; days?: number }) {
  const days = args.days ?? 30;
  const params: unknown[] = [days];
  let targetFilter = "";
  if (args.competitor) {
    params.push(args.competitor);
    targetFilter = `AND a.target_id = $${params.length}`;
  }

  // --- Summary per competitor (on their latest captured_date within the window) ---
  const summaryRes = await pool.query(
    `WITH latest AS (
       SELECT target_id, max(captured_date) AS latest_date
       FROM ad_observations
       WHERE captured_date >= current_date - $1::int ${targetFilter.replace(/a\./g, "")}
       GROUP BY target_id
     )
     SELECT a.target_id,
            count(*)::int                                         AS active_ads,
            round(avg(a.days_running))::int                       AS avg_days_running,
            max(a.days_running)                                   AS max_days_running
     FROM ad_observations a
     JOIN latest l ON l.target_id = a.target_id AND a.captured_date = l.latest_date
     GROUP BY a.target_id
     ORDER BY a.target_id`,
    params,
  );

  // --- Platform breakdown (unnest the platforms[] array) ---
  const platformRes = await pool.query(
    `WITH latest AS (
       SELECT target_id, max(captured_date) AS latest_date
       FROM ad_observations
       WHERE captured_date >= current_date - $1::int ${targetFilter.replace(/a\./g, "")}
       GROUP BY target_id
     )
     SELECT a.target_id, p.platform, count(*)::int AS ads
     FROM ad_observations a
     JOIN latest l ON l.target_id = a.target_id AND a.captured_date = l.latest_date
     CROSS JOIN LATERAL unnest(a.platforms) AS p(platform)
     GROUP BY a.target_id, p.platform
     ORDER BY a.target_id, ads DESC`,
    params,
  );

  // --- Top ads per competitor (up to 10, ordered by longevity desc) ---
  const topAdsRes = await pool.query(
    `WITH latest AS (
       SELECT target_id, max(captured_date) AS latest_date
       FROM ad_observations
       WHERE captured_date >= current_date - $1::int ${targetFilter.replace(/a\./g, "")}
       GROUP BY target_id
     ),
     ranked AS (
       SELECT a.target_id, a.days_running, a.started_running_date, a.cta_type,
              a.link_url, a.ad_title,
              left(a.ad_body, 160) AS ad_body,
              a.snapshot_url,
              row_number() OVER (PARTITION BY a.target_id ORDER BY a.days_running DESC NULLS LAST) AS rn
       FROM ad_observations a
       JOIN latest l ON l.target_id = a.target_id AND a.captured_date = l.latest_date
     )
     SELECT target_id, days_running, started_running_date, cta_type, link_url, ad_title, ad_body, snapshot_url
     FROM ranked WHERE rn <= 10
     ORDER BY target_id, days_running DESC NULLS LAST`,
    params,
  );

  // --- Top landing pages per competitor (link_url grouped, top 5) ---
  const landingRes = await pool.query(
    `WITH latest AS (
       SELECT target_id, max(captured_date) AS latest_date
       FROM ad_observations
       WHERE captured_date >= current_date - $1::int ${targetFilter.replace(/a\./g, "")}
       GROUP BY target_id
     ),
     ranked AS (
       SELECT a.target_id, a.link_url, count(*)::int AS ads,
              row_number() OVER (PARTITION BY a.target_id ORDER BY count(*) DESC) AS rn
       FROM ad_observations a
       JOIN latest l ON l.target_id = a.target_id AND a.captured_date = l.latest_date
       WHERE a.link_url IS NOT NULL
       GROUP BY a.target_id, a.link_url
     )
     SELECT target_id, link_url, ads FROM ranked WHERE rn <= 5
     ORDER BY target_id, ads DESC`,
    params,
  );

  // Group platform rows by target_id → { facebook: N, instagram: M, ... }
  const platformsByTarget = new Map<string, Record<string, number>>();
  for (const row of platformRes.rows as { target_id: string; platform: string; ads: number }[]) {
    if (!platformsByTarget.has(row.target_id)) platformsByTarget.set(row.target_id, {});
    platformsByTarget.get(row.target_id)![row.platform] = row.ads;
  }

  // Group top_ads rows by target_id
  const topAdsByTarget = new Map<string, unknown[]>();
  for (const row of topAdsRes.rows as { target_id: string; [k: string]: unknown }[]) {
    const { target_id, ...ad } = row;
    if (!topAdsByTarget.has(target_id)) topAdsByTarget.set(target_id, []);
    topAdsByTarget.get(target_id)!.push(ad);
  }

  // Group landing pages by target_id
  const landingByTarget = new Map<string, unknown[]>();
  for (const row of landingRes.rows as { target_id: string; link_url: string; ads: number }[]) {
    if (!landingByTarget.has(row.target_id)) landingByTarget.set(row.target_id, []);
    landingByTarget.get(row.target_id)!.push({ link_url: row.link_url, ads: row.ads });
  }

  const competitors = (
    summaryRes.rows as {
      target_id: string;
      active_ads: number;
      avg_days_running: number | null;
      max_days_running: number | null;
    }[]
  ).map((r) => ({
    target_id: r.target_id,
    active_ads: r.active_ads,
    avg_days_running: r.avg_days_running,
    max_days_running: r.max_days_running,
    platforms: platformsByTarget.get(r.target_id) ?? {},
    top_ads: topAdsByTarget.get(r.target_id) ?? [],
    top_landing_pages: landingByTarget.get(r.target_id) ?? [],
  }));

  return {
    note: "Active Meta Ad Library ads. Longevity (days_running) is the performance proxy — spend/impressions are NOT public for these (non-EU, commercial) ads.",
    period_days: days,
    competitors,
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

interface SkuMatchRow {
  target_id: string;
  key: string;
  mt_name: string;
  comp_name: string;
  mt_price: number;
  comp_price: number;
  mt_vs_comp_pct: number | null;
}

/**
 * Match MY:TIME products to a competitor on the normalized manufacturer reference
 * (model_ref stripped to uppercase alphanumerics, ≥5 chars), brand-compatible, and
 * Casio-correct (Timeless/Vintage collapse to CASIO; G-Shock never matches a
 * non-G-Shock). Compares the latest effective price (sale ?? regular) on each side.
 */
export async function compareSkus(pool: Pool, opts: { competitor?: string }) {
  const { rows } = await pool.query<SkuMatchRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (product_id) product_id, COALESCE(sale_price, price)::float8 AS eff
       FROM prices ORDER BY product_id, captured_date DESC
     ),
     norm AS (
       SELECT t.is_self, p.target_id,
         regexp_replace(upper(p.model_ref), '[^A-Z0-9]', '', 'g') AS key,
         p.name, l.eff,
         CASE WHEN upper(coalesce(p.brand,'')) LIKE 'CASIO%' THEN 'CASIO'
              ELSE upper(coalesce(p.brand,'')) END AS bkey,
         (upper(coalesce(p.brand,'') || ' ' || p.name) ~ 'G[ -]?SHOCK') AS gshock
       FROM products p JOIN targets t ON t.id = p.target_id
       JOIN latest l ON l.product_id = p.id
       WHERE p.active AND p.model_ref IS NOT NULL
         AND length(regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g')) >= 5
     ),
     mt AS (
       SELECT key, max(name) AS name, max(bkey) AS bkey, bool_or(gshock) AS gshock, min(eff) AS eff
       FROM norm WHERE is_self GROUP BY key
     ),
     comp AS (
       SELECT target_id, key, max(name) AS name, max(bkey) AS bkey, bool_or(gshock) AS gshock, min(eff) AS eff
       FROM norm WHERE NOT is_self GROUP BY target_id, key
     )
     SELECT comp.target_id, mt.key, mt.name AS mt_name, comp.name AS comp_name,
       mt.eff AS mt_price, comp.eff AS comp_price,
       round(100.0*(comp.eff - mt.eff)/NULLIF(comp.eff,0)) AS mt_vs_comp_pct
     FROM mt JOIN comp ON comp.key = mt.key
       AND (mt.bkey = comp.bkey OR mt.bkey = '' OR comp.bkey = '')
       AND mt.gshock = comp.gshock
     WHERE ($1::text IS NULL OR comp.target_id = $1)
     ORDER BY comp.target_id, abs(mt.eff - comp.eff) DESC`,
    [opts.competitor ?? null],
  );

  const byComp = new Map<string, SkuMatchRow[]>();
  for (const r of rows) {
    const list = byComp.get(r.target_id) ?? [];
    list.push(r);
    byComp.set(r.target_id, list);
  }
  const results = [...byComp.entries()].map(([competitor, items]) => ({
    competitor,
    matches: items.length,
    mytimeCheaper: items.filter((r) => r.mt_price < r.comp_price).length,
    competitorCheaper: items.filter((r) => r.mt_price > r.comp_price).length,
    same: items.filter((r) => r.mt_price === r.comp_price).length,
    items: items.slice(0, 50).map((r) => ({
      ref: r.key,
      mtName: r.mt_name,
      mytime: Math.round(r.mt_price),
      competitor: Math.round(r.comp_price),
      deltaPct: r.mt_vs_comp_pct,
    })),
  }));
  return { comparedAt: new Date().toISOString().slice(0, 10), currency: "MKD", results };
}
