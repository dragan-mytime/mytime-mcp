import { randomBytes } from "node:crypto";
import { optionalEnv, requireEnv } from "@mytime/shared";
import type { RequestHandler } from "express";
import { OAuth2Client } from "google-auth-library";
import { lookupAuthorizedUser } from "../auth/authorized-users.js";
import { adminWritePool } from "../writePool.js";
import {
  clearCookie,
  issueSession,
  readCookie,
  serializeCookie,
  verifySession,
} from "./session.js";

/**
 * True when `email` is the configured super-admin (defaults to dragan@mytime.mk).
 * Super-admin gates secret-bearing settings (e.g. the Gemini API key) that ordinary
 * admins must not see or edit.
 */
export function isSuperAdmin(email: string): boolean {
  const superEmail = (optionalEnv("MCP_SUPER_ADMIN_EMAIL", "dragan@mytime.mk") ?? "").toLowerCase();
  return superEmail !== "" && email.trim().toLowerCase() === superEmail;
}

/** Build the OAuth2Client pointed at the admin callback URL. */
function adminClient(): OAuth2Client {
  const base = requireEnv("MCP_PUBLIC_URL").replace(/\/$/, "");
  return new OAuth2Client(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    `${base}/admin/auth/callback`,
  );
}

const STATE_COOKIE = "mt_oauth_state";

/** GET /admin/auth/login */
export const loginHandler: RequestHandler = (_req, res) => {
  const state = randomBytes(16).toString("hex");
  const client = adminClient();
  const url = client.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    access_type: "online",
    prompt: "select_account",
  });
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/admin/auth; Max-Age=600`,
  );
  res.redirect(url);
};

/** GET /admin/auth/callback */
export const callbackHandler: RequestHandler = async (req, res) => {
  try {
    // Verify state cookie
    const cookieHeader = req.headers.cookie;
    const stateCookie = cookieHeader ? parseCookieValue(cookieHeader, STATE_COOKIE) : null;
    const stateParam = req.query.state;
    if (!stateCookie || !stateParam || stateCookie !== String(stateParam)) {
      res.status(400).send("Invalid OAuth state — CSRF check failed.");
      return;
    }

    const code = req.query.code;
    if (!code || typeof code !== "string") {
      res.status(400).send("Missing authorization code.");
      return;
    }

    const client = adminClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) {
      res.status(400).send("Google returned no id_token.");
      return;
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: requireEnv("GOOGLE_CLIENT_ID"),
    });
    const p = ticket.getPayload();
    if (!p?.email) {
      res.status(400).send("Google id_token has no email.");
      return;
    }

    // Domain gate
    if (!p.email_verified) {
      res.status(403).send("Email not verified.");
      return;
    }
    const domain = optionalEnv("ALLOWED_EMAIL_DOMAIN", "mytime.mk") ?? "mytime.mk";
    if (!p.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) {
      res.status(403).send("Not authorized — wrong email domain.");
      return;
    }

    // Role check
    const u = await lookupAuthorizedUser(adminWritePool(), p.email);
    if (u?.active && u.role === "admin") {
      res.setHeader("Set-Cookie", [
        serializeCookie(await issueSession(p.email)),
        // Clear the state cookie
        `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/admin/auth; Max-Age=0`,
      ]);
      res.redirect("/admin");
    } else {
      res.status(403).send("Not authorized — admin role required.");
    }
  } catch (err) {
    console.error("[admin/auth] callbackHandler error:", err);
    res.status(500).send("Authentication error.");
  }
};

/** GET /admin/auth/logout */
export const logoutHandler: RequestHandler = (_req, res) => {
  res.setHeader("Set-Cookie", clearCookie());
  res.redirect("/admin/auth/login");
};

/** Middleware: require a valid admin session cookie. */
export const requireAdmin: RequestHandler = async (req, res, next) => {
  try {
    const tok = readCookie(req.headers.cookie);
    const s = tok ? await verifySession(tok) : null;
    if (s) {
      (req as unknown as Record<string, unknown>).admin = s;
      next();
    } else {
      res.redirect("/admin/auth/login");
    }
  } catch {
    res.redirect("/admin/auth/login");
  }
};

/** Parse a single named cookie value from a Cookie header string. */
function parseCookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === name) return val || null;
  }
  return null;
}
