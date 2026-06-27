import { createPool } from "@mytime/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type { NewTargetRow, TargetRow } from "./schema.js";
export * as schema from "./schema.js";
export * from "./writers.js";

/**
 * Build a typed Drizzle client over a Postgres pool.
 * @param connectionString DATABASE_URL (ingestion, write) or DATABASE_URL_READONLY (MCP, read).
 */
export function createDb(connectionString: string) {
  const pool = createPool(connectionString);
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
