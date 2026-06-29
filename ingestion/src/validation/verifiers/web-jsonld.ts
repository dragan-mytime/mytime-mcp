import { parseOg, parseProduct } from "../../sources/web-jsonld.js";
import type { LiveSnapshot } from "../types.js";
import { type SiteVerifier, toSnapshot } from "./_verifier.js";

export const webJsonLdVerifier: SiteVerifier = {
  targets: ["saat-saat", "swarovski"],
  extract(html: string, _markdown: string, url: string): LiveSnapshot {
    return toSnapshot(parseProduct(html, url) ?? parseOg(html, url));
  },
};
