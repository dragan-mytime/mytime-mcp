# Subsystem A — Data Validation + Discount-Capture Fix

**Date:** 2026-06-29
**Status:** Approved design (pre-implementation)
**Part of:** a 3-subsystem expansion (A = this; B = Meta Ad Library; C = daily competitor digest). A is built first because the digest (C) depends on accurate discount/promo data.

## Problem

A spot-check (user noticed Saat&Saat showing no discounts despite live promos) revealed a **systemic** gap, not a single-site bug. Discount/sale-price capture works only for MY:TIME (the Adform XML feed); **every scraped competitor captures zero discounts**:

| Competitor | Products | With discount | With sale price |
|---|---|---|---|
| mytime (own feed) | 5,873 | 364 | 364 |
| b-watch | 2,859 | 0 | 0 |
| bozinovski | 2,762 | 0 | 0 |
| hronometar | 724 | 0 | 0 |
| saat-saat | 2,582 | 0 | 0 |
| swarovski | 84 | 0 | 0 |
| zia | 985 | 0 | 0 |

Confirmed root cause for the JSON-LD path: `ingestion/src/sources/web-jsonld.ts` calls `deriveDiscount(price, null)` — it reads a single displayed price and hard-passes `null` as the sale price, so a discount can never be detected. Other collectors have analogous gaps (they read one price, never the original/struck price).

This undermines the core competitive-intelligence value (pricing + promo tracking) and directly blocks Subsystem C's "current sales campaigns" section.

## Goals

1. **Detect** mismatches between ingested data and live competitor sites — across **all** product fields, not just discounts.
2. **Correct** the confirmed issues at the collector root cause, then re-run today's ingestion.
3. Leave behind a **reusable validator** that can be re-run after fixes and periodically (manual run; not scheduled in this subsystem).

## Decisions (locked during brainstorming)

- **Field scope:** validate *everything* — commercial (price, sale price/discount, stock) **and** descriptive (name, brand, category, model_ref, attributes).
- **Form:** reusable validator module (run now and re-run after fixes / periodically). Not auto-scheduled.
- **Ground-truth method (hybrid of bespoke + LLM):**
  - **Per-site bespoke verifiers** are the primary deterministic ground truth.
  - A **generic LLM cross-check** runs on the same fetched page as a **drift detector** — when the LLM's read diverges from the deterministic verifier, that signals the site changed its layout and the verifier/collector needs adapting. So the run yields two signals: **data mismatches** (verifier vs DB) and **structure drift** (verifier vs LLM).
- **Correction semantics:** fix the root cause in each affected collector (so all future daily runs are correct), then re-run today's ingestion (idempotent) to overwrite today's rows. Historical rows left as-is (no archived pages to backfill from).

## Architecture & data flow

New module `ingestion/src/validation/`, runnable via a CLI (mirrors `pnpm ingest`).

```
sample N products/site (from DB, latest captured_date)
   └─ for each product URL:
        fetch live page ONCE (FireCrawl render)        ← shared fetch
            ├─ per-site VERIFIER (deterministic)  → ground-truth snapshot
            └─ LLM cross-check (generic)          → independent snapshot
        diff verifier ⇄ DB row     → DATA MISMATCH report
        diff verifier ⇄ LLM        → STRUCTURE DRIFT report
   └─ aggregate → report file (markdown + JSON)
```

### Components (each independently testable)

- **`fetch.ts`** — single FireCrawl-render fetch per product, shared by the verifier and the LLM check (one fetch paid per product).
- **`verifiers/<site>.ts`** — bespoke per-competitor extractors returning a normalized snapshot (price, original/sale price, stock, name, brand, category, model_ref, attributes). Routed by target id / `web.platform`, like the collectors.
- **`llm-check.ts`** — generic LLM extraction of the same fields from the fetched page; used only as a drift signal, never as the source of truth.
- **`diff.ts`** — field-by-field comparison with per-field rules (below). Produces structured mismatch + drift records.
- **`report.ts`** — writes `docs/validation/YYYY-MM-DD-validation.md` and a sibling `.json`.
- **`run.ts`** — CLI entrypoint with `VALIDATE_SAMPLE` (sample size) and an optional site filter (same shape as `INGEST_TARGETS`).

## The discount fix (correction) — per-site hypotheses

The validator proves the gap; then fix each collector at the root and verify by re-running the validator's sample for that site.

- **woocommerce** (b-watch, bozinovski, watch-club) — WC Store API returns `prices.regular_price` **and** `prices.sale_price`; the collector currently ignores `sale_price`. Highest-confidence fix.
- **web-jsonld** (saat-saat, swarovski/royalhouse) — read both prices from JSON-LD `priceSpecification` / multiple offers, plus the existing OG `product:sale_price:amount` path; stop hard-passing `null`.
- **zia** — JSON API almost certainly exposes original + discounted fields; map them.
- **hronometar** (nopCommerce) — old/new price on the product page.
- **pandora** (Magento) — regular/special price.

After fixes: one full `pnpm ingest` overwrites today's rows with corrected values (idempotent per `captured_date`).

## Field comparison rules

- **price** — numeric comparison with a small tolerance for rounding/formatting.
- **sale_price / discount_pct** — presence + value, exact (this is the headline check).
- **stock** — exact (in/out; exact count where a site exposes one).
- **descriptive** (name, brand, category, model_ref, attributes) — normalized/fuzzy comparison; surfaced as **"review"** items, never hard-fail. This is where the LLM cross-check is most useful.

## Sampling

- Default **25 products per site**, i.e. ~25 × the scraped competitor sites (≈8 competitors → ~200 live fetches/run). Configurable via `VALIDATE_SAMPLE`. Only sites with rows on the latest `captured_date` are sampled.
- Sample biased to include likely-on-sale items where detectable from existing data, otherwise random, so discount checks aren't wasted on full-price items.

## Testing

- Each `verifiers/<site>.ts` unit-tested against **saved HTML fixtures** (committed), so tests need no live network/FireCrawl calls.
- `diff.ts` unit-tested with synthetic snapshot pairs covering: clean match, price drift within/over tolerance, missing discount, stock mismatch, descriptive fuzz.

## Scope / YAGNI

- **Manual run only** — not wired to a timer in this subsystem (per the chosen "reusable, not scheduled" option).
- **No `validation_runs` DB table** yet — reports are files. (Revisit if/when scheduling lands.)
- **Descriptive-field mismatches are advisory** — they flag for human review, they don't drive automated correction.
- Some sites had no rows on the latest `captured_date` (pandora, and possibly watch-club, were absent from the latest-day discount counts); investigate why as part of the run, but it's secondary to the discount fix.

## Success criteria

1. Running the validator produces a dated report listing data mismatches and drift signals per site, with live evidence (URL + extracted vs stored values).
2. After the collector fixes + re-ingest, a re-run shows competitor discount/sale-price capture is no longer uniformly zero (it reflects the live promos the user can see).
3. Verifiers have fixture-based tests; `diff.ts` has unit tests; `pnpm build` + Biome clean.
