import type { StockState } from "@mytime/shared";

/** Normalized snapshot of what a live product page actually shows. */
export interface LiveSnapshot {
  externalId?: string | null;
  name?: string | null;
  brand?: string | null;
  modelRef?: string | null;
  category?: string | null;
  price?: number | null; // regular / list price displayed
  salePrice?: number | null; // displayed sale price when on promo, else null
  stockStatus?: StockState | null;
  attributes?: Record<string, unknown> | null;
}

/** The DB-side view of a product+latest price+stock, for comparison. */
export interface DbProductRow {
  productId: string;
  targetId: string;
  externalId: string;
  url: string | null;
  name: string;
  brand: string | null;
  modelRef: string | null;
  category: string | null;
  price: number | null;
  salePrice: number | null;
  discountPct: number | null;
  stockStatus: StockState | null;
}

export type Severity = "error" | "review";

export interface FieldMismatch {
  field: string;
  dbValue: unknown;
  liveValue: unknown;
  severity: Severity;
  note?: string;
}

/** One product's validation outcome. */
export interface ProductResult {
  targetId: string;
  url: string;
  externalId: string;
  dataMismatches: FieldMismatch[]; // verifier vs DB
  driftFlags: FieldMismatch[]; // verifier vs LLM
}
