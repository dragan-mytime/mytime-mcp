# Gemini API key — Settings field (super-admin only)

**Date:** 2026-06-30
**Status:** Approved design (small follow-on to Subsystem E — Digest Studio)

## Problem

Digest AI narration needs a `GEMINI_API_KEY`. It is not set on the server, so the prompt
the user authors has no effect (everything falls back to the deterministic template). The
user wants to paste the key into the admin panel instead of editing `.env` on the VPS — but
only **they** (a super-admin) should see or set it.

## Decision

Add a single **Gemini API key** field to the existing `/admin/settings` page, visible and
editable **only to the super-admin**. This deliberately reverses the original Subsystem D
stance ("secrets stay in `.env`"); accepted tradeoff — the key will live in the Supabase
`app_settings` table (plaintext jsonb, like other settings), behind the admin gate + HTTPS +
CSRF, and masked in the UI. A Gemini key is low-blast-radius and easily rotated.

## Super-admin gate

- `isSuperAdmin(email)` (in `mcp-server/src/admin/auth.ts`): true when
  `email.toLowerCase() === (optionalEnv("MCP_SUPER_ADMIN_EMAIL") ?? "dragan@mytime.mk").toLowerCase()`.
- Enforced in **two** places (never trust the form):
  1. `settings.render` only emits the Gemini field when `isSuperAdmin(admin.email)`.
  2. `settings.submit` only reads/writes the `gemini_api_key` fields when
     `isSuperAdmin(admin.email)`; otherwise those fields are ignored.

## UI (super-admin only)

- A **masked status line**: `Gemini key: set (…1234)` (last 4 chars) or `not set`. The actual
  key is NEVER rendered into the HTML.
- A `type="password"` input to paste a new key. **Blank on Save = leave unchanged.**
- A **"Remove key"** checkbox that clears the stored key (falls back to `.env` afterwards).

## Storage & effect

- Stored under `app_settings` key `gemini_api_key` via `setSetting` (string, or `null` when
  removed).
- `db/src/digests-db.ts` gains:
  - `resolveGeminiKey(db)` → DB setting (trimmed, non-empty) **else** `optionalEnv("GEMINI_API_KEY")`
    **else** `undefined`.
  - `maskGeminiKey(key)` → pure: `"not set"` for empty/null, else `"set (…" + last4 + ")"`.
- `db/src/digest-render.ts`:
  - `geminiNarrate(digest, promptBody, apiKey?, model?)` — uses `apiKey ?? optionalEnv("GEMINI_API_KEY")`.
  - `renderDigestWithPrompt(digest, promptBody, apiKey?)` — passes `apiKey` through.
- Callers resolve and pass the key:
  - scheduler `tick` (`mcp-server/src/digestScheduler.ts`),
  - admin `previewPrompt` and `testPrompt` (`mcp-server/src/admin/pages/digests.ts`).
- Effect is immediate (read per render/run) — no restart, no redeploy. `.env` remains a
  fallback so existing behavior is unchanged when no DB value is set.

## Testing

- Unit (`@mytime/db`): `maskGeminiKey` (null/empty → "not set"; long key → "set (…1234)").
- Existing render tests stay green — the new `apiKey` arg is optional and backward-compatible
  (no apiKey + stubbed empty env → template fallback).
- Manual: as super-admin, paste a key → Preview shows real Gemini output (no fallback note);
  as a non-super-admin, the field is absent and a forged POST of `gemini_api_key` is ignored.

## Scope / YAGNI

- No new role/column — a single configured super-admin email is enough for "only me".
- No key rotation history, no encryption-at-rest beyond what Supabase provides.
- Reuses the existing Settings page; no new route.
