import { z } from "zod";
import {
  compareMarketShare,
  inventoryVelocity,
  priceAssortment,
  socialBenchmark,
} from "../analytics.js";
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
];
