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

/**
 * D4 review: rotation reuse tolerance (OAuth 2.1 §4.3). When a refresh token is
 * rotated, the old row is MARKED superseded rather than deleted. If the client
 * never received (or failed to persist) the new token and retries with the old
 * one within this grace window, `getRefresh` resolves to the successor row so
 * the refresh still succeeds instead of forcing a browser re-auth. DB-backed so
 * the grace survives process restarts/deploys.
 */
export const ROTATION_GRACE_MS = 60_000;

export interface RefreshRec {
  email: string;
  role: Role;
  clientId: string;
  scopes: string[];
  createdAt: Date;
  /** Hash of the ACTIVE row this lookup resolved to (successor when within grace). */
  tokenHash: string;
}

interface RefreshRow {
  token_hash: string;
  email: string;
  role: Role;
  client_id: string;
  scopes: string[];
  created_at: Date | string;
  superseded_by_hash: string | null;
  superseded_at: Date | string | null;
}

async function getRefreshRow(pool: Pool, hash: string): Promise<RefreshRow | undefined> {
  const { rows } = await pool.query<RefreshRow>(
    `SELECT token_hash, email, role, client_id, scopes, created_at, superseded_by_hash, superseded_at
     FROM oauth_refresh_tokens WHERE token_hash = $1`,
    [hash],
  );
  return rows[0];
}
export async function putRefresh(
  pool: Pool,
  t: string,
  r: Omit<RefreshRec, "createdAt" | "tokenHash">,
): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, email, role, client_id, scopes)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token_hash) DO NOTHING`,
    [hashToken(t), r.email, r.role, r.clientId, JSON.stringify(r.scopes)],
  );
}
/**
 * Look up a refresh token. Follows the supersession chain: a superseded row
 * presented within ROTATION_GRACE_MS of its superseded_at resolves to its
 * successor (transparent retry after a lost rotation response); outside the
 * grace window the stale row is deleted and the lookup fails.
 */
export async function getRefresh(pool: Pool, t: string): Promise<RefreshRec | undefined> {
  let row = await getRefreshRow(pool, hashToken(t));
  // Bounded chain-follow: each hop must be within its own grace window.
  for (let hop = 0; row?.superseded_by_hash; hop++) {
    const supAt = row.superseded_at ? new Date(row.superseded_at).getTime() : 0;
    if (hop >= 5 || Date.now() - supAt > ROTATION_GRACE_MS) {
      // Reuse outside the grace window → invalid_grant; drop the stale row.
      await pool.query("DELETE FROM oauth_refresh_tokens WHERE token_hash = $1", [row.token_hash]);
      return undefined;
    }
    row = await getRefreshRow(pool, row.superseded_by_hash);
  }
  if (!row) return undefined;
  return {
    email: row.email,
    role: row.role,
    clientId: row.client_id,
    scopes: row.scopes,
    createdAt: new Date(row.created_at),
    tokenHash: row.token_hash,
  };
}
export async function deleteRefresh(pool: Pool, t: string): Promise<void> {
  await pool.query("DELETE FROM oauth_refresh_tokens WHERE token_hash = $1", [hashToken(t)]);
}
/** Delete by the resolved row hash (from RefreshRec.tokenHash) rather than the raw token. */
export async function deleteRefreshByHash(pool: Pool, hash: string): Promise<void> {
  await pool.query("DELETE FROM oauth_refresh_tokens WHERE token_hash = $1", [hash]);
}

/**
 * D4: rotate a refresh token. Marks the old row superseded (grace-window reuse
 * tolerance — see ROTATION_GRACE_MS) and inserts the new row in one atomic
 * statement, then garbage-collects superseded rows past the grace window.
 */
export async function rotateRefresh(
  pool: Pool,
  oldHash: string,
  newToken: string,
  r: Omit<RefreshRec, "createdAt" | "tokenHash">,
): Promise<void> {
  // Single-statement CTE keeps mark+insert atomic without a client transaction.
  await pool.query(
    `WITH mark AS (
       UPDATE oauth_refresh_tokens
       SET superseded_by_hash = $1, superseded_at = now()
       WHERE token_hash = $2
     )
     INSERT INTO oauth_refresh_tokens (token_hash, email, role, client_id, scopes)
     VALUES ($1, $3, $4, $5, $6)
     ON CONFLICT (token_hash) DO NOTHING`,
    [hashToken(newToken), oldHash, r.email, r.role, r.clientId, JSON.stringify(r.scopes)],
  );
  // Cleanup: superseded rows past the grace window can never be used again.
  await pool.query(
    `DELETE FROM oauth_refresh_tokens
     WHERE superseded_at IS NOT NULL AND superseded_at < now() - make_interval(secs => $1)`,
    [ROTATION_GRACE_MS / 1000],
  );
}
