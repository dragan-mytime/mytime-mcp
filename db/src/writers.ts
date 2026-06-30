import type {
  AdObservation,
  ProductObservation,
  SocialMetricValue,
  SocialPlatform,
  SocialPostObservation,
  Target,
} from "@mytime/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import {
  adObservations,
  ingestionRuns,
  inventorySnapshots,
  locations,
  prices,
  products,
  socialAccounts,
  socialMetrics,
  socialPosts,
  targets,
} from "./schema.js";

const num = (v?: number | null): string | null => (v == null ? null : String(v));
const CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
 * Persist product observations idempotently for (target, runDate) using batched
 * multi-row upserts (one round-trip per ~500 rows, not per row — essential over
 * a network connection). Re-running the same day updates rows in place via the
 * unique keys, never duplicating. Runs in a single transaction.
 * Returns the number of products written.
 */
export async function writeObservations(
  db: Db,
  target: Target,
  locationId: string,
  runDate: string,
  source: string,
  obs: ProductObservation[],
): Promise<number> {
  // Dedupe within a run (last wins) so ON CONFLICT can't hit a row twice.
  const byId = new Map<string, ProductObservation>();
  for (const o of obs) byId.set(o.externalId, o);
  const items = [...byId.values()];
  if (items.length === 0) return 0;

  await db.transaction(async (tx) => {
    // 1) products — upsert and capture id per externalId.
    const idByExternal = new Map<string, string>();
    const productValues = items.map((o) => ({
      targetId: target.id,
      externalId: o.externalId,
      name: o.name,
      brand: o.brand ?? null,
      modelRef: o.modelRef ?? null,
      category: o.category ?? null,
      productType: o.productType ?? null,
      gender: o.gender ?? null,
      collection: o.collection ?? null,
      attributes: o.attributes ?? null,
      url: o.url ?? null,
      imageUrl: o.imageUrl ?? null,
      currency: o.currency,
      firstSeenDate: runDate,
      lastSeenDate: runDate,
    }));
    for (const c of chunk(productValues, CHUNK)) {
      const ret = await tx
        .insert(products)
        .values(c)
        .onConflictDoUpdate({
          target: [products.targetId, products.externalId],
          set: {
            name: sql`excluded.name`,
            brand: sql`excluded.brand`,
            modelRef: sql`excluded.model_ref`,
            category: sql`excluded.category`,
            productType: sql`excluded.product_type`,
            gender: sql`excluded.gender`,
            collection: sql`excluded.collection`,
            attributes: sql`excluded.attributes`,
            url: sql`excluded.url`,
            imageUrl: sql`excluded.image_url`,
            currency: sql`excluded.currency`,
            lastSeenDate: sql`excluded.last_seen_date`,
            active: sql`true`,
          },
        })
        .returning({ id: products.id, externalId: products.externalId });
      for (const r of ret) idByExternal.set(r.externalId, r.id);
    }

    // 2) inventory snapshots
    const snapValues = items.flatMap((o) => {
      const productId = idByExternal.get(o.externalId);
      return productId
        ? [
            {
              productId,
              locationId,
              capturedDate: runDate,
              stockStatus: o.stockStatus,
              stockQuantity: o.stockQuantity ?? null,
              qtyBasis: o.qtyBasis,
              locationsCount: o.locationsCount ?? 0,
              inStockLocations: o.inStockLocations ?? null,
              source,
            },
          ]
        : [];
    });
    for (const c of chunk(snapValues, CHUNK)) {
      await tx
        .insert(inventorySnapshots)
        .values(c)
        .onConflictDoUpdate({
          target: [
            inventorySnapshots.productId,
            inventorySnapshots.locationId,
            inventorySnapshots.capturedDate,
          ],
          set: {
            stockStatus: sql`excluded.stock_status`,
            stockQuantity: sql`excluded.stock_quantity`,
            qtyBasis: sql`excluded.qty_basis`,
            locationsCount: sql`excluded.locations_count`,
            inStockLocations: sql`excluded.in_stock_locations`,
            source: sql`excluded.source`,
          },
        });
    }

    // 3) prices
    const priceValues = items.flatMap((o) => {
      const productId = idByExternal.get(o.externalId);
      return productId
        ? [
            {
              productId,
              capturedDate: runDate,
              price: String(o.price),
              salePrice: num(o.salePrice),
              discountAmount: num(o.discountAmount),
              discountPct: num(o.discountPct),
              currency: o.currency,
              source,
            },
          ]
        : [];
    });
    for (const c of chunk(priceValues, CHUNK)) {
      await tx
        .insert(prices)
        .values(c)
        .onConflictDoUpdate({
          target: [prices.productId, prices.capturedDate],
          set: {
            price: sql`excluded.price`,
            salePrice: sql`excluded.sale_price`,
            discountAmount: sql`excluded.discount_amount`,
            discountPct: sql`excluded.discount_pct`,
            currency: sql`excluded.currency`,
            source: sql`excluded.source`,
          },
        });
    }
  });

  return items.length;
}

/** Upsert a social account and return its id. */
export async function ensureSocialAccount(
  db: Db,
  targetId: string,
  platform: SocialPlatform,
  url: string,
  handle?: string | null,
): Promise<string> {
  await db
    .insert(socialAccounts)
    .values({ targetId, platform, url, handle: handle ?? null })
    .onConflictDoUpdate({
      target: [socialAccounts.targetId, socialAccounts.platform],
      set: { url, handle: handle ?? null },
    });
  const [row] = await db
    .select({ id: socialAccounts.id })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.targetId, targetId), eq(socialAccounts.platform, platform)));
  if (!row) throw new Error(`failed to ensure social account ${targetId}/${platform}`);
  return row.id;
}

/** Idempotently upsert social metrics (account × date × metric). Returns count written. */
export async function writeSocialMetrics(
  db: Db,
  socialAccountId: string,
  runDate: string,
  metrics: SocialMetricValue[],
  source: string,
): Promise<number> {
  if (metrics.length === 0) return 0;
  const values = metrics.map((m) => ({
    socialAccountId,
    capturedDate: runDate,
    metric: m.metric,
    value: String(m.value),
    source,
  }));
  await db
    .insert(socialMetrics)
    .values(values)
    .onConflictDoUpdate({
      target: [socialMetrics.socialAccountId, socialMetrics.capturedDate, socialMetrics.metric],
      set: { value: sql`excluded.value`, source: sql`excluded.source` },
    });
  return metrics.length;
}

/** Idempotently upsert social posts (account × external post id). Returns count written. */
export async function writeSocialPosts(
  db: Db,
  socialAccountId: string,
  runDate: string,
  posts: SocialPostObservation[],
): Promise<number> {
  if (posts.length === 0) return 0;
  // Dedupe within a run (last wins) so ON CONFLICT can't hit a row twice in one statement.
  const byId = new Map<string, SocialPostObservation>();
  for (const p of posts) byId.set(p.externalPostId, p);
  const deduped = [...byId.values()];
  const values = deduped.map((p) => ({
    socialAccountId,
    externalPostId: p.externalPostId,
    capturedDate: runDate,
    postedAt: p.postedAt ? new Date(p.postedAt) : null,
    postType: p.postType ?? null,
    caption: p.caption ?? null,
    permalink: p.permalink ?? null,
    mediaUrl: p.mediaUrl ?? null,
    mediaUrls: p.mediaUrls ?? null,
    likes: p.likes ?? null,
    comments: p.comments ?? null,
    shares: p.shares ?? null,
    views: p.views ?? null,
    engagement: p.engagement ?? null,
    estimatedReach: p.estimatedReach ?? null,
    reachSource: p.reachSource ?? null,
  }));
  for (const c of chunk(values, CHUNK)) {
    await db
      .insert(socialPosts)
      .values(c)
      .onConflictDoUpdate({
        target: [socialPosts.socialAccountId, socialPosts.externalPostId],
        set: {
          capturedDate: sql`excluded.captured_date`,
          postedAt: sql`excluded.posted_at`,
          postType: sql`excluded.post_type`,
          caption: sql`excluded.caption`,
          permalink: sql`excluded.permalink`,
          mediaUrl: sql`excluded.media_url`,
          mediaUrls: sql`excluded.media_urls`,
          likes: sql`excluded.likes`,
          comments: sql`excluded.comments`,
          shares: sql`excluded.shares`,
          views: sql`excluded.views`,
          engagement: sql`excluded.engagement`,
          estimatedReach: sql`excluded.estimated_reach`,
          reachSource: sql`excluded.reach_source`,
        },
      });
  }
  return deduped.length;
}

/** Idempotently upsert ad observations (target × adArchiveId × date). Returns count written. */
export async function writeAdObservations(
  db: Db,
  targetId: string,
  runDate: string,
  ads: AdObservation[],
): Promise<number> {
  if (ads.length === 0) return 0;
  const values = ads.map((a) => ({
    targetId,
    adArchiveId: a.adArchiveId,
    capturedDate: runDate,
    startedRunningDate: a.startedRunningDate,
    daysRunning: a.daysRunning,
    platforms: a.platforms,
    ctaType: a.ctaType,
    linkUrl: a.linkUrl,
    adTitle: a.adTitle,
    adBody: a.adBody,
    mediaType: a.mediaType,
    mediaUrl: a.mediaUrl,
    snapshotUrl: a.snapshotUrl,
  }));
  await db
    .insert(adObservations)
    .values(values)
    .onConflictDoUpdate({
      target: [adObservations.targetId, adObservations.adArchiveId, adObservations.capturedDate],
      set: {
        daysRunning: sql`excluded.days_running`,
        adBody: sql`excluded.ad_body`,
        linkUrl: sql`excluded.link_url`,
        mediaUrl: sql`excluded.media_url`,
      },
    });
  return ads.length;
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
