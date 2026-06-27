import type { ToolDefinition } from "./_tool.js";

/**
 * The tool registry. Phase 4 registers the initial tools, each declaring its
 * required role:
 *   - get_inventory_velocity  (analyst)  depletion → estimated units sold
 *   - compare_market_share    (analyst)  MY:TIME vs competitor
 *   - social_benchmark        (analyst)  engagement/reach, brand vs competitor
 *   - price_assortment        (viewer)   price & range tracking
 *
 * Depletion-derived numbers are ESTIMATES and must be labeled as such in tool
 * outputs (brief §7). Competitor social is public metrics only.
 */
export const tools: ToolDefinition[] = [];
