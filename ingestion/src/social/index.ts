import type { SocialCollector } from "./_social.js";
import { facebookCollector } from "./facebook.js";
import { instagramCollector } from "./instagram.js";
import { tiktokCollector } from "./tiktok.js";

/**
 * Competitor social collectors (public metrics only, via Apify). Own-brand
 * social uses the official Meta/Google APIs (Step F), not these.
 */
export const socialCollectors: SocialCollector[] = [
  instagramCollector,
  facebookCollector,
  tiktokCollector,
];
