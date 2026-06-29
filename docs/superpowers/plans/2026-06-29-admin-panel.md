# Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A server-rendered admin panel at `/admin` (Google-login, admin-only) to manage user roles, digest recipients, operational settings, and competitor targets — backed by DB config (`app_settings` + a DB-driven `targets`), with ingestion reading targets/settings from the DB.

**Architecture:** Add an `/admin` Express module to the existing MCP server with a Google-OAuth browser session (JWT cookie) gated to the `authorized_users` admin role, CSRF-protected forms, and a write DB pool. Migrate `config/targets.json` into the `targets` table and switch `loadTargets()` to read the DB; add an `app_settings` key-value table with `getSetting()`.

**Tech Stack:** Node 24/TS 6 (ESM/NodeNext), Express, Drizzle, Vitest, Biome, jose (JWT, already used), google-auth-library (already used).

---

## Verified facts (from the codebase)

- `Target` shape (from `config/targets.json`): `{ id, name, legal_entity, is_self, web: { enabled, url, source, monobrand, per_location_stock, locations, platform }, social: { instagram?, facebook?, tiktok? }, registry: { central_registry_id } }`. Validated by `targetsFileSchema` (zod) in `shared/src/targets.ts`; `loadTargets(path)` reads the JSON file.
- `targets` table (`db/src/schema.ts`) HAS: `id, name, legalEntity, isSelf, webEnabled, webUrl, webSource(enum), monobrand, perLocationStock, active, created/updatedAt`. MISSING for full config: **`platform`**, **`social`**, **`registry`/central_registry_id**, web `locations`.
- Reusable auth (`mcp-server/src/auth/`): `googleAuthUrl(state)`, `verifyGoogleCallback(code)→{email,emailVerified,hd}`, `isAllowedDomain(...)` (`google.ts`); `lookupAuthorizedUser(pool,email)→{email,role,active}` (`authorized-users.ts`). NOTE: `googleAuthUrl`/`verifyGoogleCallback` use the MCP `callbackUrl()` (`/auth/google/callback`); the admin browser flow needs its OWN redirect `/admin/auth/callback` — add a parallel helper or parameterize the redirect.
- `createApp()` (`mcp-server/src/server.ts`) mounts routes then `return app` (line ~119) — mount `/admin` there. `readPool()` (read-only) in `db.ts`; the admin needs a separate WRITE pool (`createPool(requireEnv("DATABASE_URL"))`).
- `MCP_JWT_SECRET` (env) signs JWTs via `jose` already (see `mcp-server/src/auth`). Reuse for the session cookie.
- The MCP server runs read-only today (`DATABASE_URL_READONLY`); the admin write pool uses `DATABASE_URL` — confirm it's present in the VPS `.env` (it is — ingestion uses it; the MCP `.env` is the same repo-root `.env`).

## File structure

```
db/src/schema.ts                 # + app_settings table; + targets.platform/social/registry/locations cols
db/                              # migration
db/src/settings.ts               # getSetting/setSetting
db/src/targets-db.ts             # loadTargetsFromDb(db) -> Target[]; seedTargetsFromJson(db)
ingestion/src/index.ts           # loadTargets(path) -> loadTargetsFromDb(db)
mcp-server/src/admin/session.ts  # issueSession/verifySession (JWT cookie) + CSRF
mcp-server/src/admin/auth.ts     # admin Google login routes (/admin/auth/*) + requireAdmin middleware
mcp-server/src/admin/pages/*.ts  # dashboard, users, recipients, settings, targets (render + POST)
mcp-server/src/admin/render.ts   # tiny HTML layout helper (escaping)
mcp-server/src/admin/router.ts   # express.Router mounting the above
mcp-server/src/server.ts         # app.use("/admin", adminRouter())
mcp-server/src/writePool.ts      # lazy write pool
```

---

## Task 1: `app_settings` table + targets column extensions + migration

**Files:** `db/src/schema.ts`; generated migration.

- [ ] **Step 1:** Add to `schema.ts`:
```ts
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppSettingRow = typeof appSettings.$inferSelect;
```
And extend the `targets` table definition with the missing config columns:
```ts
  platform: text("platform"),          // web.platform e.g. "woocommerce" (distinct from web_source)
  social: jsonb("social"),             // { instagram?, facebook?, tiktok? }
  registry: jsonb("registry"),         // { central_registry_id }
  webLocations: jsonb("web_locations"),// web.locations array
```
(Keep existing columns. `active` already serves as the enabled flag; the UI uses `active`. `jsonb` is imported already — confirm.)
- [ ] **Step 2:** `corepack pnpm --filter @mytime/db build` clean. `corepack pnpm db:generate` → inspect: it must `CREATE TABLE app_settings` + `ALTER TABLE targets ADD COLUMN platform/social/registry/web_locations` and nothing destructive. If it tries to DROP/alter unrelated, STOP + report.
- [ ] **Step 3:** `corepack pnpm db:migrate`. Verify `select count(*) from app_settings` = 0 and `targets` has the new columns.
- [ ] **Step 4:** Commit: `git add db/src/schema.ts db/migrations && git commit -m "feat(db): app_settings + targets config columns"`

---

## Task 2: settings helper (TDD-ish) + seed/load targets from DB

**Files:** Create `db/src/settings.ts`, `db/src/targets-db.ts`; export from `db/src/index.ts`.

- [ ] **Step 1:** `db/src/settings.ts`:
```ts
import { sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { appSettings } from "./schema.js";

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = await db.execute(sql`select value from app_settings where key = ${key}`);
  const rows = (r as { rows?: { value: unknown }[] }).rows ?? [];
  return rows.length ? (rows[0].value as T) : fallback;
}
export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value: value as object })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: value as object, updatedAt: new Date() } });
}
export async function allSettings(db: Db): Promise<Record<string, unknown>> {
  const r = await db.execute(sql`select key, value from app_settings`);
  const rows = (r as { rows?: { key: string; value: unknown }[] }).rows ?? [];
  return Object.fromEntries(rows.map((x) => [x.key, x.value]));
}
```
- [ ] **Step 2:** `db/src/targets-db.ts`:
  - `seedTargetsFromJson(db, jsonPath)` — reads `config/targets.json` (via `loadTargets` from `@mytime/shared`), upserts each into `targets` (mapping `web.*`→columns incl. `platform`, `social`→`social` jsonb, `registry`, `web.locations`→`webLocations`, `web.enabled`→`webEnabled`, `is_self`→`isSelf`, etc.). Idempotent (onConflictDoUpdate by id).
  - `loadTargetsFromDb(db): Promise<Target[]>` — selects `targets` rows, maps each back to the `Target` shape, then runs them through `targetsFileSchema` (import from `@mytime/shared`) to validate, returning `Target[]`. Only rows where the consumer wants them — return ALL; callers filter `web.enabled`/`active` as today. (Map `active`/`webEnabled` to `web.enabled`.)
- [ ] **Step 3:** Export both + settings from `db/src/index.ts`.
- [ ] **Step 4:** Build. **Seed live:** throwaway script `node --env-file=.env -e "import('@mytime/db').then(async m=>{const db=m.createDb(process.env.DATABASE_URL); await m.seedTargetsFromJson(db,'config/targets.json'); const t=await m.loadTargetsFromDb(db); console.log('targets in DB:', t.length, t.map(x=>x.id)); process.exit(0)})"`. Confirm all targets load from DB and match `config/targets.json` ids. Paste the list.
- [ ] **Step 5:** Add a unit test (`ingestion/test` has Vitest; or add a vitest config to `db`): test the Target→row→Target round-trip mapping with a sample (assert `web.platform`, `social.facebook` survive). Commit: `git add db/src && git commit -m "feat(db): app_settings getSetting + targets DB seed/load"`

---

## Task 3: ingestion reads targets from the DB

**Files:** `ingestion/src/index.ts` (+ any other `loadTargets(path)` callers — grep).

- [ ] **Step 1:** `grep -rn "loadTargets" ingestion/src` to find all callers. In the runner, replace `const targets = loadTargets(targetsPath)` with `const targets = await loadTargetsFromDb(db)` (import from `@mytime/db`). Keep the `targetsPath` arg for back-compat but unused, or remove it.
- [ ] **Step 2:** Build. **Live check:** run a tiny no-write ingest path or just `node --env-file=.env -e "import('@mytime/db').then(async m=>{const db=m.createDb(process.env.DATABASE_URL);console.log((await m.loadTargetsFromDb(db)).filter(t=>t.web.enabled).length,'enabled web targets');process.exit(0)})"`. Confirm the same count as before.
- [ ] **Step 3:** Commit: `git add ingestion/src/index.ts && git commit -m "feat(ingestion): load targets from DB"`

---

## Task 4: admin session (JWT cookie) + CSRF (TDD)

**Files:** Create `mcp-server/src/admin/session.ts`; test `mcp-server`'s first test (add vitest to mcp-server if absent, OR put the pure helpers' test in `ingestion/test` — simplest: keep helpers pure and test the token/CSRF logic).

- [ ] **Step 1:** Implement `session.ts`:
  - `issueSession(email): Promise<string>` — sign a jose JWT `{ email, role: "admin", csrf: <random hex> }` with `MCP_JWT_SECRET`, 8h expiry. Return the token.
  - `verifySession(token): Promise<{ email: string; csrf: string } | null>` — verify + return claims or null.
  - `cookieName = "mt_admin"`. Helpers `serializeCookie(token)` (HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age) and `parseCookie(header)`.
  - CSRF: the session carries a `csrf` token; forms embed it; POST handlers compare `req.body.csrf === session.csrf`.
- [ ] **Step 2:** Test the round-trip: `issueSession` → `verifySession` returns the email + a csrf; a tampered token → null. (Use the existing jose import pattern from `mcp-server/src/auth`.) Run → pass.
- [ ] **Step 3:** Commit: `git add mcp-server/src/admin/session.ts mcp-server/test/... && git commit -m "feat(admin): signed session cookie + CSRF helpers"`

---

## Task 5: admin Google login + requireAdmin middleware

**Files:** Create `mcp-server/src/admin/auth.ts`, `mcp-server/src/writePool.ts`.

- [ ] **Step 1:** `writePool.ts`: lazy `adminWritePool()` = `createPool(requireEnv("DATABASE_URL"))` (NOT readonly).
- [ ] **Step 2:** `auth.ts`:
  - `GET /admin/auth/login` → redirect to a Google auth URL whose `redirect_uri` is `${MCP_PUBLIC_URL}/admin/auth/callback` (build via google-auth-library `OAuth2Client(clientId, clientSecret, redirectUri).generateAuthUrl({ scope:["openid","email","profile"], state })`; state = a random nonce stored in a short cookie to prevent CSRF on login).
  - `GET /admin/auth/callback` → exchange the code (OAuth2Client with the same redirect), get the ID token, verify (`email_verified`, `isAllowedDomain` @mytime.mk), `lookupAuthorizedUser(adminWritePool(), email)`; if role==="admin" && active → `issueSession(email)` → set cookie → redirect `/admin`. Else 403 "Not authorized".
  - `GET /admin/auth/logout` → clear cookie → redirect to login.
  - `requireAdmin(req,res,next)` middleware: parse the cookie → `verifySession` → attach `req.adminEmail`+`req.csrf`; else redirect to `/admin/auth/login`.
- [ ] **Step 3:** Build clean. Commit: `git add mcp-server/src/admin/auth.ts mcp-server/src/writePool.ts && git commit -m "feat(admin): Google login session + requireAdmin"`

---

## Task 6: render helper + pages

**Files:** Create `mcp-server/src/admin/render.ts` and `mcp-server/src/admin/pages/{dashboard,users,recipients,settings,targets}.ts`.

- [ ] **Step 1:** `render.ts`: `esc(s)` (HTML-escape), `layout(title, bodyHtml, csrf?)` returns a full HTML page (nav to the 5 pages, minimal inline CSS, a flash-message slot). All user-supplied values rendered through `esc`.
- [ ] **Step 2:** Implement each page as `{ get(pool, req): Promise<string-html>, post?(pool, req): Promise<{redirect|error}> }`. Use the **write pool** for POSTs, read for GETs. CSRF: every POST verifies `req.body.csrf`. Concretely:
  - **users** — GET lists `authorized_users` (email, role, active); POST actions: upsert (email + role enum + active), delete. Validate email + role∈{admin,analyst,viewer}.
  - **recipients** — GET shows `getSetting(pool,"digest_recipients",[default])`; POST sets it (validate each is an email). `setSetting`.
  - **settings** — GET shows known settings (discount_threshold_pct, ad_results_limit, web_max_products, digest_enabled) from `allSettings` with defaults; POST validates numeric ranges/bool and `setSetting`s each. Label "applies next daily run".
  - **targets** — GET lists `targets` (id, name, web_url, social, active); POST edits a target's `web_url`/`social.{ig,fb,tiktok}`/`active`, add new, delete. Validate URL format. Writes update the `targets` row (so `loadTargetsFromDb` picks it up next run).
  - **dashboard** — counts (users, enabled targets, recipients) + links.
- [ ] **Step 3:** Each page: build, manual-render check (call `get` with a stub). Commit per page or as a group: `git add mcp-server/src/admin && git commit -m "feat(admin): render helper + config pages"`

---

## Task 7: router + mount + body parsing

**Files:** Create `mcp-server/src/admin/router.ts`; modify `mcp-server/src/server.ts`.

- [ ] **Step 1:** `router.ts`: an `express.Router()`; `router.use(express.urlencoded({ extended: false }))` for form posts; mount `/auth/*` (login/callback/logout, unguarded) and then `router.use(requireAdmin)` + the page routes (`GET /`, `GET/POST /users`, `/recipients`, `/settings`, `/targets`). Each route calls the page module, wraps in `layout`, sets flash on redirect.
- [ ] **Step 2:** In `server.ts`, before `return app`: `app.use("/admin", adminRouter());`. Ensure the admin router's own `urlencoded` parser doesn't conflict with the JSON parser on `/mcp` (it won't — scoped to the router).
- [ ] **Step 3:** Build clean; tsc clean; Biome. Commit: `git add mcp-server/src/admin/router.ts mcp-server/src/server.ts && git commit -m "feat(admin): mount /admin router"`

---

## Task 8: Google redirect URI, deploy, live verification

- [ ] **Step 1:** Add `https://mcp.mytimeprime.mk/admin/auth/callback` to the Google OAuth client's Authorized redirect URIs (USER action in Google Cloud Console — flag it).
- [ ] **Step 2:** Full build + Biome + tests: `corepack pnpm -r build && corepack pnpm --filter @mytime/ingestion test && corepack pnpm exec biome check` → green.
- [ ] **Step 3:** Deploy: git archive → VPS → `pnpm install --frozen-lockfile && pnpm -r build` (the app_settings/targets migration was already applied to Supabase in Task 1; the targets seed ran in Task 2) → `systemctl restart mytime-mcp`. Confirm `/admin/auth/login` redirects to Google (curl -I), and `/admin` without a session redirects to login.
- [ ] **Step 4:** **Live E2E (user + me):** user opens `https://mcp.mytimeprime.mk/admin`, logs in with `dragan@mytime.mk` (admin), loads each page; edits a setting + a recipient + toggles a target `active=false`; I confirm via DB that the change persisted and that `loadTargetsFromDb` omits the disabled target. Verify a non-admin/non-@mytime.mk is rejected.
- [ ] **Step 5:** Merge `feat/admin-panel` → main, push.

## Self-review notes (addressed)
- **Spec coverage:** app_settings + targets cols (T1); getSetting + targets DB seed/load (T2); ingestion DB targets (T3); session+CSRF (T4); Google login + admin gate + write pool (T5); pages (T6); router/mount (T7); redirect URI + deploy + E2E (T8). ✓
- **loadTargets refactor:** isolated to `loadTargetsFromDb` (new) + one ingestion call site; `loadTargets(path)`/`targetsFileSchema` reused for validation + seeding, not deleted. ✓
- **Security:** admin-only (Google domain + authorized_users admin), JWT HttpOnly/Secure/SameSite cookie, CSRF on every POST, write pool confined to admin routes, secrets not exposed. ✓
- **Type consistency:** `getSetting/setSetting/allSettings` (T2) used in pages (T6); `loadTargetsFromDb` (T2) used in T3; `issueSession/verifySession/requireAdmin` (T4/T5) used in router (T7). ✓
- **Deferred/uncertain:** the exact targets→row column mapping is finalized against the real `targets.json` in T2 (the schema-extension list in T1 covers platform/social/registry/locations; verify no other JSON field is load-bearing). `daily_run_time` is display-only (systemd timer) — surface in settings as read-only text, not an editable control.
