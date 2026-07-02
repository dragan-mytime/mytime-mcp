import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Pool, Role } from "@mytime/shared";

/**
 * OAuth state. Long-lived pieces — registered clients (DCR) and refresh tokens —
 * are persisted in Postgres so they survive process restarts (no re-auth on every
 * deploy). Short-lived pieces — pending Google round-trips and our auth codes —
 * stay in memory: they live ≤10 min and only matter during an active login.
 * Access tokens are stateless JWTs (stable MCP_JWT_SECRET) and need no store.
 */

export const randomToken = (): string => randomBytes(32).toString("base64url");

/** Refresh tokens are stored hashed so a DB dump never exposes a usable token. */
const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

// ── Registered clients (DCR) — persisted ─────────────────────────────────────
export async function putClient(pool: Pool, c: OAuthClientInformationFull): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_clients (client_id, client) VALUES ($1, $2)
     ON CONFLICT (client_id) DO UPDATE SET client = excluded.client`,
    [c.client_id, JSON.stringify(c)],
  );
}
export async function getClient(
  pool: Pool,
  id: string,
): Promise<OAuthClientInformationFull | undefined> {
  const { rows } = await pool.query<{ client: OAuthClientInformationFull }>(
    "SELECT client FROM oauth_clients WHERE client_id = $1",
    [id],
  );
  return rows[0]?.client;
}

// ── A12: in-memory map sweep + hard cap ──────────────────────────────────────
// Expired entries accumulate if a login is never completed (the caller never
// calls takePending/deleteCode). Sweep every 10 minutes and cap at 10k entries.

const MAP_CAP = 10_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Exported for testing: sweep both maps, evict expired entries, return counts.
 * `nowMs` defaults to Date.now() so tests can inject a fake clock.
 */
export function sweepMaps(nowMs = Date.now()): { pendingEvicted: number; codesEvicted: number } {
  let pendingEvicted = 0;
  for (const [k, v] of pending) {
    if (nowMs - v.createdAt >= 10 * 60_000) {
      pending.delete(k);
      pendingEvicted++;
    }
  }
  let codesEvicted = 0;
  const nowSec = nowMs / 1000;
  for (const [k, v] of codes) {
    if (v.expiresAt <= nowSec) {
      codes.delete(k);
      codesEvicted++;
    }
  }
  return { pendingEvicted, codesEvicted };
}

// Start the periodic sweep (unref'd so it doesn't keep the process alive).
const _sweepTimer = setInterval(() => sweepMaps(), SWEEP_INTERVAL_MS);
if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();

// ── Pending Google authorizations (keyed by the state we send to Google) ──────
export interface PendingAuth {
  clientId: string;
  clientRedirectUri: string;
  clientState?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  createdAt: number;
}
const pending = new Map<string, PendingAuth>();
export function putPending(state: string, p: PendingAuth): void {
  if (pending.size >= MAP_CAP) {
    console.warn("[auth/store] pending map at cap (%d); rejecting new entry", MAP_CAP);
    throw new Error("server_error: too many concurrent authorization requests");
  }
  pending.set(state, p);
}
export function takePending(state: string): PendingAuth | undefined {
  const p = pending.get(state);
  if (p) pending.delete(state);
  return p && Date.now() - p.createdAt < 10 * 60_000 ? p : undefined;
}

// ── Our authorization codes (exchanged at /token) ────────────────────────────
export interface AuthCode {
  email: string;
  role: Role;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // epoch seconds
}
const codes = new Map<string, AuthCode>();
export function putCode(code: string, c: AuthCode): void {
  if (codes.size >= MAP_CAP) {
    console.warn("[auth/store] codes map at cap (%d); rejecting new entry", MAP_CAP);
    throw new Error("server_error: too many pending authorization codes");
  }
  codes.set(code, c);
}
/** Peek (used twice: PKCE challenge lookup, then exchange). Returns if unexpired. */
export function getCode(code: string): AuthCode | undefined {
  const c = codes.get(code);
  return c && c.expiresAt > Date.now() / 1000 ? c : undefined;
}
export const deleteCode = (code: string): void => void codes.delete(code);

// ── Refresh tokens — persisted (hashed) ──────────────────────────────────────
export interface RefreshRec {
  email: string;
  role: Role;
  clientId: string;
  scopes: string[];
  createdAt: Date;
}
export async function putRefresh(
  pool: Pool,
  t: string,
  r: Omit<RefreshRec, "createdAt">,
): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, email, role, client_id, scopes)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token_hash) DO NOTHING`,
    [hashToken(t), r.email, r.role, r.clientId, JSON.stringify(r.scopes)],
  );
}
export async function getRefresh(pool: Pool, t: string): Promise<RefreshRec | undefined> {
  const { rows } = await pool.query<{
    email: string;
    role: Role;
    client_id: string;
    scopes: string[];
    created_at: Date;
  }>(
    "SELECT email, role, client_id, scopes, created_at FROM oauth_refresh_tokens WHERE token_hash = $1",
    [hashToken(t)],
  );
  const row = rows[0];
  return row
    ? {
        email: row.email,
        role: row.role,
        clientId: row.client_id,
        scopes: row.scopes,
        createdAt: row.created_at,
      }
    : undefined;
}
export async function deleteRefresh(pool: Pool, t: string): Promise<void> {
  await pool.query("DELETE FROM oauth_refresh_tokens WHERE token_hash = $1", [hashToken(t)]);
}

/** D4: replace old refresh token with a new one in a single transaction. */
export async function rotateRefresh(
  pool: Pool,
  oldToken: string,
  newToken: string,
  r: Omit<RefreshRec, "createdAt">,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM oauth_refresh_tokens WHERE token_hash = $1", [
      hashToken(oldToken),
    ]);
    await client.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, email, role, client_id, scopes)
       VALUES ($1, $2, $3, $4, $5)`,
      [hashToken(newToken), r.email, r.role, r.clientId, JSON.stringify(r.scopes)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
