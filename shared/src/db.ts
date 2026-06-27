import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * TLS config for Supabase Postgres. Supabase's pooler presents a cert signed by
 * its own CA (not in the system trust store), so plain verification fails.
 *   - DATABASE_CA_CERT=<path>     → pin the Supabase CA and fully verify (best).
 *   - DATABASE_SSL_NO_VERIFY=true → encrypt without verifying the chain.
 *   - otherwise                   → verify against the system CA store.
 */
function sslConfig(): pg.PoolConfig["ssl"] {
  const caPath = process.env.DATABASE_CA_CERT;
  if (caPath) return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  if (process.env.DATABASE_SSL_NO_VERIFY === "true") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/**
 * Create a Postgres connection pool. The Drizzle instance itself lives in
 * @mytime/db (which owns the schema); keeping the raw pool factory here avoids
 * a circular dependency between shared and db.
 *
 * Use a write-capable role for ingestion (DATABASE_URL) and a least-privilege
 * read-mostly role for the MCP server (DATABASE_URL_READONLY).
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, ssl: sslConfig() });
}

export type Pool = pg.Pool;
