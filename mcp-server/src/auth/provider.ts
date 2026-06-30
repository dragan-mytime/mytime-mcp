import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Pool } from "@mytime/shared";
import type { Response } from "express";
import { lookupAuthorizedUser } from "./authorized-users.js";
import { googleAuthUrl, passesDomainGate, verifyGoogleCallback } from "./google.js";
import {
  deleteCode,
  deleteRefresh,
  getClient,
  getCode,
  getRefresh,
  type PendingAuth,
  putClient,
  putCode,
  putPending,
  putRefresh,
  randomToken,
  takePending,
} from "./store.js";
import { issueAccessToken, verifyAccessTokenJwt } from "./tokens.js";

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Custom OAuth 2.1 server provider that federates login to Google and issues our
 * own role-bearing access tokens. The MCP SDK supplies the /authorize, /token,
 * /register and metadata endpoints + PKCE validation; this provider implements
 * the hooks and the two-layer gate (Google domain + authorized_users).
 */
export function createMyTimeProvider(pool: Pool): OAuthServerProvider {
  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => getClient(pool, id),
    registerClient: async (client) => {
      const full: OAuthClientInformationFull = {
        ...client,
        client_id: randomToken(),
        client_id_issued_at: nowSec(),
      };
      await putClient(pool, full);
      return full;
    },
  };

  return {
    get clientsStore() {
      return clientsStore;
    },

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response,
    ): Promise<void> {
      const state = randomToken();
      putPending(state, {
        clientId: client.client_id,
        clientRedirectUri: params.redirectUri,
        clientState: params.state,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes ?? [],
        resource: params.resource?.toString(),
        createdAt: Date.now(),
      });
      res.redirect(googleAuthUrl(state));
    },

    async challengeForAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const c = getCode(authorizationCode);
      if (!c || c.clientId !== client.client_id) throw new Error("invalid_grant");
      return c.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<OAuthTokens> {
      const c = getCode(authorizationCode);
      if (!c || c.clientId !== client.client_id) throw new Error("invalid_grant");
      deleteCode(authorizationCode);
      const { token, expiresAt } = await issueAccessToken({
        email: c.email,
        role: c.role,
        clientId: client.client_id,
        scopes: c.scopes,
      });
      const refreshToken = randomToken();
      await putRefresh(pool, refreshToken, {
        email: c.email,
        role: c.role,
        clientId: client.client_id,
        scopes: c.scopes,
      });
      return {
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresAt - nowSec(),
        refresh_token: refreshToken,
        scope: c.scopes.join(" "),
      };
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
    ): Promise<OAuthTokens> {
      const rec = await getRefresh(pool, refreshToken);
      if (!rec || rec.clientId !== client.client_id) throw new Error("invalid_grant");
      // Re-check the whitelist so deactivations / role changes take effect on refresh.
      const u = await lookupAuthorizedUser(pool, rec.email);
      if (!u || !u.active) {
        await deleteRefresh(pool, refreshToken);
        throw new Error("invalid_grant");
      }
      const effScopes = scopes ?? rec.scopes;
      const { token, expiresAt } = await issueAccessToken({
        email: rec.email,
        role: u.role,
        clientId: client.client_id,
        scopes: effScopes,
      });
      return {
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresAt - nowSec(),
        scope: effScopes.join(" "),
      };
    },

    verifyAccessToken(token: string): Promise<AuthInfo> {
      return verifyAccessTokenJwt(token);
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      if (request.token) await deleteRefresh(pool, request.token);
    },
  };
}

function denyRedirect(p: PendingAuth, error: string, description: string): string {
  const url = new URL(p.clientRedirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (p.clientState) url.searchParams.set("state", p.clientState);
  return url.toString();
}

/**
 * Google callback: verify the signed ID token (Layer 1 domain gate), check
 * `authorized_users` (Layer 2), then mint our authorization code. Returns the
 * URL to redirect the browser back to the MCP client (with `code` or `error`).
 */
export async function handleGoogleCallback(
  pool: Pool,
  code: string,
  state: string,
): Promise<string> {
  const p = takePending(state);
  if (!p) throw new Error("unknown or expired authorization state");

  let identity: Awaited<ReturnType<typeof verifyGoogleCallback>>;
  try {
    identity = await verifyGoogleCallback(code);
  } catch {
    return denyRedirect(p, "server_error", "Google verification failed");
  }

  if (!passesDomainGate(identity)) {
    return denyRedirect(p, "access_denied", "Not a verified mytime.mk account");
  }
  const user = await lookupAuthorizedUser(pool, identity.email);
  if (!user || !user.active) {
    return denyRedirect(p, "access_denied", "Account is not authorized");
  }

  const authCode = randomToken();
  putCode(authCode, {
    email: identity.email,
    role: user.role,
    clientId: p.clientId,
    codeChallenge: p.codeChallenge,
    redirectUri: p.clientRedirectUri,
    scopes: p.scopes,
    resource: p.resource,
    expiresAt: nowSec() + 300,
  });

  const url = new URL(p.clientRedirectUri);
  url.searchParams.set("code", authCode);
  if (p.clientState) url.searchParams.set("state", p.clientState);
  return url.toString();
}
