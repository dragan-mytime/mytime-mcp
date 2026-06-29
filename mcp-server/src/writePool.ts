import { createDb } from "@mytime/db";
import { createPool, type Pool, requireEnv } from "@mytime/shared";

let p: Pool | undefined;

export function adminWritePool(): Pool {
  if (!p) p = createPool(requireEnv("DATABASE_URL"));
  return p;
}

let wdb: ReturnType<typeof createDb> | undefined;

export function adminWriteDb(): ReturnType<typeof createDb> {
  if (!wdb) wdb = createDb(requireEnv("DATABASE_URL"));
  return wdb;
}
