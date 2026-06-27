import pg from "pg";

/**
 * Create a Postgres connection pool. The Drizzle instance itself lives in
 * @mytime/db (which owns the schema); keeping the raw pool factory here avoids
 * a circular dependency between shared and db.
 *
 * Use a write-capable role for ingestion (DATABASE_URL) and a least-privilege
 * read-mostly role for the MCP server (DATABASE_URL_READONLY).
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    // Supabase requires TLS; node-postgres validates against the system CA store.
    ssl: { rejectUnauthorized: true },
  });
}

export type Pool = pg.Pool;
