import { loadTargets, requireEnv } from "@mytime/shared";
import { seedDigestDefaults } from "./digests-db.js";
import { createDb } from "./index.js";
import { locations, socialAccounts, targets } from "./schema.js";

/**
 * Seed reference data from config/targets.json (idempotent — safe to re-run):
 *   - targets            (one row per entity)
 *   - locations          (one "online" location per web-enabled target; per-store seam)
 *   - social_accounts    (one row per present platform handle)
 *
 * Observation tables (inventory/prices/social_metrics) are populated by the
 * Phase 3 ingestion collectors, not here.
 *
 * Run from the repo root:  node db/dist/seed.js  (requires DATABASE_URL)
 */
export async function seed(targetsPath = "config/targets.json"): Promise<void> {
  const db = createDb(requireEnv("DATABASE_URL"));
  const all = loadTargets(targetsPath);

  for (const t of all) {
    await db
      .insert(targets)
      .values({
        id: t.id,
        name: t.name,
        legalEntity: t.legal_entity,
        isSelf: t.is_self,
        webEnabled: t.web.enabled,
        webUrl: t.web.url ?? null,
        webSource: t.web.source ?? null,
        monobrand: t.web.monobrand ?? false,
        perLocationStock: t.web.per_location_stock ?? null,
      })
      .onConflictDoUpdate({
        target: targets.id,
        set: {
          name: t.name,
          legalEntity: t.legal_entity,
          isSelf: t.is_self,
          webEnabled: t.web.enabled,
          webUrl: t.web.url ?? null,
          webSource: t.web.source ?? null,
          monobrand: t.web.monobrand ?? false,
          perLocationStock: t.web.per_location_stock ?? null,
          updatedAt: new Date(),
        },
      });

    if (t.web.enabled) {
      await db
        .insert(locations)
        .values({ targetId: t.id, code: "online", name: "Online store", isOnline: true })
        .onConflictDoNothing({ target: [locations.targetId, locations.code] });
    }

    for (const platform of ["instagram", "facebook", "tiktok"] as const) {
      const url = t.social[platform];
      if (!url) continue;
      await db
        .insert(socialAccounts)
        .values({ targetId: t.id, platform, url })
        .onConflictDoUpdate({
          target: [socialAccounts.targetId, socialAccounts.platform],
          set: { url },
        });
    }
  }

  await seedDigestDefaults(db);
  console.log(`✓ seeded ${all.length} targets (+ online locations, social accounts)`);
}

if (process.argv[1]?.endsWith("seed.js")) {
  seed().then(
    () => process.exit(0),
    (err) => {
      console.error("✗ seed failed:", err);
      process.exit(1);
    },
  );
}
