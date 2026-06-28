import { randomBytes } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Role } from "@mytime/shared";

/**
 * In-memory OAuth state (single-process VPS). Registered clients, pending Google
 * round-trips, our auth codes, and refresh tokens. NOTE: cleared on restart —
 * Claude re-registers via DCR transparently. Persist to Postgres later if the
 * server needs to survive restarts without re-registration.
 */

export const randomToken = (): string => randomBytes(32).toString("base64url");

// ── Registered clients (DCR) ─────────────────────────────────────────────────
const clients = new Map<string, OAuthClientInformationFull>();
export const putClient = (c: OAuthClientInformationFull): void => void clients.set(c.client_id, c);
export const getClient = (id: string): OAuthClientInformationFull | undefined => clients.get(id);

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

// ── Refresh tokens ───────────────────────────────────────────────────────────
export interface RefreshRec {
  email: string;
  role: Role;
  clientId: string;
  scopes: string[];
}
const refresh = new Map<string, RefreshRec>();
export const putRefresh = (t: string, r: RefreshRec): void => void refresh.set(t, r);
export const getRefresh = (t: string): RefreshRec | undefined => refresh.get(t);
export const deleteRefresh = (t: string): void => void refresh.delete(t);
