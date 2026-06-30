import type { StockState } from "./types.js";

/** Basis of a stock quantity: measured count, assumed-1, or status-only. */
export type QtyBasis = "exact" | "assumed" | "unknown";

/**
 * One product observed on one site during one run — the normalized contract
 * every product collector emits and the writer persists (splitting it across
 * products / inventory_snapshots / prices). Mirrors the legacy scraper's flat
 * row so the datasets stay comparable.
 */
export interface ProductObservation {
  externalId: string; // site SKU / id / slug
  name: string;
  brand?: string | null;
  modelRef?: string | null; // manufacturer reference — cross-competitor match key
  category?: string | null;
  productType?: string | null; // watches | jewelry | accessories | eyewear | other | null
  gender?: string | null; // normalized: mens | womens | unisex | kids | null
  collection?: string | null;
  attributes?: Record<string, unknown> | null;
  url?: string | null;
  imageUrl?: string | null;
  currency: string;

  // price
  price: number; // regular / list price
  salePrice?: number | null; // discounted price when on sale
  discountAmount?: number | null; // price - salePrice
  discountPct?: number | null; // (price - salePrice) / price * 100

  // stock
  stockStatus: StockState;
  stockQuantity?: number | null; // exact count when available
  qtyBasis: QtyBasis;
  locationsCount?: number; // # physical locations in stock (legacy "locations count")
  inStockLocations?: string[] | null; // legacy "locations"
}
