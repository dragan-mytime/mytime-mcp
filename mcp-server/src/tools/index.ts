import { dailyDigest } from "@mytime/db";
import { z } from "zod";
import {
  assortmentGaps,
  compareMarketShare,
  compareSkus,
  competitorAds,
  dataHealth,
  inventoryVelocity,
  priceAssortment,
  priceHistory,
  promoCalendar,
  socialBenchmark,
  socialContent,
  socialPosts,
} from "../analytics.js";
import { listAuthorizedUsers } from "../auth/authorized-users.js";
import { readDb } from "../db.js";
import type { McpToolDef } from "./_tool.js";

/**
 * The four Phase 4 tools. Each reads only from Postgres and declares its
 * required role. Depletion-derived figures are labeled as estimates in output.
 */
export const tools: McpToolDef[] = [
  {
    name: "get_inventory_velocity",
    title: "Inventory velocity (estimated units sold)",
    description:
      "Estimate units sold from day-over-day inventory depletion, by product and competitor over a period. Figures are ESTIMATES, not measured sales (see disclaimer in the result).",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z
        .string()
        .optional()
        .describe("target id, e.g. 'b-watch'; omit for all competitors"),
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe("lookback window in days (default 30)"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("max products to return (default 20)"),
    },
    run: (pool, a) =>
      inventoryVelocity(pool, a as { competitor?: string; days?: number; limit?: number }),
  },
  {
    name: "compare_market_share",
    title: "Compare market share (MY:TIME vs competitor)",
    description:
      "Compare MY:TIME against a competitor on assortment (SKU/brand counts), price range, estimated velocity, and shared-brand overlap.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().describe("competitor target id, e.g. 'b-watch'"),
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe("velocity window in days (default 30)"),
    },
    run: (pool, a) => compareMarketShare(pool, a as { competitor: string; days?: number }),
  },
  {
    name: "compare_skus",
    title: "SKU overlap & price comparison (MY:TIME vs a competitor)",
    description:
      "Match MY:TIME products to a competitor on the manufacturer reference and compare current prices, per matched SKU. Casio matches the Timeless/Vintage lines (not G-Shock). Returns match counts (who is cheaper) + the line items with both prices and the % difference.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z
        .string()
        .optional()
        .describe("competitor target id, e.g. 'saat-saat'; omit for all competitors"),
    },
    run: (pool, a) => compareSkus(pool, a as { competitor?: string }),
  },
  {
    name: "social_benchmark",
    title: "Social benchmark (brand vs competitors)",
    description:
      "Latest public social metrics per competitor and platform (followers, engagement, cadence). Competitor metrics are public-only.",
    requiredRole: "analyst",
    inputSchema: {
      platform: z
        .enum(["instagram", "facebook", "tiktok"])
        .optional()
        .describe("filter to one platform"),
      metric: z.string().optional().describe("metric name (default 'followers')"),
    },
    run: (pool, a) => socialBenchmark(pool, a as { platform?: string; metric?: string }),
  },
  {
    name: "social_posts",
    title: "Social posts & engagement (per competitor)",
    description:
      "Recent posts per competitor with caption, media, engagement (likes/comments/shares/views) and estimated reach (labeled by source: views/estimate/measured). Includes posting cadence + top posts by engagement.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().optional().describe("target id, e.g. 'b-watch'; omit for all"),
      platform: z
        .enum(["instagram", "facebook", "tiktok"])
        .optional()
        .describe("filter to one platform"),
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe("lookback window (default 30)"),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("top posts per competitor (default 20)"),
    },
    run: (pool, a) =>
      socialPosts(
        pool,
        a as { competitor?: string; platform?: string; days?: number; limit?: number },
      ),
  },
  {
    name: "social_content",
    title: "Social content analysis (hashtags, posting heatmap, brand mentions)",
    description:
      "Mines stored social post captions per competitor: top-10 hashtags by count + avg engagement, posting time heatmap (day-of-week × hour in Europe/Skopje) with best slots, and brand mentions (active product brands matched as whole words in captions). Use to discover trending topics, optimal posting times, and competitor brand promotion patterns.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().optional().describe("target id, e.g. 'b-watch'; omit for all"),
      platform: z
        .enum(["instagram", "facebook", "tiktok"])
        .optional()
        .describe("filter to one platform"),
      days: z
        .number()
        .int()
        .positive()
        .max(90)
        .optional()
        .describe("lookback window in days (default 30, max 90)"),
    },
    run: (pool, a) =>
      socialContent(pool, a as { competitor?: string; platform?: string; days?: number }),
  },
  {
    name: "price_assortment",
    title: "Price & assortment tracking",
    description:
      "Price ranges (min/median/avg/max), SKU counts, and on-sale counts per competitor, optionally filtered by brand.",
    requiredRole: "viewer",
    inputSchema: {
      competitor: z.string().optional().describe("target id; omit for all"),
      brand: z.string().optional().describe("brand name (case-insensitive)"),
    },
    run: (pool, a) => priceAssortment(pool, a as { competitor?: string; brand?: string }),
  },
  {
    name: "competitor_ads",
    title: "Competitor ad intelligence (Meta Ad Library)",
    description:
      "Currently-running Meta ads per competitor: active-ad count, ad longevity (days running = the performance proxy; spend/impressions are NOT public for these ads), newest creatives, CTAs, and top landing pages.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().optional().describe("target id, e.g. 'saat-saat'; omit for all"),
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe("lookback window (default 30)"),
    },
    run: (pool, a) => competitorAds(pool, a as { competitor?: string; days?: number }),
  },
  {
    name: "list_authorized_users",
    title: "List authorized users (admin)",
    description:
      "List the MCP allowlist (email, role, active). Admin only. Entries are managed in the Supabase table editor.",
    requiredRole: "admin",
    inputSchema: {},
    run: (pool) => listAuthorizedUsers(pool),
  },
  {
    name: "daily_digest",
    title: "Daily competitor digest (day-over-day changes)",
    description:
      "What competitors did since the last snapshot: new/ended sales campaigns, new/stopped ads + long-runners, follower moves, new products/stockouts/price moves. Each competitor is compared on its OWN latest vs prior capture dates and carries a dataFreshness stamp (stale = no successful scrape in 48h). Returns structured data — narrate it as a briefing (the user may ask in English or Macedonian). Figures are estimates.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z
        .string()
        .optional()
        .describe("target id, e.g. 'b-watch'; omit for all competitors"),
      days: z
        .number()
        .int()
        .positive()
        .max(31)
        .optional()
        .describe(
          "comparison window: prior = each target's latest capture ≥ this many days older than its latest (default 1 = day-over-day; 7 = weekly)",
        ),
    },
    run: (_pool, a) => dailyDigest(readDb(), a as { competitor?: string; days?: number }),
  },
  {
    name: "data_health",
    title: "Ingestion data health (per target × collector)",
    description:
      "Freshness of the scraped data: per target and collector, the last successful run (time + rows written), last failure (time + error), and consecutive failures since the last success. Social + ad collectors run once for all targets and appear as '(all targets)'. Use this before trusting zeros in other tools.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().optional().describe("target id, e.g. 'b-watch'; omit for all targets"),
    },
    run: (pool, a) => dataHealth(pool, a as { competitor?: string }),
  },
  {
    name: "price_history",
    title: "Price & discount history (time series per product)",
    description:
      "Full price time series (date, effective price, discountPct) per product, plus a summary (current/min/max price, biggest single-day drop). At least one filter is required. Effective price = COALESCE(sale_price, price). Source: daily web scrapes.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().optional().describe("target id, e.g. 'b-watch'; filter by competitor"),
      brand: z.string().optional().describe("brand name (case-insensitive exact match)"),
      modelRef: z
        .string()
        .optional()
        .describe("manufacturer reference (case-insensitive exact match, e.g. 'A168WA-1W')"),
      q: z.string().optional().describe("product name ILIKE search (partial match)"),
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe("lookback window in days (default 90, max 365)"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("max products to return (default 20, max 100)"),
    },
    run: (pool, a) =>
      priceHistory(
        pool,
        a as {
          competitor?: string;
          brand?: string;
          modelRef?: string;
          q?: string;
          days?: number;
          limit?: number;
        },
      ),
  },
  {
    name: "assortment_gaps",
    title: "Assortment gaps (brands each side carries exclusively)",
    description:
      "Brands a competitor carries that MY:TIME doesn't (comp_only) and vice versa (mt_only), with per-brand active product count and min/median/max effective price. Uses the same brand normalization as compare_skus (CASIO% collapsed). Active products only.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z.string().describe("competitor target id, e.g. 'b-watch'"),
    },
    run: (pool, a) => assortmentGaps(pool, a as { competitor: string }),
  },
  {
    name: "promo_calendar",
    title: "Promo calendar (discount-wave detection per competitor)",
    description:
      "Detects promotional waves per competitor from price history. A wave = ≥max(5, 10% of active catalog) products on sale per day, with gaps of ≤2 days allowed. Returns wave start/end dates, peak breadth (max daily discounted count), and avg discount depth. Useful for planning MY:TIME campaigns around competitor sale seasons.",
    requiredRole: "analyst",
    inputSchema: {
      competitor: z
        .string()
        .optional()
        .describe("target id, e.g. 'bozinovski'; omit for all competitors"),
      days: z
        .number()
        .int()
        .positive()
        .max(180)
        .optional()
        .describe("lookback window in days (default 90, max 180)"),
    },
    run: (pool, a) => promoCalendar(pool, a as { competitor?: string; days?: number }),
  },
];
