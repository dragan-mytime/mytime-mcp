// Pure decision logic for post-run product deactivation. No I/O.

/** Per-target tally of product-collector results within one ingestion run. */
export interface ProductCollectOutcome {
  succeeded: number;
  failed: number;
  /** Total product observations written by the target's successful collects. */
  rows: number;
}

export type DeactivationDecision = "deactivate" | "skip-failed" | "skip-zero-rows";

/**
 * Deactivate a target's missing products only when every product collector that
 * ran for it succeeded AND at least one product was observed. A successful
 * collect returning zero products (empty first page, silent scrape regression)
 * must never wipe the catalog's `active` flags — that would also generate large
 * fake disappearance-depletion units downstream.
 */
export function deactivationDecision(o: ProductCollectOutcome): DeactivationDecision {
  if (o.succeeded === 0 || o.failed > 0) return "skip-failed";
  if (o.rows === 0) return "skip-zero-rows";
  return "deactivate";
}
