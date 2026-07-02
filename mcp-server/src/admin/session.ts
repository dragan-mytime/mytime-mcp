import { randomBytes, timingSafeEqual } from "node:crypto";
import { requireEnv } from "@mytime/shared";
import { jwtVerify, SignJWT } from "jose";

export const COOKIE_NAME = "mt_admin";

function secret(): Uint8Array {
  return new TextEncoder().encode(requireEnv("MCP_JWT_SECRET"));
}

export async function issueSession(email: string): Promise<string> {
  return new SignJWT({
    email,
    role: "admin",
    csrf: randomBytes(16).toString("hex"),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret());
}

export async function verifySession(
  token: string,
): Promise<{ email: string; csrf: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    const email = payload.email;
    const csrf = payload.csrf;
    if (typeof email !== "string" || typeof csrf !== "string") {
      return null;
    }
    return { email, csrf };
  } catch {
    return null;
  }
}

export function serializeCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=28800`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`;
}

export function readCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === COOKIE_NAME) {
      return val || null;
    }
  }
  return null;
}

export function checkCsrf(sessionCsrf: string, formCsrf: unknown): boolean {
  if (typeof formCsrf !== "string" || formCsrf.length === 0) return false;
  // D5: use timing-safe comparison to prevent timing side-channel attacks.
  if (formCsrf.length !== sessionCsrf.length) return false;
  return timingSafeEqual(Buffer.from(formCsrf), Buffer.from(sessionCsrf));
}
