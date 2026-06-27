# @mytime/db — schema & migrations

Drizzle-managed schema for the Supabase Postgres single source of truth.

## Commands (run from repo root)

```bash
pnpm db:generate   # diff schema.ts → new SQL migration in ./migrations
pnpm db:migrate    # apply pending migrations to DATABASE_URL
pnpm db:seed       # upsert targets/locations/social_accounts from config/targets.json
```

`db:migrate` and `db:seed` require `DATABASE_URL` in `.env` (Supabase, Frankfurt).
`db:generate` is offline.

## Status

**Phase 2 (current):** full time-series schema. Migration `0000_*` defines 10
tables, 5 enums, FKs with `on delete cascade`, and unique indexes that enforce
per-day idempotency. Run `pnpm db:migrate` against Supabase to apply.

## ER diagram

```
                         ┌────────────────────┐
                         │      targets       │  (mirrors config/targets.json)
                         │  id (PK, slug)     │
                         └─────────┬──────────┘
        ┌──────────────┬──────────┼─────────────┬───────────────────┐
        │              │          │             │                   │
        ▼              ▼          ▼             ▼                   ▼
 ┌────────────┐ ┌────────────┐ ┌──────────────────┐ ┌────────────────────┐ ┌──────────────────────┐
 │ locations  │ │  products  │ │ social_accounts  │ │ registry_financials│ │ ingestion_runs       │
 │ id (PK)    │ │ id (PK)    │ │ id (PK)          │ │ (stub seam)        │ │ (observability)      │
 │ target_id  │ │ target_id  │ │ target_id        │ │ target_id          │ │ target_id (set null) │
 │ code       │ │ external_id│ │ platform         │ │ fiscal_year        │ └──────────────────────┘
 │ (uq w/ tgt)│ │ (uq w/ tgt)│ │ (uq w/ tgt)      │ │ (uq w/ tgt)        │
 └─────┬──────┘ └─────┬──────┘ └────────┬─────────┘ └────────────────────┘
       │              │                 │
       │     ┌────────┴────────┐        ▼
       │     │                 │  ┌──────────────────┐
       ▼     ▼                 ▼  │ social_metrics   │  account × date × metric (long format)
 ┌─────────────────────┐  ┌────────┐ │ (uq: acct+date+metric)
 │ inventory_snapshots │  │ prices │ └──────────────────┘
 │ product × location  │  │ product│
 │   × date            │  │  × date│
 │ uq: prod+loc+date   │  │ uq:    │
 │ stock_status        │  │ prod+  │
 │ stock_quantity (n)  │  │ date   │
 │ qty_basis           │  └────────┘
 └─────────────────────┘

 authorized_users (email PK, role, active)   — standalone auth whitelist (Phase 5)
```

### Tables

| Table | Grain | Idempotency key | Notes |
|---|---|---|---|
| `targets` | entity | `id` | mirrors `config/targets.json` |
| `locations` | target × store | `(target_id, code)` | one `online` row per web target; per-store seam |
| `products` | target × SKU | `(target_id, external_id)` | `first_seen`/`last_seen` drive assortment |
| `inventory_snapshots` | product × location × day | `(product_id, location_id, captured_date)` | `stock_status`, exact `stock_quantity` (nullable), `qty_basis` |
| `prices` | product × day | `(product_id, captured_date)` | tracked independently of stock |
| `social_accounts` | target × platform | `(target_id, platform)` | public competitors / official own brand |
| `social_metrics` | account × day × metric | `(social_account_id, captured_date, metric)` | long format → new metric = new row, no migration |
| `authorized_users` | user | `email` (PK) | managed in the Supabase table editor |
| `registry_financials` | target × fiscal year | `(target_id, fiscal_year)` | stub; no scraper yet |
| `ingestion_runs` | run | — | per-source run log for the run summary |

### Enums

`role` · `web_source` · `stock_status` · `qty_basis (exact|assumed|unknown)` · `social_platform`

### Depletion data model

`inventory_snapshots.qty_basis` carries the Phase 1 convention: `exact` when a
real count is recorded (B-Watch, Bozinovski, Saat&Saat), otherwise the engine
**assumes 1 unit** per `in_stock → out_of_stock` transition or SKU disappearance.
Tool outputs label assumed figures as estimates; exact and assumed numbers are
never silently mixed.

Every observation table is date-stamped and indexed for time-series queries; the
ingestion writers upsert on the unique keys above, so re-runs never duplicate rows.
