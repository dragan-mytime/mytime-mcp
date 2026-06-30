# Cross-vendor SKU matching + head-to-head price comparison

**Date:** 2026-06-30
**Status:** Approved (build), iterate on production
**Area:** `ingestion/src/pipeline/normalize.ts` + per-vendor collectors, a backfill, and a new
`compare_skus` MCP tool (`mcp-server/src/tools`).

## Problem

There is no way to ask "which products does competitor X also carry, and how do our prices
compare?" — the MCP has no tool for it, and the underlying match key (`products.model_ref`) is
populated inconsistently, so even a direct join is weak:

- **Bozinovski / Watch Club**: `model_ref` is the URL **slug** (a slugified product *name*, e.g.
  `CARSON-4`, `PIERRE-CARDIN-CF-1019-LB-1`) — not the manufacturer reference.
- **MY:TIME (self)**: `parseModelFromName` only captures a code when the name *starts* with it.
  Casio is stored as `Casio Timeless A168WA-1W …` (code mid-string) → missed. This is why
  MY:TIME↔B-Watch matched only 1 SKU despite both carrying ~190/175 Casios.
- Where references are clean on both sides (Saat&Saat, Hronometar), matching already works after
  light normalization (88 and 66 matched SKUs respectively) — proving the approach.

The manufacturer reference *is* present, just in different fields per vendor:

| Vendor | Best source for the reference |
|---|---|
| Bozinovski | the WooCommerce **`sku`** (already stored as `external_id`; ~80% are real, e.g. `H76615130`, `CAW211P.FC6356`) |
| Watch Club | the trailing code in the **product name** (`CF.1019.LB.1`) — the slug is brand+name |
| B-Watch | already clean in `model_ref` (slug == ref, e.g. `A168WA-1W`) |
| Saat&Saat / Hronometar | already clean (name/page code) |
| MY:TIME | a code **anywhere** in the name (not only leading) |

## Solution

### 1. Shared reference + match helpers (`normalize.ts`)

- **`parseModelRef(name, sku, slug)`** — returns the best manufacturer reference:
  1. `sku` when it looks like a real reference (contains both a letter and a digit, or is a long
     digit/punct code; length ≥ 5; not a pure DB id),
  2. else the first manufacturer-code token found **anywhere** in `name`
     (`/[A-Z]{0,4}[0-9][A-Z0-9]*[.\-/][A-Z0-9.\-/]+|[A-Z]{2,}[0-9]{3,}/i`-style — a token mixing
     letters+digits with optional dot/dash separators, length ≥ 5),
  3. else the `slug` (trimmed), 4) else null.
- **`normalizeModelKey(ref)`** — the match key: uppercase, strip every non-alphanumeric
  (`A168WA-1W` and `A168WA.1W` → `A168WA1W`). Returns null for keys shorter than 5 alphanumerics
  (too noisy to match on).
- **`brandMatchKey(brand, name)`** — normalize for brand-aware matching: uppercased brand with the
  Casio sub-lines collapsed (`CASIO TIMELESS` / `CASIO VINTAGE` → `CASIO`), and a boolean
  `isGShock` derived from brand/name containing `G-SHOCK` / `GSHOCK` / `G SHOCK`.

All pure, unit-tested.

### 2. Per-vendor wiring (route every collector through `parseModelRef`)

- **woocommerce.ts** (B-Watch, Bozinovski, Watch Club): `modelRef = parseModelRef(name, sku, slug)`
  where `sku = p.sku`, `slug = p.slug`. Bozinovski gains the real SKU; Watch Club gains the
  name-code; B-Watch is unchanged in practice (slug already wins via the name/slug fallback).
- **mytime-feed.ts** (self): `modelRef = parseModelRef(name, it.sku ?? null, null)` — fixes the
  mid-string Casio codes.
- **web-jsonld.ts** (saat-saat), **hronometar.ts**, **zia.ts**, **pandora.ts**: route their
  existing name/code through `parseModelRef(name, sku?, slug?)` for one consistent extractor. These
  already produce good refs; this keeps them identical or slightly better, never worse.

### 3. Backfill (`db/scripts/backfill-model-ref.mjs`) — no re-scrape

Re-derive `model_ref` in place from data already stored (`name`, `external_id` = sku, current
`model_ref` = slug for woo) using the same `parseModelRef`. Dry-run/`--apply`, idempotent, only
updates rows whose recomputed ref differs and is non-null. This immediately widens overlap
(Bozinovski via stored sku, Watch Club via stored name, MY:TIME via mid-name codes).

### 4. New MCP tool `compare_skus` (analyst role)

- **Input:** `{ competitor?: string }` (a target id; omitted = run for every competitor).
- **Logic:** match active MY:TIME products to the competitor's active products on
  `normalizeModelKey(model_ref)` (≥ 5 chars). Disambiguate with `brandMatchKey`: a match is valid
  when the normalized brands are equal **or** one side has no brand (Bozinovski is mostly
  brand-null, but its SKUs are long/brand-encoded and unique enough). **Exclude G-Shock from Casio
  matches** (`isGShock` must agree) per the requirement. Compare the latest effective price
  (`sale_price ?? price`) on each side.
- **Output:** per competitor — match count, how many MY:TIME is cheaper/pricier/same, and the
  matched line items (ref, brand, name, MY:TIME price, competitor price, Δ%). Bounded (top N by
  absolute Δ) to keep the payload reasonable.
- Registered in `tools/index.ts`; reuses the read pool.

## Decisions / scope

- **No new column.** Improve `model_ref` population; normalize at query time
  (`regexp_replace(upper(model_ref),'[^A-Z0-9]','','g')`) in the tool. Proven to work; simplest.
- **Matching is intentionally conservative** (key length ≥ 5, brand-compatible, G-Shock split) to
  avoid false positives; some real pairs with messy refs will be missed — acceptable for v1.
- **YAGNI:** no fuzzy/name-similarity matching, no new persisted match table, no UI — the tool
  returns data the connector renders. Pandora/Swarovski (sparse refs) will simply match little.

## Testing

- Unit: `parseModelRef` (sku-first, mid-name code, slug fallback, null), `normalizeModelKey`
  (punctuation strip, length floor), `brandMatchKey` (Casio collapse, G-Shock flag) — table tests.
- Collector tests updated to assert the improved `model_ref` (Bozinovski sku, Watch Club name).
- Backfill: dry-run counts per vendor; assert no row loses a good ref.
- **Live verification:** after backfill, re-run the overlap audit — Bozinovski/Watch Club/B-Watch
  overlap with MY:TIME should rise materially (esp. Casio now matching); the `compare_skus` tool
  returns sane head-to-heads (Saat&Saat ~88+, Hronometar ~66+, and now meaningful Woo numbers).
- `pnpm -r build` + tests + Biome clean.

## Success criteria

1. `parseModelRef` extracts real references for Bozinovski (sku), Watch Club (name), MY:TIME
   (mid-name), with B-Watch/Saat&Saat/Hronometar unchanged-or-better.
2. Backfill lifts cross-vendor overlap (Casio MY:TIME↔B-Watch now matches; Woo vendors join).
3. `compare_skus` MCP tool returns per-competitor matched SKUs + price deltas, Casio-correct
   (Timeless/Vintage, not G-Shock). Build + tests + Biome clean; no regression.
