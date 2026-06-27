import type { ProductObservation, Target } from "@mytime/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import {
  ingestionRuns,
  inventorySnapshots,
  locations,
  prices,
  products,
  targets,
} from "./schema.js";

const num = (v?: number | null): string | null => (v == null ? null : String(v));

/** Upsert a target (from config) and ensure its "online" location exists. Returns the location id. */
export async function ensureTargetAndLocation(db: Db, t: Target): Promise<string> {
  const row = {
    name: t.name,
    legalEntity: t.legal_entity,
    isSelf: t.is_self,
    webEnabled: t.web.enabled,
    webUrl: t.web.url ?? null,
    webSource: t.web.source ?? null,
    monobrand: t.web.monobrand ?? false,
    perLocationStock: t.web.per_location_stock ?? null,
  };
  await db
    .insert(targets)
    .values({ id: t.id, ...row })
    .onConflictDoUpdate({ target: targets.id, set: { ...row, updatedAt: new Date() } });

  await db
    .insert(locations)
    .values({ targetId: t.id, code: "online", name: "Online store", isOnline: true })
    .onConflictDoNothing();

  const [loc] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.targetId, t.id), eq(locations.code, "online")));
  if (!loc) throw new Error(`failed to ensure online location for ${t.id}`);
  return loc.id;
}

/**
 * Persist a batch of product observations idempotently for (target, runDate).
 * Upserts products, inventory_snapshots, and prices on their unique keys, so
 * re-running the same day updates rows in place instead of duplicating them.
 * Runs in a single transaction. Returns the number of products written.
 */
export async function writeObservations(
  db: Db,
  target: Target,
  locationId: string,
  runDate: string,
  source: string,
  obs: ProductObservation[],
): Promise<number> {
  let n = 0;
  await db.transaction(async (tx) => {
    for (const o of obs) {
      const productFields = {
        name: o.name,
        brand: o.brand ?? null,
        modelRef: o.modelRef ?? null,
        category: o.category ?? null,
        gender: o.gender ?? null,
        collection: o.collection ?? null,
        attributes: o.attributes ?? null,
        url: o.url ?? null,
        imageUrl: o.imageUrl ?? null,
        currency: o.currency,
        lastSeenDate: runDate,
      };
      const [p] = await tx
        .insert(products)
        .values({
          targetId: target.id,
          externalId: o.externalId,
          firstSeenDate: runDate,
          ...productFields,
        })
        .onConflictDoUpdate({
          target: [products.targetId, products.externalId],
          set: { ...productFields, active: true },
        })
        .returning({ id: products.id });
      if (!p) throw new Error(`product upsert returned no id for ${target.id}/${o.externalId}`);
      const productId = p.id;

      const stockFields = {
        stockStatus: o.stockStatus,
        stockQuantity: o.stockQuantity ?? null,
        qtyBasis: o.qtyBasis,
        locationsCount: o.locationsCount ?? 0,
        inStockLocations: o.inStockLocations ?? null,
        source,
      };
      await tx
        .insert(inventorySnapshots)
        .values({ productId, locationId, capturedDate: runDate, ...stockFields })
        .onConflictDoUpdate({
          target: [
            inventorySnapshots.productId,
            inventorySnapshots.locationId,
            inventorySnapshots.capturedDate,
          ],
          set: stockFields,
        });

      const priceFields = {
        price: String(o.price),
        salePrice: num(o.salePrice),
        discountAmount: num(o.discountAmount),
        discountPct: num(o.discountPct),
        currency: o.currency,
        source,
      };
      await tx
        .insert(prices)
        .values({ productId, capturedDate: runDate, ...priceFields })
        .onConflictDoUpdate({
          target: [prices.productId, prices.capturedDate],
          set: priceFields,
        });
      n++;
    }
  });
  return n;
}

/** Append a row to the ingestion run log (observability / run summary). */
export async function recordRun(
  db: Db,
  r: {
    runDate: string;
    collector: string;
    targetId?: string | null;
    status: "success" | "failed" | "partial";
    rowsWritten: number;
    error?: string | null;
    startedAt: Date;
  },
): Promise<void> {
  await db.insert(ingestionRuns).values({
    runDate: r.runDate,
    collector: r.collector,
    targetId: r.targetId ?? null,
    status: r.status,
    rowsWritten: r.rowsWritten,
    error: r.error ?? null,
    startedAt: r.startedAt,
    finishedAt: new Date(),
  });
}
