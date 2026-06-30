/** Authorization roles, enforced per MCP tool in middleware (brief §7). */
export type Role = "admin" | "analyst" | "viewer";

/** Normalized stock state for an inventory observation. */
export type StockState = "in_stock" | "low_stock" | "out_of_stock" | "unknown";

/** How a web-trackable target is collected. */
export type WebSource = "apify" | "firecrawl" | "xml_feed";

/** Social platforms tracked. */
export type SocialPlatform = "instagram" | "facebook" | "tiktok";

/** One public social metric observed for an account on a given day. */
export interface SocialMetricValue {
  metric: string; // e.g. "followers" | "following" | "posts" | "avg_post_engagement"
  value: number;
}

/** One public social post observed for an account. */
export interface SocialPostObservation {
  externalPostId: string;
  postedAt: string | null; // ISO timestamp
  postType: string | null; // image | video | carousel | reel
  caption: string | null;
  permalink: string | null;
  mediaUrl: string | null;
  mediaUrls: string[] | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  engagement: number | null;
  estimatedReach: number | null;
  reachSource: string | null; // views | estimate | measured
}
