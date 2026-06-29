import { parseNop } from "../../sources/hronometar.js";
import type { LiveSnapshot } from "../types.js";
import { type SiteVerifier, toSnapshot } from "./_verifier.js";

export const hronometarVerifier: SiteVerifier = {
  targets: ["hronometar"],
  extract(html: string, _markdown: string, url: string): LiveSnapshot {
    return toSnapshot(parseNop(html, url));
  },
};
