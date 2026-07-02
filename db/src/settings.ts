import { sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { appSettings } from "./schema.js";

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = await db.execute(sql`select value from app_settings where key = ${key}`);
  const rows = (r as unknown as { rows?: { value: unknown }[] }).rows ?? [];
  return rows.length ? (rows[0]!.value as T) : fallback;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value: value as object })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: value as object, updatedAt: new Date() },
    });
}

export async function allSettings(db: Db): Promise<Record<string, unknown>> {
  const r = await db.execute(sql`select key, value from app_settings`);
  const rows = (r as unknown as { rows?: { key: string; value: unknown }[] }).rows ?? [];
  return Object.fromEntries(rows.map((x) => [x.key, x.value]));
}

// ── Typed app-settings knobs (admin /settings page) ─────────────────────────

/** Typed view of the admin-editable knobs in app_settings, with safe defaults. */
export interface AppSettings {
  /** Min % price change to flag as a "price move" in digest + dashboard (default 5). */
  discountThresholdPct: number;
  /** Max ad observations requested per target per meta-ads run (default 50). */
  adResultsLimit: number;
  /**
   * Cap on products enumerated per target per web run. `null` = not set in the
   * admin panel — callers fall back to their WEB_MAX_PRODUCTS env, then 300.
   */
  webMaxProducts: number | null;
  /** Master switch for scheduled digest emails (default true). */
  digestEnabled: boolean;
}

/**
 * Coerce a stored jsonb value to a positive integer, or null if unset/invalid.
 * Exported so the admin settings form can distinguish stored-vs-unset without
 * duplicating the parse rules.
 */
export const parsePosInt = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/** Pure parse of raw app_settings rows → typed knobs. Unset/invalid → default. */
export function parseAppSettings(raw: Record<string, unknown>): AppSettings {
  return {
    discountThresholdPct: parsePosInt(raw.discount_threshold_pct) ?? 5,
    adResultsLimit: parsePosInt(raw.ad_results_limit) ?? 50,
    webMaxProducts: parsePosInt(raw.web_max_products),
    digestEnabled: typeof raw.digest_enabled === "boolean" ? raw.digest_enabled : true,
  };
}

/** All admin knobs in one query, typed, with defaults for unset/invalid values. */
export async function getAppSettings(db: Db): Promise<AppSettings> {
  return parseAppSettings(await allSettings(db));
}
