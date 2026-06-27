/** Authorization roles, enforced per MCP tool in middleware (brief §7). */
export type Role = "admin" | "analyst" | "viewer";

/** Normalized stock state for an inventory observation. */
export type StockState = "in_stock" | "low_stock" | "out_of_stock" | "unknown";

/** How a web-trackable target is collected. */
export type WebSource = "apify" | "firecrawl" | "xml_feed";
