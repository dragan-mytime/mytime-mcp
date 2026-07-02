import type { Pool } from "@mytime/shared";

export const DEPLETION_DISCLAIMER =
  "Estimated, not measured sales. Counts snapshot-to-snapshot quantity drops (exact counts on B-Watch, Bozinovski, Saat&Saat, Zia → 'exact' basis; elsewhere 1 unit per in-stock→out-of-stock transition, 'assumed') plus the last known quantity of exact-count products that disappeared from the feed. Restocks are not netted against drops; drops before the first snapshot in the window are not visible. Needs ≥2 days of snapshots.";

/**
 * Shared depletion CTE: day-over-day stock deltas → inferred units sold per
 * product per day, with basis (exact|assumed). Restocks (qty up) and gaps count
 * as 0. Disappearances are unioned in: a now-inactive product whose last
 * in-window snapshot had an exact positive quantity, and whose last_seen_date is
 * in-window and older than its target's latest snapshot (i.e. it vanished while
 * the target was still being scraped), contributes that last quantity.
 * `$1` = window length in days (window = today and the $1-1 days before it);
 * an optional target filter is appended by callers.
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
      WHERE s.captured_date >= current_date - ($1::int - 1) ${targetFilter}
      WINDOW w AS (PARTITION BY s.product_id ORDER BY s.captured_date)
    ),
    drops AS (
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
    ),
    target_latest AS (
      SELECT p2.target_id, max(s2.captured_date) AS latest_date
      FROM inventory_snapshots s2
      JOIN products p2 ON p2.id = s2.product_id
      GROUP BY p2.target_id
    ),
    last_snap AS (
      SELECT DISTINCT ON (s.product_id)
             s.product_id, p.target_id, p.name, p.brand, p.last_seen_date,
             s.stock_quantity, s.qty_basis
      FROM inventory_snapshots s
      JOIN products p ON p.id = s.product_id
      WHERE NOT p.active
        AND p.last_seen_date >= current_date - ($1::int - 1)
        AND s.captured_date >= current_date - ($1::int - 1) ${targetFilter}
      ORDER BY s.product_id, s.captured_date DESC
    ),
    disappearances AS (
      SELECT ls.target_id, ls.product_id, ls.name, ls.brand,
             ls.last_seen_date AS captured_date,
             ls.stock_quantity AS sold, 'exact' AS basis
      FROM last_snap ls
      JOIN target_latest tl
        ON tl.target_id = ls.target_id AND ls.last_seen_date < tl.latest_date
      WHERE ls.qty_basis = 'exact' AND ls.stock_quantity > 0
    ),
    units AS (
      SELECT * FROM drops
      UNION ALL
      SELECT * FROM disappearances
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
            round(avg(lp.price) FILTER (WHERE p.active)) AS avg_price,
            round(min(lp.price) FILTER (WHERE p.active)) AS min_price,
            round(max(lp.price) FILTER (WHERE p.active)) AS max_price
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

  if (metric === "engagement" || metric === "cadence") {
    const p: unknown[] = [];
    let pf = "";
    if (opts.platform) {
      p.push(opts.platform);
      pf = `AND sa.platform = $${p.length}::social_platform`;
    }
    // posts_in_window: count of posts in the 30-day scraper window — may be
    // capped by scraper depth (IG ~12, FB/TikTok ~15 per run), so it
    // undercounts prolific posters, especially early after onboarding (B6).
    // postsPerWeek: derived from the observed first→last post timestamp span in
    // the window — gives a truer cadence when posts_in_window hits the cap.
    // Use postsPerWeek when it disagrees with posts_in_window/4.3; if only one
    // post is in the window postsPerWeek is null (span = 0).
    // pctEstimatedReach: share of posts in the window whose reach_source is
    // 'estimate' (follower-based constant) rather than 'views'/'measured' (B9).
    // Engagement: IG = likes+comments; FB = reactions+comments+shares;
    // TikTok = digg+comments+shares; MY:TIME same per platform.
    const { rows } = await pool.query(
      `SELECT t.id AS target_id, sa.platform,
              count(*)::int AS posts_in_window,
              round(avg(sp.engagement)) AS avg_engagement,
              round(avg(100.0 * sp.engagement / NULLIF(fol.followers,0)), 2) AS avg_engagement_rate,
              round(100.0 * count(*) FILTER (WHERE sp.reach_source = 'estimate')
                    / NULLIF(count(*), 0), 1) AS pct_estimated_reach,
              CASE
                WHEN count(*) > 1
                THEN round(
                  count(*)::numeric
                  / GREATEST(1, (max(sp.posted_at)::date - min(sp.posted_at)::date)::numeric)
                  * 7,
                2)
                ELSE NULL
              END AS posts_per_week
       FROM social_posts sp
       JOIN social_accounts sa ON sa.id = sp.social_account_id
       JOIN targets t ON t.id = sa.target_id
       LEFT JOIN LATERAL (
         SELECT value::numeric AS followers FROM social_metrics sm
         WHERE sm.social_account_id = sa.id AND sm.metric = 'followers'
         ORDER BY sm.captured_date DESC LIMIT 1
       ) fol ON true
       WHERE sp.posted_at >= now() - interval '30 days' ${pf}
       GROUP BY t.id, sa.platform ORDER BY t.id, sa.platform`,
      p,
    );
    return {
      metric,
      platform: opts.platform ?? "all",
      note:
        metric === "cadence"
          ? "Posts per target×platform in the last 30 days, incl. MY:TIME. posts_in_window is scraper-depth-capped (IG ~12, FB/TikTok ~15 per run) and undercounts prolific posters, especially early after onboarding. postsPerWeek is derived from the observed first→last post timestamp span and is more reliable when the cap is hit; null when only one post is in the window."
          : "Avg engagement + engagementRate (engagement÷latest followers) per target×platform, last 30 days, incl. MY:TIME. Prefer engagementRate for cross-comparison. Engagement: IG = likes+comments; FB = reactions+comments+shares; TikTok = digg+comments+shares. pctEstimatedReach: share of posts using a follower-based reach estimate rather than a real metric.",
      rows,
    };
  }

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
    note: "Latest social metrics per target×platform (own-brand + competitors).",
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
       WHERE captured_date >= current_date - ($1::int - 1) ${targetFilter.replace(/a\./g, "")}
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
       WHERE captured_date >= current_date - ($1::int - 1) ${targetFilter.replace(/a\./g, "")}
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
       WHERE captured_date >= current_date - ($1::int - 1) ${targetFilter.replace(/a\./g, "")}
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
       WHERE captured_date >= current_date - ($1::int - 1) ${targetFilter.replace(/a\./g, "")}
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

interface SocialPostQueryRow {
  competitor: string;
  platform: string;
  caption: string | null;
  permalink: string | null;
  media_url: string | null;
  post_type: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  engagement: number | null;
  estimated_reach: number | null;
  reach_source: string | null;
  posted_at: string | null;
  rn: string;
  // cross-platform (partition by target only — backwards-compat top-level fields)
  posts_in_window: string;
  avg_engagement: string | null;
  avg_reach: string | null;
  engagement_rate: string | null;
  avg_engagement_rate: string | null;
  pct_estimated_reach: string | null;
  // per-platform (partition by target + platform)
  pp_posts_in_window: string;
  pp_avg_engagement: string | null;
  pp_avg_reach: string | null;
  pp_avg_engagement_rate: string | null;
  pp_pct_estimated_reach: string | null;
}

/**
 * Recent social posts per competitor with engagement + estimated reach (labeled by
 * source). Returns:
 *  - top-level cross-platform aggregate per competitor (backwards-compatible)
 *  - perPlatform breakdown so IG/FB/TikTok rates are not blended (B5)
 *  - pctEstimatedReach in both aggregates: % of posts whose reach is estimated (B9)
 *  - per-post list unchanged
 *
 * Engagement definitions (B4): IG = likes+comments; FB = reactions+comments+shares;
 * TikTok = digg+comments+shares; own-brand (MY:TIME) uses the same formula as
 * competitors per platform. engagementRate = engagement ÷ latest followers (latest
 * snapshot — fine for the 30-day window; would drift for longer windows).
 *
 * Reach labels: 'views' (TikTok) or 'estimate' (IG/FB formula × followers) for
 * competitors; 'measured' or 'estimate' for MY:TIME (measured once Meta Insights
 * permission is granted). pctEstimatedReach shows what share of posts used the
 * formula rather than a real metric.
 */
export async function socialPosts(
  pool: Pool,
  opts: { competitor?: string; platform?: string; days?: number; limit?: number },
) {
  const days = opts.days ?? 30;
  const limit = Math.min(opts.limit ?? 20, 50);
  const params: unknown[] = [days];
  const conds = ["sp.posted_at >= now() - ($1 || ' days')::interval"];
  if (opts.competitor) {
    params.push(opts.competitor);
    conds.push(`t.id = $${params.length}`);
  }
  if (opts.platform) {
    params.push(opts.platform);
    conds.push(`sa.platform = $${params.length}::social_platform`);
  }
  const { rows } = await pool.query<SocialPostQueryRow>(
    `WITH ranked AS (
       SELECT t.id AS competitor, sa.platform, sp.caption, sp.permalink, sp.media_url,
              sp.post_type, sp.likes, sp.comments, sp.shares, sp.views, sp.engagement,
              sp.estimated_reach, sp.reach_source, sp.posted_at,
              -- top-level post rank (cross-platform, for top-N selection)
              row_number() OVER (PARTITION BY t.id ORDER BY sp.engagement DESC NULLS LAST) AS rn,
              -- cross-platform aggregates per target (backwards-compat top-level fields)
              count(*) OVER (PARTITION BY t.id) AS posts_in_window,
              round(avg(sp.engagement) OVER (PARTITION BY t.id)) AS avg_engagement,
              round(avg(sp.estimated_reach) OVER (PARTITION BY t.id)) AS avg_reach,
              round(100.0 * sp.engagement / NULLIF(f.followers,0), 2) AS engagement_rate,
              round(avg(100.0 * sp.engagement / NULLIF(f.followers,0)) OVER (PARTITION BY t.id), 2) AS avg_engagement_rate,
              round(100.0 * count(*) FILTER (WHERE sp.reach_source = 'estimate') OVER (PARTITION BY t.id)
                    / NULLIF(count(*) OVER (PARTITION BY t.id), 0), 1) AS pct_estimated_reach,
              -- per-platform aggregates (B5: partition by target + platform)
              count(*) OVER (PARTITION BY t.id, sa.platform) AS pp_posts_in_window,
              round(avg(sp.engagement) OVER (PARTITION BY t.id, sa.platform)) AS pp_avg_engagement,
              round(avg(sp.estimated_reach) OVER (PARTITION BY t.id, sa.platform)) AS pp_avg_reach,
              round(avg(100.0 * sp.engagement / NULLIF(f.followers,0)) OVER (PARTITION BY t.id, sa.platform), 2) AS pp_avg_engagement_rate,
              round(100.0 * count(*) FILTER (WHERE sp.reach_source = 'estimate') OVER (PARTITION BY t.id, sa.platform)
                    / NULLIF(count(*) OVER (PARTITION BY t.id, sa.platform), 0), 1) AS pp_pct_estimated_reach
       FROM social_posts sp
       JOIN social_accounts sa ON sa.id = sp.social_account_id
       JOIN targets t ON t.id = sa.target_id
       LEFT JOIN LATERAL (
         SELECT value::numeric AS followers FROM social_metrics sm
         WHERE sm.social_account_id = sa.id AND sm.metric = 'followers'
         ORDER BY sm.captured_date DESC LIMIT 1
       ) f ON true
       WHERE ${conds.join(" AND ")}
     )
     SELECT * FROM ranked WHERE rn <= ${limit} ORDER BY competitor, engagement DESC NULLS LAST`,
    params,
  );

  // Collect per-platform summaries per competitor from the window data rows.
  // We deduplicate using a Map keyed by "competitor|platform" so we only store
  // each platform's aggregate once (all rows for the same target+platform carry
  // identical window aggregate values).
  const byComp = new Map<
    string,
    {
      competitor: string;
      postsInWindow: number;
      avgEngagement: number | null;
      avgReach: number | null;
      avgEngagementRate: number | null;
      pctEstimatedReach: number | null;
      perPlatform: {
        platform: string;
        postsInWindow: number;
        avgEngagement: number | null;
        avgEngagementRate: number | null;
        avgReach: number | null;
        pctEstimatedReach: number | null;
      }[];
      posts: unknown[];
    }
  >();
  const seenPlatform = new Set<string>();

  for (const r of rows) {
    if (!byComp.has(r.competitor)) {
      byComp.set(r.competitor, {
        competitor: r.competitor,
        postsInWindow: Number(r.posts_in_window),
        avgEngagement: r.avg_engagement === null ? null : Number(r.avg_engagement),
        avgReach: r.avg_reach === null ? null : Number(r.avg_reach),
        avgEngagementRate: r.avg_engagement_rate === null ? null : Number(r.avg_engagement_rate),
        pctEstimatedReach: r.pct_estimated_reach === null ? null : Number(r.pct_estimated_reach),
        perPlatform: [],
        posts: [],
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: set unconditionally in the if-block above
    const g = byComp.get(r.competitor)!;

    const ppKey = `${r.competitor}|${r.platform}`;
    if (!seenPlatform.has(ppKey)) {
      seenPlatform.add(ppKey);
      g.perPlatform.push({
        platform: r.platform,
        postsInWindow: Number(r.pp_posts_in_window),
        avgEngagement: r.pp_avg_engagement === null ? null : Number(r.pp_avg_engagement),
        avgEngagementRate:
          r.pp_avg_engagement_rate === null ? null : Number(r.pp_avg_engagement_rate),
        avgReach: r.pp_avg_reach === null ? null : Number(r.pp_avg_reach),
        pctEstimatedReach:
          r.pp_pct_estimated_reach === null ? null : Number(r.pp_pct_estimated_reach),
      });
    }

    g.posts.push({
      platform: r.platform,
      type: r.post_type,
      caption: r.caption,
      permalink: r.permalink,
      mediaUrl: r.media_url,
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      views: r.views,
      engagement: r.engagement,
      estimatedReach: r.estimated_reach,
      reachSource: r.reach_source,
      engagementRate: r.engagement_rate === null ? null : Number(r.engagement_rate),
      postedAt: r.posted_at,
    });
  }
  return {
    windowDays: days,
    reachNote:
      "Compare on engagementRate (engagement ÷ latest followers). Top-level averages are cross-platform (IG+FB+TikTok blended); use perPlatform for like-for-like comparisons. Engagement: IG = likes+comments; FB = reactions+comments+shares; TikTok = digg+comments+shares; MY:TIME uses the same formula per platform. Reach source: 'views' (TikTok) or 'estimate' (follower-based constant × followers) for competitors; 'measured' or 'estimate' for MY:TIME. pctEstimatedReach shows the share of posts in the window that used an estimated reach figure.",
    results: [...byComp.values()],
  };
}

/**
 * data_health — ingestion freshness per target × collector (E3). Social and
 * meta-ads collectors record run-level rows (target_id IS NULL — one Apify run
 * covers every account/page); those are reported under '(all targets)'.
 */
export async function dataHealth(pool: Pool, opts: { competitor?: string } = {}) {
  const params: unknown[] = [];
  let filter = "";
  if (opts.competitor) {
    params.push(opts.competitor);
    // Run-level rows (NULL target) still apply to the requested competitor.
    filter = `AND (r.target_id = $${params.length} OR r.target_id IS NULL)`;
  }
  const { rows } = await pool.query(
    `WITH runs AS (
       SELECT COALESCE(r.target_id, '(all targets)') AS target_id,
              r.collector, r.status, r.error, r.rows_written,
              COALESCE(r.finished_at, r.started_at) AS at,
              row_number() OVER (
                PARTITION BY COALESCE(r.target_id, '(all targets)'), r.collector
                ORDER BY r.started_at DESC
              ) AS rn
       FROM ingestion_runs r
       WHERE r.collector NOT LIKE 'digest:%' ${filter}
     ),
     last_success AS (
       SELECT DISTINCT ON (target_id, collector) target_id, collector, at, rows_written
       FROM runs WHERE status = 'success' ORDER BY target_id, collector, at DESC
     ),
     last_failure AS (
       SELECT DISTINCT ON (target_id, collector) target_id, collector, at, error
       FROM runs WHERE status = 'failed' ORDER BY target_id, collector, at DESC
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
     SELECT b.target_id, b.collector,
            ls.at::text                    AS last_success_at,
            ls.rows_written::int           AS rows_last_success,
            lf.at::text                    AS last_failure_at,
            lf.error                       AS last_error,
            COALESCE(c.consecutive_failures, 0) AS consecutive_failures,
            (ls.at IS NULL OR ls.at < now() - interval '48 hours') AS stale
     FROM (SELECT DISTINCT target_id, collector FROM runs) b
     LEFT JOIN last_success ls ON ls.target_id = b.target_id AND ls.collector = b.collector
     LEFT JOIN last_failure lf ON lf.target_id = b.target_id AND lf.collector = b.collector
     LEFT JOIN consec c        ON c.target_id  = b.target_id AND c.collector  = b.collector
     ORDER BY b.target_id, b.collector`,
    params,
  );
  return {
    note: "Per target × collector ingestion health. stale = no successful run in 48h — other tools' zeros for that target/family mean 'no fresh data', not inactivity. '(all targets)' rows are collectors that run once for every target (social, meta-ads).",
    staleAfterHours: 48,
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

interface SkuMatchRow {
  target_id: string;
  key: string;
  mt_name: string;
  comp_name: string;
  mt_bkey: string;
  comp_bkey: string;
  mt_price: number;
  comp_price: number;
  mt_vs_comp_pct: number | null;
  brand_unverified: boolean;
}

/**
 * Internal SQL fragment that builds the canonical normalized-ref + brand CTEs
 * used by both compareSkus and the undercut-alert digest section.
 *
 * Changes vs original (B7, B8):
 *
 *  B7a — slug-sourced refs: model_ref values that are all-uppercase-alpha + hyphens
 *         (no digit) are characteristic of URL-slug fallbacks. These are excluded from
 *         matching by requiring the key to have at least one digit after normalization
 *         — consistent with how refScore already gates name-derived refs.
 *         (The real fix is callers not storing slug refs; the SQL guard is defense-in-depth
 *         for refs already in the DB.)
 *
 *  B7b — brand gate: the join now requires `mt.bkey = comp.bkey` when either side
 *         has a known brand (non-empty bkey). When both sides are brandless the match
 *         is allowed but flagged `brandUnverified: true` in output.
 *
 *  B8  — coherent rows: key-collision collapse switched from max(name)/min(eff) mixing
 *         fields across different products to `DISTINCT ON (key) ORDER BY key,
 *         effective_price ASC`, so each side contributes one coherent (cheapest variant)
 *         product row — name/brand/price all from the same product.
 */
function compareSkusCteFragment(): string {
  return `
    latest AS (
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
        -- B7a: exclude slug-derived refs (no digit after stripping → slug-like)
        AND regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g') ~ '[0-9]'
    ),
    -- B8: DISTINCT ON picks one coherent row per key (cheapest effective price),
    -- so name/brand/price all come from the same product variant.
    mt AS (
      SELECT DISTINCT ON (key) key, name, bkey, gshock, eff
      FROM norm WHERE is_self
      ORDER BY key, eff ASC
    ),
    comp AS (
      SELECT DISTINCT ON (target_id, key) target_id, key, name, bkey, gshock, eff
      FROM norm WHERE NOT is_self
      ORDER BY target_id, key, eff ASC
    )`;
}

/**
 * Match MY:TIME products to a competitor on the normalized manufacturer reference
 * (model_ref stripped to uppercase alphanumerics, ≥5 chars, must contain a digit),
 * brand-compatible (B7b), and Casio-correct (Timeless/Vintage collapse to CASIO;
 * G-Shock never matches a non-G-Shock). Compares the latest effective price
 * (sale ?? regular) on each side. Slug-sourced refs excluded from matching (B7a).
 * Each side contributes one coherent product per key (cheapest variant, B8).
 */
export async function compareSkus(pool: Pool, opts: { competitor?: string }) {
  const { rows } = await pool.query<SkuMatchRow>(
    `WITH ${compareSkusCteFragment()}
     SELECT comp.target_id, mt.key,
       mt.name AS mt_name, comp.name AS comp_name,
       mt.bkey AS mt_bkey, comp.bkey AS comp_bkey,
       mt.eff AS mt_price, comp.eff AS comp_price,
       round(100.0*(comp.eff - mt.eff)/NULLIF(comp.eff,0)) AS mt_vs_comp_pct,
       -- B7b: brand_unverified when both sides are brandless (blank-blank match)
       (mt.bkey = '' AND comp.bkey = '') AS brand_unverified
     FROM mt JOIN comp ON comp.key = mt.key
       -- B7b: brand gate — must agree when either side has a brand
       AND (mt.bkey = comp.bkey OR (mt.bkey = '' AND comp.bkey = ''))
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
      brandUnverified: r.brand_unverified,
    })),
  }));
  return {
    note: "Matched on normalized manufacturer ref (≥5 alphanumerics, must contain a digit). Slug-derived refs excluded (B7). Brand agreement required when either side has a known brand; blank-blank matches are flagged brandUnverified. Each side contributes one coherent product per ref key (cheapest variant, B8).",
    comparedAt: new Date().toISOString().slice(0, 10),
    currency: "MKD",
    results,
  };
}

// ---------------------------------------------------------------------------
// E1: price_history
// ---------------------------------------------------------------------------

/**
 * price_history — full time series (date, price, discountPct) per product plus
 * a summary (current, min, max, biggest single-day drop). At least one filter
 * is required; up to `limit` products are returned.
 *
 * Source note: prices come from web scrapes (regular + sale_price columns); the
 * effective price used for the summary is COALESCE(sale_price, price).
 */
export async function priceHistory(
  pool: Pool,
  opts: {
    competitor?: string;
    brand?: string;
    modelRef?: string;
    q?: string;
    days?: number;
    limit?: number;
  },
) {
  const days = Math.min(opts.days ?? 90, 365);
  const limit = Math.min(opts.limit ?? 20, 100);

  const params: unknown[] = [days];
  const conds: string[] = ["p.active", `pr.captured_date >= current_date - $${params.length}::int`];

  if (opts.competitor) {
    params.push(opts.competitor);
    conds.push(`p.target_id = $${params.length}`);
  }
  if (opts.brand) {
    params.push(opts.brand.toLowerCase());
    conds.push(`lower(p.brand) = $${params.length}`);
  }
  if (opts.modelRef) {
    params.push(opts.modelRef.toUpperCase());
    conds.push(`upper(p.model_ref) = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    conds.push(`p.name ILIKE $${params.length}`);
  }

  const { rows } = await pool.query(
    `WITH series AS (
       SELECT p.target_id, p.id AS product_id, p.name, p.brand, p.model_ref,
              pr.captured_date,
              pr.price::float8                          AS regular_price,
              pr.sale_price::float8                     AS sale_price,
              COALESCE(pr.sale_price, pr.price)::float8 AS eff_price,
              pr.discount_pct::float8                   AS discount_pct
       FROM prices pr
       JOIN products p ON p.id = pr.product_id
       WHERE ${conds.join(" AND ")}
     ),
     product_ids AS (
       SELECT DISTINCT product_id FROM series
       LIMIT ${limit}
     )
     SELECT s.target_id, s.product_id, s.name, s.brand, s.model_ref,
            s.captured_date::text, s.eff_price, s.discount_pct
     FROM series s
     JOIN product_ids pi ON pi.product_id = s.product_id
     ORDER BY s.product_id, s.captured_date`,
    params,
  );

  // Group into per-product date series + summary
  const products = new Map<
    string,
    {
      targetId: string;
      name: string;
      brand: string | null;
      modelRef: string | null;
      series: { date: string; price: number; discountPct: number | null }[];
    }
  >();

  for (const r of rows as {
    target_id: string;
    product_id: string;
    name: string;
    brand: string | null;
    model_ref: string | null;
    captured_date: string;
    eff_price: number;
    discount_pct: number | null;
  }[]) {
    if (!products.has(r.product_id)) {
      products.set(r.product_id, {
        targetId: r.target_id,
        name: r.name,
        brand: r.brand,
        modelRef: r.model_ref,
        series: [],
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: set unconditionally above
    products.get(r.product_id)!.series.push({
      date: r.captured_date,
      price: Math.round(r.eff_price),
      discountPct: r.discount_pct != null ? parseFloat(String(r.discount_pct)) : null,
    });
  }

  const result = [...products.entries()].map(([, p]) => {
    const prices = p.series.map((s) => s.price);
    const current = prices[prices.length - 1] ?? null;
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;

    // Biggest single-day drop (day N price - day N-1 price, most negative)
    let biggestDropPct: number | null = null;
    let biggestDropDate: string | null = null;
    for (let i = 1; i < p.series.length; i++) {
      const prevEntry = p.series[i - 1];
      const currEntry = p.series[i];
      if (!prevEntry || !currEntry) continue;
      const prev = prevEntry.price;
      const curr = currEntry.price;
      if (prev > 0 && curr < prev) {
        const dropPct = Math.round(((prev - curr) / prev) * 100);
        if (biggestDropPct === null || dropPct > biggestDropPct) {
          biggestDropPct = dropPct;
          biggestDropDate = currEntry.date;
        }
      }
    }

    return {
      targetId: p.targetId,
      name: p.name,
      brand: p.brand,
      modelRef: p.modelRef,
      summary: { current, min, max, biggestDropPct, biggestDropDate },
      series: p.series,
    };
  });

  return {
    note: "Effective price = COALESCE(sale_price, price). Prices come from web scrapes (captured once daily). discountPct is null when not on sale.",
    periodDays: days,
    currency: "MKD",
    products: result,
  };
}

// ---------------------------------------------------------------------------
// E4: assortment_gaps
// ---------------------------------------------------------------------------

/**
 * assortment_gaps — brands a competitor carries that MY:TIME doesn't (and vice
 * versa), with per-brand product count + min/median/max effective price for active
 * products. Uses the same brand normalization as compareSkus (CASIO% collapse,
 * case-insensitive).
 */
export async function assortmentGaps(pool: Pool, opts: { competitor: string }) {
  const { rows } = await pool.query(
    `WITH mt_brands AS (
       SELECT CASE WHEN upper(p.brand) LIKE 'CASIO%' THEN 'CASIO' ELSE upper(p.brand) END AS bkey,
              p.brand AS raw_brand
       FROM products p
       WHERE p.target_id IN (SELECT id FROM targets WHERE is_self = true)
         AND p.active AND p.brand IS NOT NULL
     ),
     comp_brands AS (
       SELECT CASE WHEN upper(p.brand) LIKE 'CASIO%' THEN 'CASIO' ELSE upper(p.brand) END AS bkey,
              p.brand AS raw_brand
       FROM products p
       WHERE p.target_id = $1 AND p.active AND p.brand IS NOT NULL
     ),
     mt_only AS (
       SELECT DISTINCT bkey FROM mt_brands
       EXCEPT
       SELECT DISTINCT bkey FROM comp_brands
     ),
     comp_only AS (
       SELECT DISTINCT bkey FROM comp_brands
       EXCEPT
       SELECT DISTINCT bkey FROM mt_brands
     ),
     mt_prices AS (
       SELECT CASE WHEN upper(p.brand) LIKE 'CASIO%' THEN 'CASIO' ELSE upper(p.brand) END AS bkey,
              COALESCE(lp.sale_price, lp.price)::float8 AS eff
       FROM products p
       JOIN LATERAL (
         SELECT price, sale_price FROM prices pr WHERE pr.product_id = p.id
         ORDER BY captured_date DESC LIMIT 1
       ) lp ON true
       WHERE p.target_id IN (SELECT id FROM targets WHERE is_self = true)
         AND p.active AND p.brand IS NOT NULL
     ),
     comp_prices AS (
       SELECT CASE WHEN upper(p.brand) LIKE 'CASIO%' THEN 'CASIO' ELSE upper(p.brand) END AS bkey,
              COALESCE(lp.sale_price, lp.price)::float8 AS eff
       FROM products p
       JOIN LATERAL (
         SELECT price, sale_price FROM prices pr WHERE pr.product_id = p.id
         ORDER BY captured_date DESC LIMIT 1
       ) lp ON true
       WHERE p.target_id = $1 AND p.active AND p.brand IS NOT NULL
     )
     SELECT 'comp_only' AS direction,
            co.bkey,
            count(cp.eff)::int              AS product_count,
            round(min(cp.eff))              AS min_price,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY cp.eff)) AS median_price,
            round(max(cp.eff))              AS max_price
     FROM comp_only co
     LEFT JOIN comp_prices cp ON cp.bkey = co.bkey
     GROUP BY co.bkey

     UNION ALL

     SELECT 'mt_only' AS direction,
            mo.bkey,
            count(mp.eff)::int              AS product_count,
            round(min(mp.eff))              AS min_price,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mp.eff)) AS median_price,
            round(max(mp.eff))              AS max_price
     FROM mt_only mo
     LEFT JOIN mt_prices mp ON mp.bkey = mo.bkey
     GROUP BY mo.bkey
     ORDER BY direction, product_count DESC`,
    [opts.competitor],
  );

  const compOnly: unknown[] = [];
  const mtOnly: unknown[] = [];
  for (const r of rows as {
    direction: string;
    bkey: string;
    product_count: number;
    min_price: number | null;
    median_price: number | null;
    max_price: number | null;
  }[]) {
    const item = {
      brand: r.bkey,
      productCount: r.product_count,
      priceRange: { min: r.min_price, median: r.median_price, max: r.max_price },
    };
    if (r.direction === "comp_only") compOnly.push(item);
    else mtOnly.push(item);
  }

  return {
    note: "Active products only. Brand keys normalized (CASIO% collapsed). comp_only = brands the competitor carries that MY:TIME doesn't; mt_only = brands MY:TIME carries that the competitor doesn't.",
    competitor: opts.competitor,
    currency: "MKD",
    comp_only: compOnly,
    mt_only: mtOnly,
  };
}

// ---------------------------------------------------------------------------
// E5: promo_calendar
// ---------------------------------------------------------------------------

/**
 * promo_calendar — detects discount waves per target from `prices` history.
 *
 * Algorithm (heuristic, documented):
 *   1. For each day, count distinct active products where discount_pct > 0 (on sale).
 *   2. Wave threshold T = max(5, 10% of that target's current active catalog size).
 *   3. A wave starts on the first day count ≥ T. It continues through days with
 *      count ≥ T, allowing gaps of ≤ 2 days (the scraper may miss a day). It ends
 *      when count stays < T for 3+ consecutive days.
 *   4. A wave with no end is "ongoing". Peak breadth = max daily count in the wave.
 *   5. avgDepthPct = average of (avg discount_pct per day) over the wave days with
 *      count ≥ T.
 */
export async function promoCalendar(pool: Pool, opts: { competitor?: string; days?: number }) {
  const days = Math.min(opts.days ?? 90, 180);
  const params: unknown[] = [days];
  let filter = "";
  if (opts.competitor) {
    params.push(opts.competitor);
    filter = `AND p.target_id = $${params.length}`;
  }

  // Daily discounted-product counts + avg depth per target
  const { rows: dailyRows } = await pool.query(
    `WITH active_catalog AS (
       SELECT p.target_id, count(*)::int AS catalog_size
       FROM products p
       WHERE p.active ${filter.replace(/p\.target_id/, "p.target_id")}
       GROUP BY p.target_id
     ),
     daily AS (
       SELECT p.target_id, pr.captured_date,
              count(*) FILTER (WHERE pr.discount_pct > 0)::int     AS on_sale_count,
              avg(pr.discount_pct) FILTER (WHERE pr.discount_pct > 0) AS avg_depth_pct
       FROM prices pr
       JOIN products p ON p.id = pr.product_id
       WHERE pr.captured_date >= current_date - $1::int
         AND p.active ${filter}
       GROUP BY p.target_id, pr.captured_date
     )
     SELECT d.target_id, d.captured_date::text AS day,
            d.on_sale_count, d.avg_depth_pct::float8,
            ac.catalog_size
     FROM daily d
     JOIN active_catalog ac ON ac.target_id = d.target_id
     ORDER BY d.target_id, d.captured_date`,
    params,
  );

  // Group by target and detect waves
  type DayRow = {
    target_id: string;
    day: string;
    on_sale_count: number;
    avg_depth_pct: number | null;
    catalog_size: number;
  };

  const byTarget = new Map<string, DayRow[]>();
  for (const r of dailyRows as DayRow[]) {
    const arr = byTarget.get(r.target_id) ?? [];
    arr.push(r);
    byTarget.set(r.target_id, arr);
  }

  const results = [...byTarget.entries()].map(([targetId, dayRows]) => {
    const threshold = Math.max(5, Math.round((dayRows[0]?.catalog_size ?? 0) * 0.1));

    // Detect waves: days ≥ threshold with ≤ 2-day gaps allowed
    const waves: {
      startDate: string;
      endDate: string | null;
      peakBreadth: number;
      avgDepthPct: number | null;
    }[] = [];

    let waveStart: string | null = null;
    let peakBreadth = 0;
    let depthSum = 0;
    let depthDays = 0;
    let lastAboveDate: string | null = null;

    for (const row of dayRows) {
      const isAbove = row.on_sale_count >= threshold;

      if (isAbove) {
        if (waveStart === null) {
          // New wave
          waveStart = row.day;
          peakBreadth = 0;
          depthSum = 0;
          depthDays = 0;
        }
        lastAboveDate = row.day;
        peakBreadth = Math.max(peakBreadth, row.on_sale_count);
        if (row.avg_depth_pct != null) {
          depthSum += row.avg_depth_pct;
          depthDays++;
        }
      } else if (waveStart !== null) {
        // Check if we've exceeded the gap tolerance (2 days)
        const lastDate = new Date(lastAboveDate!);
        const currDate = new Date(row.day);
        const gapDays = Math.round((currDate.getTime() - lastDate.getTime()) / 86400000);
        if (gapDays > 2) {
          // Wave ended
          waves.push({
            startDate: waveStart,
            endDate: lastAboveDate,
            peakBreadth,
            avgDepthPct: depthDays > 0 ? Math.round((depthSum / depthDays) * 10) / 10 : null,
          });
          waveStart = null;
          lastAboveDate = null;
        }
        // else: within gap tolerance, continue
      }
    }

    // Close any ongoing wave
    if (waveStart !== null) {
      waves.push({
        startDate: waveStart,
        endDate: null, // ongoing
        peakBreadth,
        avgDepthPct: depthDays > 0 ? Math.round((depthSum / depthDays) * 10) / 10 : null,
      });
    }

    return {
      targetId,
      catalogSize: dayRows[0]?.catalog_size ?? 0,
      waveThreshold: threshold,
      waves,
    };
  });

  return {
    note: `Wave = ≥max(5, 10% of active catalog) products on sale per day, with gaps of ≤2 days allowed (to handle scraper misses). endDate=null means the wave is ongoing. avgDepthPct = average of per-day avg discount_pct over wave days. Heuristic — tune threshold per business need.`,
    periodDays: days,
    results,
  };
}
