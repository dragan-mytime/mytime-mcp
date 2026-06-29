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
