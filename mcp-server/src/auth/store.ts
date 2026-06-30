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
export const putPending = (state: string, p: PendingAuth): void => void pending.set(state, p);
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
export const putCode = (code: string, c: AuthCode): void => void codes.set(code, c);
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
}
export async function putRefresh(pool: Pool, t: string, r: RefreshRec): Promise<void> {
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
  }>("SELECT email, role, client_id, scopes FROM oauth_refresh_tokens WHERE token_hash = $1", [
    hashToken(t),
  ]);
  const row = rows[0];
  return row
    ? { email: row.email, role: row.role, clientId: row.client_id, scopes: row.scopes }
    : undefined;
}
export async function deleteRefresh(pool: Pool, t: string): Promise<void> {
  await pool.query("DELETE FROM oauth_refresh_tokens WHERE token_hash = $1", [hashToken(t)]);
}
