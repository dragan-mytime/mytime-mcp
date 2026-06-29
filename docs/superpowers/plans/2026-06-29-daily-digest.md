# Daily Competitor Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `daily_digest` MCP tool returning structured day-over-day competitor changes (Claude narrates, EN/MK), plus an auto-daily + on-demand **bilingual email** (Gemini-rendered EN+MK, sent via Resend).

**Architecture:** A single shared `dailyDigest(db, opts)` in `@mytime/db` computes deterministic per-competitor deltas across four sources (sales, ads, social, inventory). The MCP tool returns that structure; an ingestion-side job renders it to EN+MK HTML via Gemini and sends it via Resend, both as the final phase of the daily run and on demand.

**Tech Stack:** Node 24/TS 6 (ESM/NodeNext), Drizzle (`db.execute(sql\`…\`)`), Vitest, Biome. Gemini (`GEMINI_API_KEY`, already set), Resend (`RESEND_API_KEY`, new).

---

## Verified facts (from the codebase)

- mcp-server analytics take a `pg Pool` (`@mytime/shared` `createPool`); ingestion uses drizzle `createDb` (`@mytime/db`) with `db.execute(sql\`…\`)`. **`dailyDigest` takes a drizzle `Db`** so both packages can use it (mcp-server adds a `readDb()` helper).
- Relevant columns: `products(id, target_id, name, brand, url)`; `prices(product_id, captured_date, price, sale_price, discount_pct)`; `inventory_snapshots(product_id, captured_date, stock_status, stock_quantity)`; `social_metrics(social_account_id, captured_date, metric, value)` + `social_accounts(id, target_id, platform)`; `ad_observations(target_id, captured_date, ad_archive_id, days_running, ad_title, link_url, snapshot_url)`.
- "Day-over-day per source" = each source's two most recent **distinct** `captured_date`s (they differ across sources). Degrade gracefully when only one date exists.
- MCP tool shape: `McpToolDef { name, title, description, requiredRole, inputSchema (zod), run: (pool, args) => fn }` in `mcp-server/src/tools/index.ts`. `z` already imported.
- `logger`, `optionalEnv`, `requireEnv` from `@mytime/shared`; `recordRun` from `@mytime/db`. The Gemini call pattern already exists at `ingestion/src/validation/llm-check.ts` (reuse its fetch shape).

## File structure

```
db/src/digest.ts                 # dailyDigest(db, opts) — shared change-detection queries + DigestResult type
db/src/index.ts                  # export digest
mcp-server/src/db.ts             # + readDb() (drizzle, readonly)
mcp-server/src/tools/index.ts    # + daily_digest tool
ingestion/src/digest/render.ts   # renderDigestEmail(digest) -> { subject, html } via Gemini (+ template fallback)
ingestion/src/digest/send.ts     # sendDigestEmail({subject, html}) via Resend
ingestion/src/digest/job.ts      # runDigestEmail(db) = dailyDigest -> render -> send (+ recordRun)
ingestion/src/digest/cli.ts      # CLI entry for `pnpm digest:email`
ingestion/src/index.ts           # + final digest-email phase
ingestion/test/digest/*.test.ts  # render fallback + shaping tests
.env.example / package.json      # env + script
```

---

## Task 1: `dailyDigest` shared computation

**Files:** Create `db/src/digest.ts`; export from `db/src/index.ts`.

- [ ] **Step 1:** Create `db/src/digest.ts`. Define the result types and the function. Use `db.execute(sql\`…\`)` and read `(r.rows ?? r)`. Helper to get a source's latest two dates:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "./client.js"; // the type createDb returns — confirm the export name; else: type Db = ReturnType<typeof createDb>

export interface CompetitorDigest {
  targetId: string;
  sales: { newlyDiscounted: number; ended: number; onSaleToday: number; avgPct: number | null;
    samples: { name: string; was: number | null; now: number | null; pct: number | null }[] };
  ads: { activeToday: number; new: { adTitle: string | null; linkUrl: string | null; daysRunning: number | null; snapshotUrl: string | null }[];
    stoppedCount: number; longestRunning: { daysRunning: number | null; adTitle: string | null } | null };
  social: { followers: Record<string, number> };
  inventory: { newProducts: number; newStockouts: string[];
    priceMoves: { name: string; from: number; to: number }[] };
}
export interface DigestResult {
  generatedFor: string;
  note: string;
  competitors: CompetitorDigest[];
}

const rows = <T>(r: { rows?: T[] } | T[]): T[] => (Array.isArray(r) ? r : (r.rows ?? []));
```

Then implement `dailyDigest(db, { competitor }: { competitor?: string; days?: number } = {})`. For each signal use a CTE that picks the source's two latest dates and diffs them, grouped by `target_id`. Write these four queries (each returns rows keyed by target_id), then assemble per competitor.

**Sales** (per target): newly discounted = products discounted on the latest prices date but not on the prior; ended = opposite; counts + avg pct today; 5 samples.
```ts
const salesQ = await db.execute(sql`
  with d as (select distinct captured_date from prices order by captured_date desc limit 2),
       today as (select min(captured_date) c from (select captured_date from d order by captured_date desc limit 1) x),
       prior as (select max(captured_date) c from (select captured_date from d order by captured_date asc limit 1) x),
       cur as (select pr.target_id, p.product_id, pr.name, p.price::float8 price, p.sale_price::float8 sale, p.discount_pct::float8 pct
               from prices p join products pr on pr.id=p.product_id
               where p.captured_date=(select c from today)),
       prev as (select p.product_id, p.discount_pct::float8 pct
                from prices p where p.captured_date=(select c from prior))
  select c.target_id,
    count(*) filter (where c.pct>0)::int as on_sale_today,
    round(avg(c.pct) filter (where c.pct>0)::numeric,1)::float8 as avg_pct,
    count(*) filter (where c.pct>0 and coalesce(pv.pct,0)=0)::int as newly_discounted,
    count(*) filter (where coalesce(c.pct,0)=0 and pv.pct>0)::int as ended
  from cur c left join prev pv on pv.product_id=c.product_id
  ${competitor ? sql`where c.target_id=${competitor}` : sql``}
  group by c.target_id`);
```
(Adapt the `today`/`prior` CTEs to the simplest correct form — the intent: today = latest prices date, prior = the date before it. A clean version: `with dd as (select distinct captured_date from prices order by 1 desc limit 2)` then `today=(select max from dd)`, `prior=(select min from dd)`.) Add a small follow-up query for up to 5 newly-discounted **samples** per competitor (name, was=price, now=sale, pct).

**Ads** (per target, from `ad_observations`, latest two captured_dates):
```ts
const adsQ = await db.execute(sql`
  with dd as (select distinct captured_date from ad_observations order by 1 desc limit 2)
  select target_id,
    count(*) filter (where captured_date=(select max(captured_date) from dd))::int as active_today,
    max(days_running) filter (where captured_date=(select max(captured_date) from dd))::int as longest_days
  from ad_observations ${competitor ? sql`where target_id=${competitor}` : sql``}
  group by target_id`);
```
Plus: **new ads** = `ad_archive_id` on the latest date not present on the prior date (left join), returning up to 5 `{adTitle, linkUrl, daysRunning, snapshotUrl}`; **stoppedCount** = ids on prior not on latest; **longestRunning** = the ad row with max days_running today.

**Social** (per target+platform delta):
```ts
const socialQ = await db.execute(sql`
  with dd as (select distinct captured_date from social_metrics where metric='followers' order by 1 desc limit 2)
  select sa.target_id, sa.platform,
    max(sm.value::float8) filter (where sm.captured_date=(select max(captured_date) from dd))
      - max(sm.value::float8) filter (where sm.captured_date=(select min(captured_date) from dd)) as delta
  from social_metrics sm join social_accounts sa on sa.id=sm.social_account_id
  where sm.metric='followers' ${competitor ? sql`and sa.target_id=${competitor}` : sql``}
  group by sa.target_id, sa.platform`);
```

**Inventory** (per target, latest two inventory dates): newProducts = products whose first-ever prices/inventory date is the latest date; newStockouts = product in_stock on prior date, out_of_stock on latest (join + names, up to 8); priceMoves = products whose `price` changed > 5% between the two latest prices dates (up to 8, `{name, from, to}`). Write these as 2–3 focused queries.

Assemble all rows into `DigestResult` keyed by target_id (only competitors with any signal). Return `{ generatedFor: <latest prices date or today>, note: "Day-over-day competitor changes. Discount/velocity figures are estimates.", competitors }`.

- [ ] **Step 2:** Export from `db/src/index.ts` (`export * from "./digest.js";`).
- [ ] **Step 3:** `corepack pnpm --filter @mytime/db build` → clean.
- [ ] **Step 4:** **Live sanity check**: throwaway `db/_chk.mjs` importing `createDb` + `dailyDigest` from `./dist/...`, run `node --env-file=.env db/_chk.mjs`, print `JSON.stringify(await dailyDigest(createDb(process.env.DATABASE_URL)), null, 2)`. Confirm competitors with real deltas appear (b-watch ads/sales, saat-saat). Delete the script. Paste the b-watch block.
- [ ] **Step 5:** Commit: `git add db/src/digest.ts db/src/index.ts && git commit -m "feat(db): dailyDigest day-over-day change detection"`

> Note for implementer: keep each source's query readable and independently correct. If a `today/prior` CTE is awkward, compute the two dates in JS first (`select distinct captured_date … limit 2`) and pass them as params. Prefer correctness + clarity over one giant query.

---

## Task 2: `readDb()` + `daily_digest` MCP tool (structured only)

**Files:** Modify `mcp-server/src/db.ts`, `mcp-server/src/tools/index.ts`.

- [ ] **Step 1:** In `mcp-server/src/db.ts` add a drizzle accessor next to `readPool`:
```ts
import { createDb } from "@mytime/db";
let db: ReturnType<typeof createDb> | undefined;
export function readDb(): ReturnType<typeof createDb> {
  if (!db) db = createDb(optionalEnv("DATABASE_URL_READONLY") ?? requireEnv("DATABASE_URL"));
  return db;
}
```
- [ ] **Step 2:** Register the tool in `tools/index.ts` (import `dailyDigest` from `@mytime/db`, `readDb` from `../db.js`):
```ts
{
  name: "daily_digest",
  title: "Daily competitor digest (day-over-day changes)",
  description:
    "What competitors did since the last snapshot: new/ended sales campaigns, new/stopped ads + long-runners, follower moves, new products/stockouts/price moves. Structured data — narrate it (the user may ask in English or Macedonian). Figures are estimates.",
  requiredRole: "analyst",
  inputSchema: {
    competitor: z.string().optional().describe("target id; omit for all"),
    email: z.boolean().optional().describe("admin only: also send the digest email now"),
  },
  run: async (_pool, a, ctx) => {
    const args = a as { competitor?: string; email?: boolean };
    const digest = await dailyDigest(readDb(), { competitor: args.competitor });
    // email branch handled in Task 6 (needs the email modules); for now ignore args.email
    return digest;
  },
},
```
(Match the EXACT `run` signature used by other tools — if they are `(pool, a) => fn(...)` without a `ctx`, drop `ctx` here; the email branch in Task 6 will adapt. Check `McpToolDef` in `mcp-server/src/tools/_tool.ts`.)
- [ ] **Step 3:** `corepack pnpm --filter @mytime/mcp-server build` clean; tsc clean. Verify via a throwaway script calling the tool's `run` (or `dailyDigest(readDb(),{})`) returns data. Biome write.
- [ ] **Step 4:** Commit: `git add mcp-server/src/db.ts mcp-server/src/tools/index.ts && git commit -m "feat(mcp): daily_digest tool + readDb"`

---

## Task 3: email rendering (Gemini, EN+MK) + fallback (TDD)

**Files:** Create `ingestion/src/digest/render.ts`; test `ingestion/test/digest/render.test.ts`.

- [ ] **Step 1:** Failing test — `renderDigestEmail` must return `{ subject, html }` with both an English and a Macedonian section, and must NOT throw when Gemini is unavailable (fallback). Build a small fake `DigestResult` inline; call `renderDigestEmail(digest)` with `GEMINI_API_KEY` unset (force fallback) and assert the html contains the competitor id and both an `English`/`Macedonian` marker the template emits. Run → FAIL.
- [ ] **Step 2:** Implement `ingestion/src/digest/render.ts`:
  - `templateDigest(digest, lang)` — a deterministic, dependency-free renderer producing readable HTML for one language (headers + per-competitor bullet lines from the structured fields). Used as the fallback and as the structure Gemini is asked to polish.
  - `geminiNarrate(digest, lang)` — POST to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=…` (copy the request shape from `ingestion/src/validation/llm-check.ts`), prompt: "Write a concise competitor-intelligence briefing in <English|Macedonian> from this JSON; short sections per competitor; plain HTML, no markdown fences." Return the HTML text, or `null` on any failure.
  - `renderDigestEmail(digest)`: for each of `["English","Macedonian"]`, use `geminiNarrate ?? templateDigest`. Assemble one HTML doc: title + the EN block + `<hr>` + the MK block. `subject = \`MY:TIME — Дневен преглед / Daily digest (\${digest.generatedFor})\``. Returns `{ subject, html }`. Reads `GEMINI_API_KEY` via `optionalEnv` (skip Gemini if absent → template).
- [ ] **Step 3:** Test → PASS. tsc clean; Biome write.
- [ ] **Step 4:** Commit: `git add ingestion/src/digest/render.ts ingestion/test/digest/render.test.ts && git commit -m "feat(digest): bilingual email render (Gemini + template fallback)"`

---

## Task 4: Resend sender

**Files:** Create `ingestion/src/digest/send.ts`.

- [ ] **Step 1:** Implement:
```ts
import { optionalEnv, requireEnv } from "@mytime/shared";

export async function sendDigestEmail(mail: { subject: string; html: string }): Promise<void> {
  const key = requireEnv("RESEND_API_KEY");
  const from = optionalEnv("DIGEST_FROM") ?? "MY:TIME BI <digest@mytimeprime.mk>";
  const to = (optionalEnv("DIGEST_RECIPIENTS") ?? "dragan@mytime.mk").split(",").map((s) => s.trim());
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: mail.subject, html: mail.html }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
```
- [ ] **Step 2:** tsc clean; Biome. Commit: `git add ingestion/src/digest/send.ts && git commit -m "feat(digest): Resend email sender"`

---

## Task 5: digest job + CLI

**Files:** Create `ingestion/src/digest/job.ts`, `ingestion/src/digest/cli.ts`; modify root `package.json`.

- [ ] **Step 1:** `job.ts`:
```ts
import { createDb, dailyDigest, recordRun, type Db } from "@mytime/db";
import { logger, requireEnv } from "@mytime/shared";
import { renderDigestEmail } from "./render.js";
import { sendDigestEmail } from "./send.js";

export async function runDigestEmail(db: Db = createDb(requireEnv("DATABASE_URL"))): Promise<void> {
  const runDate = new Date().toISOString().slice(0, 10);
  const startedAt = new Date();
  try {
    const digest = await dailyDigest(db);
    await sendDigestEmail(renderDigestEmail ? await renderDigestEmail(digest) : { subject: "", html: "" });
    await recordRun(db, { runDate, collector: "digest-email", targetId: null, status: "success", rowsWritten: digest.competitors.length, startedAt });
    logger.info({ competitors: digest.competitors.length }, "digest email sent");
  } catch (err) {
    await recordRun(db, { runDate, collector: "digest-email", targetId: null, status: "failed", rowsWritten: 0, error: err instanceof Error ? err.message : String(err), startedAt }).catch(() => {});
    logger.error({ err }, "digest email failed (isolated)");
  }
}
```
(Confirm `Db` is exported from `@mytime/db`; if not, import `createDb` and use its return type.)
- [ ] **Step 2:** `cli.ts`: `import { runDigestEmail } from "./job.js"; runDigestEmail().then(() => process.exit(0));`
- [ ] **Step 3:** Root `package.json` scripts: `"digest:email": "node ingestion/dist/digest/cli.js"`.
- [ ] **Step 4:** Build. Commit: `git add ingestion/src/digest/job.ts ingestion/src/digest/cli.ts package.json && git commit -m "feat(digest): email job + CLI"`

---

## Task 6: wire auto-daily + tool email branch

**Files:** Modify `ingestion/src/index.ts` and `mcp-server/src/tools/index.ts`.

- [ ] **Step 1:** In `ingestion/src/index.ts`, after the own-brand Meta block and before the final `logger.info(... "ingestion run complete")`, add (gated on `RESEND_API_KEY`):
```ts
// ── Daily digest email (Subsystem C) — final phase ──
if (optionalEnv("RESEND_API_KEY")) {
  await runDigestEmail(db).catch((err) => logger.error({ err }, "digest phase error"));
}
```
Import `runDigestEmail` from `./digest/job.js`.
- [ ] **Step 2:** In `tools/index.ts`, implement the `email: true` branch: when set, require admin role (use the same role-check the registry/`requireRole` uses — see how `list_authorized_users` enforces admin; if role is on `ctx.authInfo`, gate there) and call the email path. Since the MCP server can't import ingestion, move `renderDigestEmail`+`sendDigestEmail` usage by adding a tiny `mcp-server`-local sender OR (simpler) keep on-demand email as the **CLI only** and have the tool return a note `"email: run `pnpm digest:email` on the server"`. **Decision: keep the tool read-only; drop the in-tool send to avoid a mcp-server→email dependency.** Update the tool's `inputSchema` to remove `email`, and document that on-demand sending is `pnpm digest:email`. (This keeps the MCP server free of outbound-email side effects.)
- [ ] **Step 3:** Build all; tsc clean; Biome. Commit: `git add ingestion/src/index.ts mcp-server/src/tools/index.ts && git commit -m "feat(digest): auto-daily email phase; on-demand via CLI"`

---

## Task 7: env, Resend domain, live email test

**Files:** Modify `.env.example`; operational setup.

- [ ] **Step 1:** `.env.example`: add `RESEND_API_KEY=`, `DIGEST_FROM=MY:TIME BI <digest@mytimeprime.mk>`, `DIGEST_RECIPIENTS=dragan@mytime.mk`.
- [ ] **Step 2:** **Resend setup (controller/user):** user creates `RESEND_API_KEY` and adds a sending domain `mytimeprime.mk` in Resend → Resend shows DKIM/SPF/return-path DNS records → add them in Cloudflare (via API with a scoped token, or the user pastes them). Wait for "Verified". Put `RESEND_API_KEY` in local `.env` and the VPS `.env`.
- [ ] **Step 3:** **Live test:** `corepack pnpm --filter @mytime/ingestion build && pnpm digest:email`. Confirm the email arrives at `dragan@mytime.mk` with both an English and a Macedonian section. (If Resend domain isn't verified yet, Resend's onboarding domain can be used for a first test to `dragan@mytime.mk`.)
- [ ] **Step 4:** Commit `.env.example`.

---

## Task 8: full verification

- [ ] **Step 1:** `corepack pnpm -r build && corepack pnpm --filter @mytime/ingestion test && corepack pnpm exec biome check` → green.
- [ ] **Step 2:** Confirm `daily_digest` tool returns real data (b-watch/saat-saat deltas) and `pnpm digest:email` sends a bilingual email. Paste the digest's b-watch block + confirm email receipt.
- [ ] **Step 3:** (Deploy is a separate step after merge — ship to VPS, add `RESEND_API_KEY` to VPS `.env`, rebuild, restart `mytime-mcp`; the daily run then emails automatically.)

## Self-review notes (addressed)
- **Spec coverage:** dailyDigest (T1), tool (T2), render EN+MK (T3), Resend (T4), job+CLI (T5), auto-daily phase (T6), env+domain+live test (T7), verify (T8). ✓
- **Scope correction:** the spec's in-tool `email:true` (admin) is **dropped** in T6 to avoid a mcp-server→outbound-email dependency; on-demand send is the `pnpm digest:email` CLI. (Cleaner; the auto-daily + CLI still satisfy "both triggers." Flag this change to the user.)
- **Type consistency:** `DigestResult`/`CompetitorDigest` (T1) used by tool (T2), render (T3), job (T5). `renderDigestEmail`→`{subject,html}`→`sendDigestEmail` consistent. ✓
- **Placeholders:** SQL is real (adapt the today/prior CTE to the clean `distinct … limit 2` form noted); no TBDs. The Gemini request shape is "copy from llm-check.ts" — a real, existing reference. ✓
