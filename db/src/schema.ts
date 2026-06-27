import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0 SCAFFOLD — only `targets` is defined, to prove the Drizzle +
// migration wiring end to end. Phase 2 ("Database schema") adds the full
// time-series model:
//   products · inventory_snapshots (product × location × date × stock_state)
//   prices · social_accounts · social_metrics (account × date × metric)
//   authorized_users (email, role, active) · registry_financials (stub)
// with real foreign keys, constraints, and time-series indexes.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors config/targets.json — the entities we track. */
export const targets = pgTable("targets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  legalEntity: text("legal_entity").notNull(),
  isSelf: boolean("is_self").notNull().default(false),
  webEnabled: boolean("web_enabled").notNull().default(false),
  monobrand: boolean("monobrand").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TargetRow = typeof targets.$inferSelect;
export type NewTargetRow = typeof targets.$inferInsert;
