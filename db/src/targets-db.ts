import { type Target, loadTargets, targetsFileSchema } from "@mytime/shared";
import { eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { targets } from "./schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure row → Target mapper (exported so tests can exercise it without a DB)
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetDbRow {
  id: string;
  name: string;
  legalEntity: string;
  isSelf: boolean;
  webEnabled: boolean;
  webUrl: string | null;
  webSource: string | null;
  monobrand: boolean;
  perLocationStock: boolean | null;
  platform: unknown;
  webLocations: unknown;
  social: unknown;
  registry: unknown;
}

export function rowToTarget(row: TargetDbRow): Target {
  return {
    id: row.id,
    name: row.name,
    legal_entity: row.legalEntity,
    is_self: row.isSelf,
    web: {
      enabled: row.webEnabled,
      url: row.webUrl ?? undefined,
      source: (row.webSource as Target["web"]["source"]) ?? undefined,
      monobrand: row.monobrand,
      per_location_stock: row.perLocationStock ?? undefined,
      locations: Array.isArray(row.webLocations) ? (row.webLocations as string[]) : [],
      platform: (row.platform as Target["web"]["platform"]) ?? undefined,
    },
    social:
      row.social != null && typeof row.social === "object" ? (row.social as Target["social"]) : {},
    registry:
      row.registry != null && typeof row.registry === "object"
        ? (row.registry as Target["registry"])
        : { central_registry_id: null },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// seedTargetsFromJson
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load targets from a JSON file and upsert them into the `targets` table.
 * Returns the number of targets processed.
 */
export async function seedTargetsFromJson(
  db: Db,
  jsonPath = "config/targets.json",
): Promise<number> {
  const items = loadTargets(jsonPath);

  for (const t of items) {
    const row = {
      name: t.name,
      legalEntity: t.legal_entity,
      isSelf: t.is_self,
      webEnabled: t.web.enabled,
      webUrl: t.web.url ?? null,
      webSource: (t.web.source as "apify" | "firecrawl" | "xml_feed" | null | undefined) ?? null,
      monobrand: t.web.monobrand ?? false,
      perLocationStock: t.web.per_location_stock ?? null,
      platform: t.web.platform ?? null,
      webLocations: (t.web.locations ?? []) as object,
      social: (t.social ?? {}) as object,
      registry: (t.registry ?? { central_registry_id: null }) as object,
      active: t.web.enabled,
      updatedAt: new Date(),
    };

    await db
      .insert(targets)
      .values({ id: t.id, ...row })
      .onConflictDoUpdate({ target: targets.id, set: row });
  }

  return items.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadTargetsFromDb
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load active targets from the DB and return them validated against targetsFileSchema.
 * Inactive targets (admin "Active" toggle off) are excluded so daily runs skip them (A2).
 * Throws if validation fails.
 */
export async function loadTargetsFromDb(db: Db): Promise<Target[]> {
  const rows = await db.select().from(targets).where(eq(targets.active, true));

  const mapped = rows.map((row) => rowToTarget(row as unknown as TargetDbRow));

  const parsed = targetsFileSchema.safeParse({ targets: mapped });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`loadTargetsFromDb: schema validation failed:\n${details}`);
  }

  return parsed.data.targets;
}
