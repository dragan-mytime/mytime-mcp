import type { ProductObservation } from "@mytime/shared";
import type { LiveSnapshot } from "../types.js";

export interface SiteVerifier {
  /** target ids this verifier handles. */
  targets: string[];
  /** Extract ground truth from a fetched page (html primary, markdown optional). */
  extract(html: string, markdown: string, url: string): LiveSnapshot;
}

export function toSnapshot(o: ProductObservation | null): LiveSnapshot {
  if (!o) return {};
  return {
    name: o.name ?? null,
    brand: o.brand ?? null,
    modelRef: o.modelRef ?? null,
    category: o.category ?? null,
    price: o.price ?? null,
    salePrice: o.salePrice ?? null,
    stockStatus: o.stockStatus ?? null,
  };
}

import { hronometarVerifier } from "./hronometar.js";
import { webJsonLdVerifier } from "./web-jsonld.js";
import { woocommerceVerifier } from "./woocommerce.js";

export const verifiers: SiteVerifier[] = [
  webJsonLdVerifier,
  woocommerceVerifier,
  hronometarVerifier,
];

export function verifierFor(targetId: string): SiteVerifier | undefined {
  return verifiers.find((v) => v.targets.includes(targetId));
}
