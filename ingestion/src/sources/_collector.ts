import type { Target } from "@mytime/shared";

/** Context handed to every collector for a single run. */
export interface CollectorContext {
  /** The target this invocation is collecting for. */
  target: Target;
  /** UTC date (YYYY-MM-DD) every observation in this run is stamped with. */
  runDate: string;
}

/**
 * A normalized observation ready for the routing/transform layer. Phase 3
 * defines concrete row shapes (inventory, price, social) per writer.
 */
export type NormalizedRow = Record<string, unknown>;

/**
 * The single interface every data source implements. This is the contract that
 * makes sources bolt-on: adding a source = a new file implementing Collector
 * + a new table + a new MCP tool. No existing source is ever edited.
 */
export interface Collector {
  /** Unique, stable id, e.g. "mytime-xml-feed", "apify-bwatch-web". */
  readonly id: string;
  /** Human label for logs/run summary. */
  readonly label: string;
  /** Whether this collector runs for a given target (filter from config). */
  appliesTo(target: Target): boolean;
  /** Fetch + normalize. MUST be idempotent for a given (target, runDate). */
  collect(ctx: CollectorContext): Promise<NormalizedRow[]>;
}
