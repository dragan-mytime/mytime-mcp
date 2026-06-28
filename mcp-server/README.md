# @mytime/mcp-server — MCP server core

Remote MCP server (Streamable HTTP, MCP TypeScript SDK) exposing MY:TIME's
competitive intelligence. Each tool reads **only** from Postgres.

## Run locally

```bash
pnpm build
node mcp-server/dist/server.js     # listens on MCP_PORT (default 8080)
# health: curl http://127.0.0.1:8080/health
# MCP endpoint: POST http://127.0.0.1:8080/mcp
```

Connect with the **MCP Inspector** (`npx @modelcontextprotocol/inspector`) →
Streamable HTTP → `http://127.0.0.1:8080/mcp`, or any MCP client. Phase 4 is
unauthenticated (local); Phase 5 adds OAuth 2.1 + the per-tool role gate.

## Tools

| Tool | Role | What it returns |
|---|---|---|
| `get_inventory_velocity` | analyst | depletion → estimated units sold, by product/competitor/period |
| `compare_market_share` | analyst | MY:TIME vs a competitor — assortment, price, velocity, shared brands |
| `social_benchmark` | analyst | latest public social metrics per competitor/platform |
| `price_assortment` | viewer | price ranges + SKU/on-sale counts, by competitor/brand |

Depletion figures are **estimates** (labeled in every result). `qty_basis`
distinguishes exact-count sites from assumed-1 sites. Velocity needs ≥2 days of
snapshots (the scheduler accrues them).

## Add a new tool — 3-step recipe

1. **Data** — make sure the data exists: a new source = new collector module +
   new table (see `ingestion/src/sources/README.md`); for a new view over
   existing data, just add a query function in `mcp-server/src/analytics.ts`.
2. **Query** — add the analytics function (parameterized, returns plain JSON).
3. **Tool + role** — append an `McpToolDef` to `mcp-server/src/tools/index.ts`
   (`name`, `description`, `requiredRole`, `inputSchema` (zod), `run`). It is
   auto-registered on the server and the Phase 5 middleware enforces its role.

No other tool or source is touched.
