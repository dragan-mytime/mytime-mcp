export interface HealthStatus {
  ok: boolean;
  service: string;
  time: string;
}

/** Liveness payload for the `/health` endpoint (wired to HTTP in Phase 4/6). */
export function health(): HealthStatus {
  return { ok: true, service: "mytime-mcp", time: new Date().toISOString() };
}
