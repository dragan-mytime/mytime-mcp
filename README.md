# MY:TIME — Competitive Intelligence Platform

Ingestion pipeline + remote **MCP server** over a Supabase Postgres single source
of truth. Crawls competitor e-commerce sites and infers demand from inventory
depletion, tracks social performance, and exposes everything to Claude, Power BI,
and the team through one MCP endpoint.

> **Honesty note:** depletion-derived sales are **estimates**, labeled as such in
> all outputs. Competitor social = **public metrics only**. MY:TIME's own data
> comes from official APIs and the Adform product feed, never guessed.

## Architecture

```
SOURCES      competitor e-commerce sites + social platforms
COLLECTION   Apify + FireCrawl + official social APIs + MY:TIME XML feed
INGESTION    Node/TS pipeline — route, normalize, dedupe, date-stamp (modular per source)
STORAGE      Supabase Postgres (Frankfurt) — single source of truth
MCP SERVER   remote, Streamable HTTP, https://mcp.my.mk  ← the hub
CONSUMERS    Claude · Power BI / dashboards · internal team
```

## Workspace layout

| Package | Purpose |
|---|---|
| `shared/` (`@mytime/shared`) | Types, env loader (fail-fast), logger, DB pool factory, `targets.json` loader |
| `db/` (`@mytime/db`) | Drizzle schema + migrations + ER diagram |
| `ingestion/` (`@mytime/ingestion`) | One bolt-on collector module per source + routing/scheduler |
| `mcp-server/` (`@mytime/mcp-server`) | MCP tools (role-tagged), auth middleware, health |
| `config/` | `targets.json` (+ JSON Schema) — the only place targets are defined |

## Stack

Node 20+ · TypeScript (ESM, NodeNext) · pnpm workspaces · Drizzle ORM · Biome
(lint + format) · pino logging · zod validation · Supabase Postgres.

## Getting started

```bash
corepack enable && pnpm install      # pnpm 11.x
cp .env.example .env                 # fill in credentials (gitignored)
pnpm build                           # build all packages
pnpm validate:targets                # validate config/targets.json
pnpm lint                            # Biome
```

Every runtime variable is documented in [.env.example](.env.example); missing
required vars fail fast naming the variable.

## Adding a new data source (modularity contract)

A new source is **new module + new table + new MCP tool**, with no edits to
existing sources. See [ingestion/src/sources/README.md](ingestion/src/sources/README.md).

## Build phases

- [x] **Phase 0 — Scaffold** (current): monorepo, tooling, `targets.json` schema, env.
- [ ] **Phase 1 — Site profiling & crawler selection** → `crawler-plan.md`
- [ ] **Phase 2 — Database schema** (full time-series model + ER diagram)
- [ ] **Phase 3 — Ingestion pipeline** (per-source collectors, scheduler)
- [ ] **Phase 4 — Demand inference + MCP server core** (4 tools)
- [ ] **Phase 5 — OAuth 2.1 + two-layer authorization**
- [ ] **Phase 6 — Deploy to Hetzner** (Caddy, TLS, daily ingestion)
