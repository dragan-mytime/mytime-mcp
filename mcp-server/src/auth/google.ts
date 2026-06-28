import { optionalEnv, requireEnv } from "@mytime/shared";
import { OAuth2Client } from "google-auth-library";

/** Our Google OAuth callback URL (must be registered in the Google client). */
export function callbackUrl(): string {
  return new URL("/auth/google/callback", requireEnv("MCP_PUBLIC_URL")).toString();
}

function client(): OAuth2Client {
  return new OAuth2Client(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    callbackUrl(),
  );
}

/** Build the Google consent-screen URL the user is redirected to. */
export function googleAuthUrl(state: string): string {
  return client().generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    access_type: "online",
    prompt: "select_account",
  });
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  hd?: string; // hosted-domain claim (Google Workspace)
}

/**
 * Layer 1: exchange the Google auth code and verify the **signed** ID token
 * (signature, audience, expiry via google-auth-library). Returns the verified
 * identity — never trust unsigned/query values.
 */
export async function verifyGoogleCallback(code: string): Promise<GoogleIdentity> {
  const c = client();
  const { tokens } = await c.getToken(code);
  if (!tokens.id_token) throw new Error("Google returned no id_token");
  const ticket = await c.verifyIdToken({
    idToken: tokens.id_token,
    audience: requireEnv("GOOGLE_CLIENT_ID"),
  });
  const p = ticket.getPayload();
  if (!p?.email) throw new Error("Google id_token has no email");
  return { email: p.email, emailVerified: p.email_verified === true, hd: p.hd };
}

/** Layer 1 domain check: verified email on the allowed domain. */
export function passesDomainGate(id: GoogleIdentity): boolean {
  const domain = optionalEnv("ALLOWED_EMAIL_DOMAIN", "mytime.mk") ?? "mytime.mk";
  return id.emailVerified && id.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}
