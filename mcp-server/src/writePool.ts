import { createPool, type Pool, requireEnv } from "@mytime/shared";

let p: Pool | undefined;

export function adminWritePool(): Pool {
  if (!p) p = createPool(requireEnv("DATABASE_URL"));
  return p;
}
