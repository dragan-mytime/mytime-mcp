# @mytime/db — schema & migrations

Drizzle-managed schema for the Supabase Postgres single source of truth.

## Commands (run from repo root)

```bash
pnpm db:generate   # diff schema.ts → new SQL migration in ./migrations
pnpm db:migrate    # apply pending migrations to DATABASE_URL
```

Requires `DATABASE_URL` in `.env` (Supabase, Frankfurt).

## Status

**Phase 0 (current):** wiring only. `src/schema.ts` defines the `targets` table to
prove the migration toolchain. No migration has been generated yet.

**Phase 2 (next):** full time-series schema and the ER diagram below.

## ER diagram

> Filled in Phase 2. Planned core tables and relationships:

```
targets ──┬──< products ──< inventory_snapshots   (product × location × date × stock_state)
          │                 └─< prices             (product × date × price)
          ├──< social_accounts ──< social_metrics  (account × date × metric)
          └──< registry_financials                 (stub; ground-truth seam)

authorized_users (email PK, role, active)          (auth whitelist — Phase 5)
```

Every observation table is date-stamped and indexed for time-series queries; the
ingestion writers are idempotent per `(entity, date)` so re-runs never duplicate rows.
