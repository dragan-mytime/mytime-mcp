# Subsystem C — Daily Competitor Digest (+ bilingual email)

**Date:** 2026-06-29
**Status:** Approved design (pre-implementation)
**Part of:** the original 3-subsystem expansion (A = validation/discounts — DONE; B = ad intelligence — DONE; **C = this**). A follow-on **Subsystem D — Admin Panel** is deferred (see end).

## Problem

We now capture rich competitor data daily (discounts, ads, social, inventory/velocity, prices) but there's no single "what are competitors up to today?" view. C produces a daily change-focused digest, available **on demand in Claude.ai** and **emailed bilingually each morning**.

## Decisions (locked during brainstorming)

- **Primary delivery:** a `daily_digest` MCP tool returning **structured day-over-day deltas**; **Claude narrates** it in chat (in English or Macedonian — narration language is the user's choice, free with Claude).
- **Content:** all signals, **change-focused** (what's new vs the prior snapshot), not a static dump.
- **Generation:** deterministic SQL for the structured data. **No LLM in the read path.** Gemini is used **only** to render the *email* prose.
- **Email:** ADD bilingual (English + Macedonian) email. Triggered **both** automatically (daily, after the 03:15 run) **and** on-demand. Sent via **Resend**. Recipients in **env for now** (Subsystem D will migrate config to a DB settings table).

## Architecture & components

A single shared computation feeds both the tool and the email so the numbers always match.

```
                        ┌─ daily_digest MCP tool ──→ structured JSON ──→ Claude narrates (EN/MK)
dailyDigest(db, opts) ──┤
  (db/src/digest.ts)    └─ email job ─→ Gemini renders EN+MK prose ─→ HTML ─→ Resend ─→ recipients
```

### Components (each independently testable)

- **`db/src/digest.ts`** — `dailyDigest(db, { competitor?, days? })`: the shared, deterministic change-detection queries. Lives in `@mytime/db` so BOTH `mcp-server` (tool) and `ingestion` (email job) import it. Uses `db.execute(sql\`…\`)` (drizzle), matching the repo's query style. Returns the structured digest (shape below).
- **`mcp-server/src/tools/index.ts`** — `daily_digest` tool (role **analyst**), `inputSchema { competitor?, days?, email? }`. Returns the structured digest. When `email: true` (role **admin** required for that branch), it also triggers the email send.
- **`ingestion/src/digest/render.ts`** — `renderDigestEmail(digest)`: calls **Gemini** to produce EN + MK narrative, wraps in a simple HTML email (EN section, then MK section). Falls back to a deterministic template if `GEMINI_API_KEY` is absent or Gemini fails (so email never silently breaks).
- **`ingestion/src/digest/send.ts`** — `sendDigestEmail(html, subject)`: POSTs to the Resend API (`RESEND_API_KEY`), `from = DIGEST_FROM`, `to = DIGEST_RECIPIENTS` (CSV).
- **`ingestion/src/digest/job.ts`** — `runDigestEmail(db)`: `dailyDigest → render → send`; logs to `ingestion_runs`. Called as the **final phase of the daily run** (after all collectors) in `ingestion/src/index.ts`, gated on `RESEND_API_KEY`. Also exposed as a CLI: root script `"digest:email": "node ingestion/dist/digest/cli.js"` for on-demand sends from the server.

### Change-detection (per competitor, day-over-day per source)

Each source is diffed against ITS OWN two most recent `captured_date`s (sources have independent dates). Graceful when only one day exists ("no prior day").

- **Sales campaigns** (`prices`): products newly discounted today (discount_pct>0 today, not on the prior date), campaigns ended, count on-sale today vs prior, avg %.
- **Ads** (`ad_observations`): new ads (archive_id today, absent prior), stopped ads, longest-running ad, active-count delta.
- **Social** (`social_metrics`): follower delta per platform (today − prior).
- **Inventory/demand** (`inventory_snapshots` + the existing velocity logic in `mcp-server/analytics`): new products (first-seen today), new stockouts (in_stock→out), fastest-depleting items, notable price moves (|Δ| over a threshold, e.g. ≥5% — pinned in the plan).

## Structured output shape

```jsonc
{
  "generated_for": "2026-06-29",
  "note": "Day-over-day competitor changes. Discount/velocity figures are estimates.",
  "competitors": [
    {
      "target_id": "b-watch",
      "sales": { "newly_discounted": 12, "ended": 3, "on_sale_today": 1095, "avg_pct": 22.4, "samples": [/* {name, was, now, pct} */] },
      "ads":   { "active_today": 16, "new": [/* {ad_title, link_url, days_running, snapshot_url} */], "stopped_count": 2, "longest_running": { "days_running": 52, "ad_title": "…" } },
      "social":{ "followers": { "instagram": 213, "facebook": -40 } },
      "inventory": { "new_products": 7, "new_stockouts": [/* names */], "top_velocity": [/* {name, est_units} */], "price_moves": [/* {name, from, to} */] }
    }
  ]
}
```

## Email rendering & sending

- **Render:** `renderDigestEmail` sends the structured digest to **Gemini** (`gemini-2.5-flash`) with a prompt to produce a concise competitor-briefing in **English**, then again (or in one call) in **Macedonian**. Output assembled into one HTML email: a header, the **EN** briefing, a divider, the **MK** briefing. Deterministic-template fallback covers Gemini being unavailable.
- **Send:** `sendDigestEmail` → Resend `POST /emails` with `from`, `to`, `subject` (e.g. `MY:TIME — Конкурентски дневен преглед / Daily competitor digest (2026-06-29)`), `html`.
- **New env:** `RESEND_API_KEY`, `DIGEST_FROM` (e.g. `MY:TIME BI <digest@mytimeprime.mk>`), `DIGEST_RECIPIENTS` (default `dragan@mytime.mk`, CSV). `GEMINI_API_KEY` already exists.
- **Resend domain verification (one-time setup):** verify `mytimeprime.mk` as a sending domain — add the DKIM/SPF (and return-path) DNS records Resend provides, via the **Cloudflare API** (we control that DNS) or manually. The user creates `RESEND_API_KEY`.

## Triggers

- **Auto-daily:** `runDigestEmail(db)` runs as the final phase of `ingestion/src/index.ts` (after collectors), gated on `RESEND_API_KEY`, failure-isolated + logged to `ingestion_runs`. Reuses the existing `mytime-ingest.timer` (no new timer).
- **On-demand:** the `daily_digest` MCP tool with `email: true` (admin) triggers a send from Claude.ai; plus `pnpm digest:email` CLI on the server.

## Testing

- **`dailyDigest`** — verified against the **live DB**: each signal group returns sensible day-over-day deltas (consistent with how the existing analytics tools were validated; mcp-server has no unit-test harness). Unit-test any pure shaping/threshold helpers where practical (ingestion has Vitest).
- **Email** — `renderDigestEmail` tested against a sample structured digest (asserts EN+MK sections present, no throw on the fallback path). `sendDigestEmail` validated by sending **one real digest** to the recipient and confirming it arrives bilingual.
- `pnpm -r build` + Biome clean.

## Scope / YAGNI

- **No new schema** — reuses existing tables. The digest is computed on demand (not stored — deferred Approach 3).
- **Gemini only for email prose** — the tool stays deterministic + Claude-narrated.
- Recipients/config in **env for now** (Subsystem D migrates to a DB settings table).
- No new timer; reuse `mytime-ingest.timer`.

## Success criteria

1. `daily_digest` MCP tool returns structured day-over-day deltas per competitor; Claude narrates it (EN or MK) and can drill in.
2. The daily run emails a bilingual (EN+MK) digest via Resend to the configured recipients; `email: true` triggers it on demand.
3. Live-verified: the digest reflects real changes (e.g. b-watch new ads, saat-saat discounts), and a real email arrives readable in both languages.
4. Build + Biome clean; email path fails gracefully (isolated, logged) and never aborts the ingest run.

## Deferred — Subsystem D (Admin Panel)

A web admin panel to manage configurable state (roles in `authorized_users`, digest recipients, other variables) without SSH/Supabase editing. Its core is a **writable `settings`/config DB table** that env/file config migrates into, plus an auth-gated UI + endpoints reusing Google OAuth + the `authorized_users` allowlist, hosted on the existing VPS/nginx. Separate brainstorm → spec → plan → build after C.
