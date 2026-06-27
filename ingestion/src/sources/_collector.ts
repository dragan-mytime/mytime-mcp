import type { ProductObservation, Target } from "@mytime/shared";

/** Context handed to every collector for a single run. */
export interface CollectorContext {
  /** The target this invocation is collecting for. */
  target: Target;
  /** UTC date (YYYY-MM-DD) every observation in this run is stamped with. */
  runDate: string;
}

/**
 * The interface every product (web/feed) source implements. This is the
 * contract that makes sources bolt-on: adding a source = a new file
 * implementing ProductCollector + (its table already exists) + a new MCP tool.
 * No existing source is ever edited; the runner iterates the registry with
 * per-source failure isolation.
 *
 * (Social collectors arrive in steps E/F with their own observation shape.)
 */
export interface ProductCollector {
  /** Unique, stable id, e.g. "mytime-xml-feed", "woocommerce-store-api". */
  readonly id: string;
  /** Human label for logs / run summary. */
  readonly label: string;
  /** Whether this collector runs for a given target (routed by config). */
  appliesTo(target: Target): boolean;
  /** Fetch + normalize. MUST be idempotent for a given (target, runDate). */
  collect(ctx: CollectorContext): Promise<ProductObservation[]>;
}
