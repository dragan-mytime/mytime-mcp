# Subsystem D — Admin Panel

**Date:** 2026-06-29
**Status:** Approved design (pre-implementation)
**Part of:** a follow-on to the original 3-subsystem expansion (A discounts, B ad-intelligence, C digest — all DONE/deployed). D is the user's self-service config console.

## Problem

Configurable state is scattered and only editable via SSH/Supabase: roles live in the `authorized_users` DB table, digest recipients + operational variables in `.env` on the VPS, and competitor targets in `config/targets.json`. The user wants a web admin panel to manage all of it without touching the server.

## Decisions (locked during brainstorming)

- **Scope:** the panel manages **all four** config categories — user roles & access, report recipients, operational settings, and competitor targets.
- **Approach:** full config console (not phased). This includes **migrating `config/targets.json` into the database** and changing `loadTargets()` to read from the DB — the core refactor.
- **Frontend:** **server-rendered HTML** forms added to the **existing Express MCP server** (no new service, no frontend build pipeline).
- **Hosting:** served at `https://mcp.mytimeprime.mk/admin` (existing nginx already proxies to the server).
- **Secrets stay in `.env`** (API keys are NOT web-editable, for safety).

## Architecture

```
Browser ──HTTPS──▶ nginx ──▶ Express server (/admin/*) ──▶ write DB pool (DATABASE_URL)
                                   │  Google OAuth web login → admin-role gate → JWT session cookie
                                   └─ reads/writes: authorized_users, app_settings, targets
ingestion (daily run) ─reads config at run start→ loadTargets()/getSetting() from DB
mcp-server (per request) ─reads roles→ authorized_users
```

## 1. Config store (DB)

- **`authorized_users`** (roles) — exists; the Users page CRUDs it.
- **New `app_settings`** table: `key text primary key`, `value jsonb not null`, `updated_at timestamptz default now()`. Holds: `digest_recipients` (string[]), `daily_run_time` (informational), `discount_threshold_pct` (number), `ad_results_limit` (number), `digest_enabled` (bool), `web_max_products` (number). A **`getSetting<T>(db, key, fallback): Promise<T>`** helper (in `@mytime/db`) reads it, falling back to the env/default so nothing breaks before a value is set.
- **`targets`** — extend with `web jsonb`, `social jsonb`, `enabled boolean not null default true` (and any other fields `targets.json` carries that aren't already columns: `kind`, `monobrand`, etc. — audited during the plan). **Migration + one-time seed** loads `config/targets.json` into these rows. **`loadTargets()` (currently reads the JSON file) changes to read enabled DB rows** and map them to the existing `Target` shape. After migration the DB is the source of truth; `config/targets.json` remains only as the initial seed. The existing target-validation logic runs against the mapped DB rows.

## 2. Admin web app (Express, server-rendered)

Added to `mcp-server` (the existing Express app), in a new `mcp-server/src/admin/` module mounted at `/admin`:

- **Pages** (each a server-rendered HTML form; minimal inline CSS, no JS framework):
  - **Dashboard** `/admin` — summary + links.
  - **Users** `/admin/users` — list `authorized_users`; add/edit/remove; set role (admin/analyst/viewer) + active.
  - **Recipients** `/admin/recipients` — edit `digest_recipients`.
  - **Settings** `/admin/settings` — edit operational settings (thresholds, limits, toggles, run-time note).
  - **Targets** `/admin/targets` — list competitors; edit `web.url`/`social` handles/`enabled`; add/remove.
- **Browser auth (new, separate from the MCP OAuth that mints API tokens):**
  - `/admin/*` → no valid session → redirect to Google OAuth (reuse the existing Google client; add redirect URI `https://mcp.mytimeprime.mk/admin/auth/callback`).
  - Callback verifies the Google ID token (`email_verified`, `@mytime.mk` domain), checks `authorized_users` for an **admin** role, then sets a **signed session cookie** (JWT via the existing `MCP_JWT_SECRET`, short TTL, `HttpOnly`, `Secure`, `SameSite=Lax`). Non-admins get a 403.
  - A middleware guards every `/admin` route (except the auth endpoints).
- **Writes:** admin routes use a **write pool** (`createPool(DATABASE_URL)`) created lazily in the admin module — distinct from the MCP tools' read-only pool. Writes happen only inside authenticated admin POST handlers.

## 3. Security

- Admin-only (Google domain gate + `authorized_users` admin role), HTTPS (existing nginx TLS).
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, signed (JWT), short TTL.
- **CSRF token** issued per session and required on every POST form (hidden field, verified server-side).
- Server-side validation of every input (roles enum, email format for recipients, URL format for target URLs, numeric ranges for thresholds).
- Secrets (`RESEND_API_KEY`, `META_ACCESS_TOKEN`, etc.) are NOT exposed or editable in the panel.

## 4. When changes take effect

- **Roles** — immediately (MCP server reads `authorized_users` per request; the user must reconnect/refresh their token to pick up a role change, as today).
- **Recipients / settings / targets** — on the **next daily run** (ingestion reads `loadTargets()` + `getSetting()` at run start). The UI labels these "applies on the next daily run (03:15)".

## 5. Hosting & deploy

- Served by the existing Express server at `/admin`; nginx already proxies `/` → `127.0.0.1:8080`, so `/admin` works with no nginx change (confirm the existing proxy passes all paths).
- Deploy via the existing flow (git archive → VPS → build → restart `mytime-mcp`). The `app_settings` + `targets` migrations apply to Supabase; the targets seed runs once.

## Testing

- **Unit:** `getSetting` (returns DB value, falls back to default); the DB→`Target` mapping in `loadTargets`; each input validator (role enum, email, URL, numeric range); the CSRF check.
- **Integration (live DB):** auth gate rejects a non-admin and a non-`@mytime.mk` user; an admin can load each page; a round-trip per page (edit → persisted → reads back); after editing a target's `enabled=false`, a `loadTargets()` call omits it.
- **End-to-end:** log in at `/admin` in a browser, change a setting + a recipient + toggle a target, confirm the next manual ingest/`getSetting` reflects them.
- `pnpm -r build` + Biome clean.

## Scope / YAGNI

- No audit log/history (just `updated_at`); no multi-tenant; no role beyond the existing admin/analyst/viewer.
- Functional forms, minimal styling — not a polished SPA.
- Secrets stay in `.env`.
- `config/targets.json` is kept as the seed; not deleted (so a fresh environment can re-seed).

## Success criteria

1. An admin logs in at `https://mcp.mytimeprime.mk/admin` via Google; non-admins/non-`@mytime.mk` are blocked.
2. The panel CRUDs roles, edits recipients + operational settings, and manages competitor targets — all persisted to the DB.
3. `loadTargets()` reads from the DB (migrated from `targets.json`); ingestion uses DB targets; disabling a target excludes it from the next run.
4. `getSetting` drives recipients/thresholds with env fallback.
5. Build + Biome clean; auth gate + CSRF verified; secrets never exposed.
