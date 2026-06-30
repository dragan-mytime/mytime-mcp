import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/** Authorization roles, enforced per MCP tool in middleware (brief §7). */
export const roleEnum = pgEnum("role", ["admin", "analyst", "viewer"]);

/** How a web-trackable target is collected. */
export const webSourceEnum = pgEnum("web_source", ["apify", "firecrawl", "xml_feed"]);

/** Normalized stock state for an inventory observation. */
export const stockStatusEnum = pgEnum("stock_status", [
  "in_stock",
  "low_stock",
  "out_of_stock",
  "unknown",
]);

/**
 * Basis of an observed/derived stock quantity (Phase 1 modeling convention):
 *   exact   — a real measured count is available (B-Watch, Bozinovski, Saat&Saat)
 *   assumed — no count exposed; depletion assumes 1 unit per availability event
 *   unknown — only an in/out status is known at observation time
 */
export const qtyBasisEnum = pgEnum("qty_basis", ["exact", "assumed", "unknown"]);

/** Social platforms tracked (own brand via official APIs; competitors public only). */
export const socialPlatformEnum = pgEnum("social_platform", ["instagram", "facebook", "tiktok"]);

// ─────────────────────────────────────────────────────────────────────────────
// Core: targets (mirrors config/targets.json) + locations seam
// ─────────────────────────────────────────────────────────────────────────────

export const targets = pgTable("targets", {
  id: text("id").primaryKey(), // stable slug, matches targets.json id
  name: text("name").notNull(),
  legalEntity: text("legal_entity").notNull(),
  isSelf: boolean("is_self").notNull().default(false),
  webEnabled: boolean("web_enabled").notNull().default(false),
  webUrl: text("web_url"),
  webSource: webSourceEnum("web_source"),
  monobrand: boolean("monobrand").notNull().default(false),
  perLocationStock: boolean("per_location_stock"), // null until profiled; false = no per-store stock
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  platform: text("platform"), // web.platform e.g. "woocommerce"
  social: jsonb("social"), // { instagram?, facebook?, tiktok? }
  registry: jsonb("registry"), // { central_registry_id }
  webLocations: jsonb("web_locations"), // web.locations array
});

/**
 * Per-target locations. Today every web target has a single "online" location;
 * this table is the seam so per-physical-store stock can be added later with no
 * schema change — inventory_snapshots already keys on location.
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    code: text("code").notNull(), // "online" or a store code
    name: text("name").notNull(), // "Online store" or "Skopje – City Mall"
    isOnline: boolean("is_online").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("locations_target_code_uq").on(t.targetId, t.code)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Catalog: products
// ─────────────────────────────────────────────────────────────────────────────

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(), // site SKU / slug / product id
    name: text("name").notNull(),
    brand: text("brand"), // null for monobrand / unknown
    modelRef: text("model_ref"), // manufacturer reference, e.g. "PXW453-04" — cross-competitor match key
    category: text("category"),
    productType: text("product_type"), // watches | jewelry | accessories | eyewear | other | null
    gender: text("gender"), // normalized in ingestion: mens | womens | unisex | kids | null
    collection: text("collection"),
    url: text("url"),
    imageUrl: text("image_url"),
    // Optional, site-dependent watch/jewelry attributes (material, movement, case_size, …).
    // JSONB keeps these modular — a new attribute never needs a migration.
    attributes: jsonb("attributes"),
    currency: text("currency").notNull().default("MKD"),
    firstSeenDate: date("first_seen_date").notNull(),
    lastSeenDate: date("last_seen_date").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_target_external_uq").on(t.targetId, t.externalId),
    index("products_target_idx").on(t.targetId),
    index("products_model_ref_idx").on(t.modelRef), // cross-competitor head-to-head matching
    index("products_product_type_idx").on(t.productType),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Time-series: inventory_snapshots (product × location × date × stock state)
// ─────────────────────────────────────────────────────────────────────────────

export const inventorySnapshots = pgTable(
  "inventory_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    capturedDate: date("captured_date").notNull(),
    stockStatus: stockStatusEnum("stock_status").notNull(),
    stockQuantity: integer("stock_quantity"), // exact count when available, else null
    qtyBasis: qtyBasisEnum("qty_basis").notNull().default("unknown"),
    // Per-store availability (legacy parity: "locations" + "locations count").
    // 0 / null where a site exposes no per-physical-store stock (the current reality).
    locationsCount: integer("locations_count").notNull().default(0),
    inStockLocations: jsonb("in_stock_locations"), // list of location identifiers in stock
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency: one snapshot per product+location+day. Re-runs upsert, never duplicate.
    uniqueIndex("inv_product_location_date_uq").on(t.productId, t.locationId, t.capturedDate),
    index("inv_captured_date_idx").on(t.capturedDate),
    index("inv_product_date_idx").on(t.productId, t.capturedDate),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Time-series: prices (kept separate so price changes are tracked independently)
// ─────────────────────────────────────────────────────────────────────────────

export const prices = pgTable(
  "prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    capturedDate: date("captured_date").notNull(),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(), // regular / list price
    salePrice: numeric("sale_price", { precision: 12, scale: 2 }), // discounted price when on sale
    discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }), // absolute money off (price - sale_price)
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }), // (price-sale)/price*100, when on sale
    currency: text("currency").notNull().default("MKD"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("prices_product_date_uq").on(t.productId, t.capturedDate),
    index("prices_product_date_idx").on(t.productId, t.capturedDate),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Social: accounts + metrics (account × date × metric, long format for modularity)
// ─────────────────────────────────────────────────────────────────────────────

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    platform: socialPlatformEnum("platform").notNull(),
    handle: text("handle"),
    url: text("url").notNull(),
    externalId: text("external_id"), // platform account id, when known
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("social_accounts_target_platform_uq").on(t.targetId, t.platform)],
);

/**
 * Long/narrow metrics so a new metric is a new row, not a new column (modularity).
 * e.g. metric = 'followers' | 'following' | 'posts' | 'avg_engagement_rate' | ...
 * Competitor accounts carry public metrics only; never private insights.
 */
export const socialMetrics = pgTable(
  "social_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    capturedDate: date("captured_date").notNull(),
    metric: text("metric").notNull(),
    value: numeric("value", { precision: 20, scale: 4 }).notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_metrics_account_date_metric_uq").on(
      t.socialAccountId,
      t.capturedDate,
      t.metric,
    ),
    index("social_metrics_captured_date_idx").on(t.capturedDate),
    index("social_metrics_account_date_idx").on(t.socialAccountId, t.capturedDate),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Ad intelligence: ad_observations (Facebook/Instagram Ad Library per-target)
// ─────────────────────────────────────────────────────────────────────────────

export const adObservations = pgTable(
  "ad_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    adArchiveId: text("ad_archive_id").notNull(),
    capturedDate: date("captured_date").notNull(),
    startedRunningDate: date("started_running_date"),
    daysRunning: integer("days_running"),
    platforms: text("platforms").array(),
    ctaType: text("cta_type"),
    linkUrl: text("link_url"),
    adTitle: text("ad_title"),
    adBody: text("ad_body"),
    mediaType: text("media_type"),
    mediaUrl: text("media_url"),
    snapshotUrl: text("snapshot_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_observations_target_ad_date_uq").on(t.targetId, t.adArchiveId, t.capturedDate),
    index("ad_observations_target_date_idx").on(t.targetId, t.capturedDate),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// App settings: global key-value configuration store
// ─────────────────────────────────────────────────────────────────────────────

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuth persistence: DCR clients + refresh tokens survive process restarts so the
// MCP connector doesn't force a re-auth on every deploy. Access tokens are
// stateless JWTs (stable MCP_JWT_SECRET) and already survive; only these two
// long-lived pieces lived in memory. Auth codes / pending logins stay in memory
// (<=10 min, only relevant mid-handshake).
// ─────────────────────────────────────────────────────────────────────────────

export const oauthClients = pgTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  client: jsonb("client").notNull(), // full OAuthClientInformationFull
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(), // sha256(refresh_token) — never the raw token
  email: text("email").notNull(),
  role: text("role").notNull(),
  clientId: text("client_id").notNull(),
  scopes: jsonb("scopes").notNull(), // string[]
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Digest Studio: authorable prompts + schedulers (Subsystem E)
// ─────────────────────────────────────────────────────────────────────────────

export const digestPrompts = pgTable("digest_prompts", {
  id: text("id").primaryKey(), // slug, e.g. "daily-default"
  name: text("name").notNull(),
  body: text("body").notNull(), // full Gemini instruction; the prompt owns the language
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const digestSchedules = pgTable("digest_schedules", {
  id: text("id").primaryKey(), // slug
  name: text("name").notNull(),
  promptId: text("prompt_id")
    .notNull()
    .references(() => digestPrompts.id, { onDelete: "restrict" }),
  sendAt: text("send_at").notNull(), // "HH:MM", interpreted in Europe/Skopje
  recipients: jsonb("recipients"), // string[] | null → falls back to digest_recipients
  enabled: boolean("enabled").notNull().default(true),
  lastRunOn: date("last_run_on"), // local date the schedule last fired (idempotency)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth whitelist (managed in the Supabase table editor — brief §7)
// ─────────────────────────────────────────────────────────────────────────────

export const authorizedUsers = pgTable("authorized_users", {
  email: text("email").primaryKey(), // store lowercased
  role: roleEnum("role").notNull().default("viewer"),
  active: boolean("active").notNull().default(true),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation seam: registry_financials (stub — no scraper yet, brief §4)
// ─────────────────────────────────────────────────────────────────────────────

export const registryFinancials = pgTable(
  "registry_financials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetId: text("target_id")
      .notNull()
      .references(() => targets.id, { onDelete: "cascade" }),
    fiscalYear: integer("fiscal_year").notNull(),
    revenue: numeric("revenue", { precision: 16, scale: 2 }),
    netProfit: numeric("net_profit", { precision: 16, scale: 2 }),
    employees: integer("employees"),
    currency: text("currency").notNull().default("MKD"),
    source: text("source"), // e.g. 'central_registry'
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("registry_target_year_uq").on(t.targetId, t.fiscalYear)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Observability: ingestion_runs (per-source run log for the run summary, brief §7)
// ─────────────────────────────────────────────────────────────────────────────

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runDate: date("run_date").notNull(),
    collector: text("collector").notNull(),
    targetId: text("target_id").references(() => targets.id, { onDelete: "set null" }),
    status: text("status").notNull(), // 'success' | 'failed' | 'partial'
    rowsWritten: integer("rows_written").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("ingestion_runs_date_idx").on(t.runDate),
    index("ingestion_runs_collector_date_idx").on(t.collector, t.runDate),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Relations (for the Phase 4 query layer)
// ─────────────────────────────────────────────────────────────────────────────

export const targetsRelations = relations(targets, ({ many }) => ({
  locations: many(locations),
  products: many(products),
  socialAccounts: many(socialAccounts),
  registryFinancials: many(registryFinancials),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  target: one(targets, { fields: [locations.targetId], references: [targets.id] }),
  inventorySnapshots: many(inventorySnapshots),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  target: one(targets, { fields: [products.targetId], references: [targets.id] }),
  inventorySnapshots: many(inventorySnapshots),
  prices: many(prices),
}));

export const inventorySnapshotsRelations = relations(inventorySnapshots, ({ one }) => ({
  product: one(products, { fields: [inventorySnapshots.productId], references: [products.id] }),
  location: one(locations, { fields: [inventorySnapshots.locationId], references: [locations.id] }),
}));

export const pricesRelations = relations(prices, ({ one }) => ({
  product: one(products, { fields: [prices.productId], references: [products.id] }),
}));

export const socialAccountsRelations = relations(socialAccounts, ({ one, many }) => ({
  target: one(targets, { fields: [socialAccounts.targetId], references: [targets.id] }),
  metrics: many(socialMetrics),
}));

export const socialMetricsRelations = relations(socialMetrics, ({ one }) => ({
  account: one(socialAccounts, {
    fields: [socialMetrics.socialAccountId],
    references: [socialAccounts.id],
  }),
}));

export const registryFinancialsRelations = relations(registryFinancials, ({ one }) => ({
  target: one(targets, { fields: [registryFinancials.targetId], references: [targets.id] }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Inferred row types
// ─────────────────────────────────────────────────────────────────────────────

export type TargetRow = typeof targets.$inferSelect;
export type NewTargetRow = typeof targets.$inferInsert;
export type LocationRow = typeof locations.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type InventorySnapshotRow = typeof inventorySnapshots.$inferSelect;
export type PriceRow = typeof prices.$inferSelect;
export type SocialAccountRow = typeof socialAccounts.$inferSelect;
export type SocialMetricRow = typeof socialMetrics.$inferSelect;
export type AuthorizedUserRow = typeof authorizedUsers.$inferSelect;
export type RegistryFinancialRow = typeof registryFinancials.$inferSelect;
export type IngestionRunRow = typeof ingestionRuns.$inferSelect;
export type AdObservationRow = typeof adObservations.$inferSelect;
export type AppSettingRow = typeof appSettings.$inferSelect;
export type DigestPromptRow = typeof digestPrompts.$inferSelect;
export type NewDigestPromptRow = typeof digestPrompts.$inferInsert;
export type DigestScheduleRow = typeof digestSchedules.$inferSelect;
export type NewDigestScheduleRow = typeof digestSchedules.$inferInsert;
