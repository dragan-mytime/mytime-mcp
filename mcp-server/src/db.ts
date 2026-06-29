import { createDb } from "@mytime/db";
import { createPool, optionalEnv, type Pool, requireEnv } from "@mytime/shared";

let pool: Pool | undefined;

/**
 * Read-mostly pool for the MCP tools. Prefers a least-privilege read-only role
 * (DATABASE_URL_READONLY); falls back to DATABASE_URL. Provisioned in Phase 5/6.
 */
export function readPool(): Pool {
  if (!pool) {
    pool = createPool(optionalEnv("DATABASE_URL_READONLY") ?? requireEnv("DATABASE_URL"));
  }
  return pool;
}

let dbClient: ReturnType<typeof createDb> | undefined;

/**
 * Drizzle client for tools that need ORM-level queries (e.g. dailyDigest).
 * Prefers DATABASE_URL_READONLY; falls back to DATABASE_URL.
 */
export function readDb(): ReturnType<typeof createDb> {
  if (!dbClient) {
    dbClient = createDb(optionalEnv("DATABASE_URL_READONLY") ?? requireEnv("DATABASE_URL"));
  }
  return dbClient;
}
