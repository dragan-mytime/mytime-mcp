import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { type Role, requireEnv } from "@mytime/shared";
import { jwtVerify, SignJWT } from "jose";

const ACCESS_TTL_SEC = 3600; // 1 hour

function secret(): Uint8Array {
  return new TextEncoder().encode(requireEnv("MCP_JWT_SECRET"));
}

export interface AccessClaims {
  email: string;
  role: Role;
  clientId: string;
  scopes: string[];
}

/** Issue our own signed access token carrying the verified email + role. */
export async function issueAccessToken(
  claims: AccessClaims,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC;
  const token = await new SignJWT({
    email: claims.email,
    role: claims.role,
    client_id: claims.clientId,
    scope: claims.scopes.join(" "),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.email)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret());
  return { token, expiresAt };
}

/** Verify our access token → AuthInfo (role/email in `extra`). Throws if invalid. */
export async function verifyAccessTokenJwt(token: string): Promise<AuthInfo> {
  const { payload } = await jwtVerify(token, secret());
  return {
    token,
    clientId: String(payload.client_id ?? ""),
    scopes: String(payload.scope ?? "")
      .split(" ")
      .filter(Boolean),
    expiresAt: payload.exp,
    extra: { email: payload.email, role: payload.role },
  };
}
