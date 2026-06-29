import type { LiveSnapshot } from "../types.js";

export interface SiteVerifier {
  /** target ids this verifier handles. */
  targets: string[];
  /** Extract ground truth from a fetched page (html primary, markdown optional). */
  extract(html: string, markdown: string, url: string): LiveSnapshot;
}
