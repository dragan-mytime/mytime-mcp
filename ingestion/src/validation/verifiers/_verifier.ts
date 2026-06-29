import type { LiveSnapshot } from "../types.js";

export interface SiteVerifier {
  /** target ids this verifier handles. */
  targets: string[];
  /** Extract ground truth from a fetched page (html primary, markdown optional). */
  extract(html: string, markdown: string, url: string): LiveSnapshot;
}

import { webJsonLdVerifier } from "./web-jsonld.js";

export const verifiers: SiteVerifier[] = [webJsonLdVerifier];

export function verifierFor(targetId: string): SiteVerifier | undefined {
  return verifiers.find((v) => v.targets.includes(targetId));
}
