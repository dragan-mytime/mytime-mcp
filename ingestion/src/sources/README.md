# Adding a data source — the 3-step recipe

Modularity is the headline requirement: a new source must **not** touch any
existing source's code.

1. **Module** — add `sources/<your-source>.ts` exporting a `Collector`
   (`id`, `label`, `appliesTo(target)`, `collect(ctx) → NormalizedRow[]`).
   Keep `collect()` idempotent for a given `(target, runDate)`.
2. **Table** — add the destination table to `@mytime/db` `schema.ts` and
   generate a migration (`pnpm db:generate`). Write rows via the routing layer.
3. **Tool + role** — expose the data with a new MCP tool in `@mytime/mcp-server`,
   declaring its `requiredRole` so the auth middleware enforces it.

Then register the collector: add one import + one entry to `sources/index.ts`.
The runner picks it up automatically with failure isolation.
