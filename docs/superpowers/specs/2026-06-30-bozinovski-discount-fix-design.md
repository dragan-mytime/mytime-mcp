# Bozinovski catalog-discount capture + validator hardening

**Date:** 2026-06-30
**Status:** Approved design (pre-implementation)
**Area:** ingestion WooCommerce collector + data validator

## Problem (root cause, verified against live site 2026-06-30)

The MCP reports **0 discounts for Bozinovski** (2,762 products, 0 sale rows ever), yet
Bozinovski runs a real **30% catalog sale** on its Evergreen category (verified: 12/12 sampled
Evergreen product pages show `<del>`-struck prices, e.g. 10.300→7.210, 123.500→86.450). Two
compounding failures:

1. **The WooCommerce Store API hides the catalog discount.** Every Evergreen product returns
   `on_sale: false` and `regular_price === sale_price === price`. The collector only scrapes a
   product's real page when the API says `on_sale` (`woocommerce.ts` Phase 2), so these
   products are never inspected.
2. **The price parser can't read Bozinovski's markup even when scraped.** Bozinovski renders
   `<del><span class="woocommerce-Price-amount">REG</span></del> <span class="…amount">SALE</span>`
   — no `<ins>`, no `<bdi>`. `parseWooSalePrice` requires `<del>`+`<ins>` and `<bdi>`, so it
   returns nothing.

The **validator already has the right check** (`diffVsDb` flags "live shows a discount the DB
missed", `diff.ts:23`) but it's blind for the same reason: its verifier calls the same
`parseWooSalePrice`, so `live.salePrice` is null and there's nothing to disagree with.

B-Watch is unaffected — its Store API reports `on_sale` correctly (2,187 discount rows), and
the existing per-product enrichment works.

## Decisions (locked during brainstorming)

- Detect Bozinovski-style hidden catalog sales by **scraping the `/shop/` listing pages**
  (full pagination), not the Store API flag and not per-product pages.
- Which sites use listing-scrape is a **code-level set** in the collector (not config-plumbed).
- **Harden the validator** — achieved by the shared parser fix (re-activates the existing
  discount check) plus a regression test; no new runtime validator logic.

## Part 1 — Markup-agnostic `parseWooSalePrice`

File: `ingestion/src/sources/woocommerce.ts` (exported; reused by the validator verifier).

Rewrite to extract the two monetary amounts from the price block regardless of wrapper:

- Locate the price block: first `<p|span>` whose `class` contains `price`.
- An **amount** is the leading numeric run inside any `<bdi>` **or** `<span class="…Price-amount…">`
  (fallback: any numeric run). MKD uses `.` as a thousands separator and `&nbsp;`/`денари`/hex
  entities follow the digits — strip everything non-digit from the captured run.
- **regular** = the amount inside `<del>…</del>`. **sale** = the first amount that is NOT inside
  the `<del>` (covers `<ins>…</ins>`, a trailing bare `<span>`, etc.).
- No `<del>` → single price: `{ regular: <the one amount>, sale: null }`.
- Only return a sale when `sale != null && regular != null && sale < regular`.

Keep the signature `parseWooSalePrice(html) → { regular: number|null, sale: number|null }`.

**Tests** (`ingestion/test/sources/woocommerce.test.ts`): captured-fixture cases for
(a) Bozinovski `<del><span>…</span></del> <span>…</span>`, (b) B-Watch
`<del><bdi>…</bdi></del> <ins><bdi>…</bdi></ins>`, (c) single price (no `<del>`),
(d) malformed/no price block → `{null,null}`.

## Part 2 — Listing sale-map scrape (Bozinovski)

File: `ingestion/src/sources/woocommerce.ts`.

- `const LISTING_SALE_SITES = new Set(["bozinovski"]);` — sites whose Store API hides catalog
  sales. Easy to extend; documented why.
- New helper `scrapeListingSaleMap(base): Promise<Map<string, {regular:number, sale:number}>>`:
  1. Fetch `${base}/shop/page/1/` (browser UA). Determine the last page number from the
     pagination links (`/shop/page/<n>/`); default 1 if none.
  2. Fetch every page `1..last` with **bounded concurrency** (reuse the existing worker
     pattern, concurrency ~6, 30s timeout), failure-isolated (a failed or 404 page is skipped).
     Hard cap pages at e.g. 400 for safety.
  3. For each page, split product tiles (`<li class="product …">…</li>`), and for each tile
     take the first `<a href>` (the permalink) and run the markup-agnostic parser on the tile.
     If it yields a real discount (`sale < regular`), add `normPermalink(href) → {regular,sale}`.
  4. `normPermalink` = lowercase, strip trailing `/` and query/hash.
- In `collect`: if `LISTING_SALE_SITES.has(target.id)`, build the sale-map once, then for each
  observation look up `normPermalink(rawProduct.permalink)`. On a hit, apply
  `deriveDiscount(regular, sale)` (set `price=regular`, `salePrice`, `discountAmount`,
  `discountPct`). This **replaces** the `on_sale`-gated per-product enrichment for these sites
  (their `on_sale` is unreliable). Non-listing sites keep the existing Phase-2 path unchanged.

**Tests:** `scrapeListingSaleMap`'s tile-parsing is exercised by a fixture test of the tile→
`{permalink,regular,sale}` extraction (network mocked / pure parse helper extracted as
`parseListingTiles(html) → {permalink, regular, sale}[]`).

**Cost/risk:** ~230 listing fetches/night for Bozinovski (theme shows 12/page). Bounded +
failure-isolated. If the site rate-limits (cf. Watch Club 403s), fall back to category-scoped
scraping — noted, not built now.

## Part 3 — Validator hardening

No new runtime logic: Part 1's parser fix makes `woocommerceVerifier.extract` return the real
`salePrice`, which re-activates the existing `diffVsDb` discount check for Bozinovski. The
sampler already orders `on_sale desc, random()` so both "DB has a sale" and "DB missed a sale"
products get covered once collection is fixed.

Add a **regression test** (`ingestion/test/validation/diff.test.ts`): assert `diffVsDb` emits an
`error` mismatch on `field: "salePrice"` with note "live shows a discount the DB missed" when
`live` has `price>salePrice` but `db.salePrice == null` (and the symmetric case). This locks in
that a future silent collection gap surfaces in the validation report.

## Testing summary

- `pnpm --filter @mytime/ingestion test` green, including the new parser fixtures, the
  listing-tile parse test, and the diff regression test.
- Manual: run `VALIDATE_TARGETS=bozinovski node ingestion/dist/validation/run.js` after deploy
  → report should now show Bozinovski sale prices matching the live pages (0 "missed discount"
  errors once a fresh ingest has run).
- Manual: a targeted Bozinovski re-ingest then DB check → `prices.sale_price` populated for
  Evergreen products; `daily_digest`/`price_assortment` surface the discounts.

## Out of scope (later)

- Ad-media archival (FB Ad Library `media_url`s expire) + Higgsfield media-plan generation.
- Promoting `LISTING_SALE_SITES` to a per-target config flag / admin-editable.
- Watch Club Store API 403 (separate parked issue).

## Success criteria

1. A Bozinovski ingest records `sale_price`/`discount_pct` for its Evergreen (and other catalog-
   sale) products; the MCP discount tools/digest stop reporting zero discounts for Bozinovski.
2. `parseWooSalePrice` parses both Bozinovski (`<del><span>`) and B-Watch (`<del><bdi>/<ins>`)
   markup; B-Watch discount capture is unchanged (no regression).
3. The validator's `diffVsDb` flags a live-vs-DB discount discrepancy (covered by the new
   regression test); a Bozinovski validation run reflects real sale state.
4. `pnpm -r build` + ingestion tests + Biome clean.
