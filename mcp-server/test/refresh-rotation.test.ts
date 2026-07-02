/**
 * D4 review fix: refresh-token rotation with a DB-backed reuse grace window
 * (OAuth 2.1 §4.3). A retry with the just-rotated (old) token within
 * ROTATION_GRACE_MS must resolve to the successor row instead of failing with
 * invalid_grant; outside the grace window it must fail and the stale row is
 * dropped. Runs against real Postgres semantics via PGlite.
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "@mytime/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { deleteRefreshByHash, getRefresh, putRefresh, rotateRefresh } from "../src/auth/store.js";

if (!process.env.MCP_JWT_SECRET) {
  process.env.MCP_JWT_SECRET = "test-secret-至少32chars-长aaaaaaaaaaaaaaaa";
}

let db: PGlite;
let pool: Pool;

const REC = {
  email: "x@mytime.mk",
  role: "admin" as const,
  clientId: "client-1",
  scopes: ["read"],
};

beforeAll(async () => {
  db = new PGlite();
  pool = { query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as Pool;
  // Mirrors migration 0005 + 0008 (superseded_* columns).
  await db.exec(`
    CREATE TABLE oauth_refresh_tokens (
      token_hash text PRIMARY KEY,
      email text NOT NULL,
      role text NOT NULL,
      client_id text NOT NULL,
      scopes jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      superseded_by_hash text,
      superseded_at timestamptz
    );
  `);
});

describe("refresh rotation grace window", () => {
  it("round-trips a plain (never-rotated) token", async () => {
    await putRefresh(pool, "tok-plain", REC);
    const rec = await getRefresh(pool, "tok-plain");
    expect(rec?.email).toBe("x@mytime.mk");
    expect(rec?.tokenHash).toBeTruthy();
  });

  it("retry with the old token within grace resolves to the successor row", async () => {
    await putRefresh(pool, "tok-a", REC);
    const recA = await getRefresh(pool, "tok-a");
    expect(recA).toBeDefined();
    if (!recA) return;

    await rotateRefresh(pool, recA.tokenHash, "tok-b", REC);

    // New token works and is the active row.
    const recB = await getRefresh(pool, "tok-b");
    expect(recB).toBeDefined();

    // Old token, retried immediately (within 60s grace) → resolves to tok-b's row.
    const retry = await getRefresh(pool, "tok-a");
    expect(retry).toBeDefined();
    expect(retry?.tokenHash).toBe(recB?.tokenHash);
    expect(retry?.email).toBe("x@mytime.mk");
  });

  it("reuse outside the grace window fails and drops the stale row", async () => {
    await putRefresh(pool, "tok-old", REC);
    const rec = await getRefresh(pool, "tok-old");
    expect(rec).toBeDefined();
    if (!rec) return;

    await rotateRefresh(pool, rec.tokenHash, "tok-new", REC);
    // Simulate the grace window elapsing.
    await db.query(
      "UPDATE oauth_refresh_tokens SET superseded_at = now() - interval '2 minutes' WHERE token_hash = $1",
      [rec.tokenHash],
    );

    const retry = await getRefresh(pool, "tok-old");
    expect(retry).toBeUndefined();

    // Stale row was deleted; the successor still works.
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM oauth_refresh_tokens WHERE token_hash = $1",
      [rec.tokenHash],
    );
    expect(rows[0]?.n).toBe("0");
    expect(await getRefresh(pool, "tok-new")).toBeDefined();
  });

  it("double rotation chains correctly (old → mid → new, all within grace)", async () => {
    await putRefresh(pool, "tok-1", REC);
    const rec1 = await getRefresh(pool, "tok-1");
    if (!rec1) throw new Error("rec1 missing");

    await rotateRefresh(pool, rec1.tokenHash, "tok-2", REC);
    const rec2 = await getRefresh(pool, "tok-2");
    if (!rec2) throw new Error("rec2 missing");

    await rotateRefresh(pool, rec2.tokenHash, "tok-3", REC);
    const rec3 = await getRefresh(pool, "tok-3");
    expect(rec3).toBeDefined();

    // The original token follows the chain to the newest active row.
    const viaOld = await getRefresh(pool, "tok-1");
    expect(viaOld?.tokenHash).toBe(rec3?.tokenHash);
  });

  it("rotation garbage-collects superseded rows past the grace window", async () => {
    await putRefresh(pool, "tok-gc-old", REC);
    const rec = await getRefresh(pool, "tok-gc-old");
    if (!rec) throw new Error("rec missing");
    await rotateRefresh(pool, rec.tokenHash, "tok-gc-mid", REC);
    await db.query(
      "UPDATE oauth_refresh_tokens SET superseded_at = now() - interval '10 minutes' WHERE token_hash = $1",
      [rec.tokenHash],
    );

    // Any later rotation sweeps expired superseded rows.
    await putRefresh(pool, "tok-gc-other", REC);
    const other = await getRefresh(pool, "tok-gc-other");
    if (!other) throw new Error("other missing");
    await rotateRefresh(pool, other.tokenHash, "tok-gc-other2", REC);

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM oauth_refresh_tokens WHERE token_hash = $1",
      [rec.tokenHash],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("deleteRefreshByHash removes the resolved row", async () => {
    await putRefresh(pool, "tok-del", REC);
    const rec = await getRefresh(pool, "tok-del");
    if (!rec) throw new Error("rec missing");
    await deleteRefreshByHash(pool, rec.tokenHash);
    expect(await getRefresh(pool, "tok-del")).toBeUndefined();
  });
});
