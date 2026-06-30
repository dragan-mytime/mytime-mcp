# Competitive dashboard (admin panel) — v1

**Date:** 2026-06-30
**Status:** Approved (build v1, iterate on production)
**Area:** `mcp-server/src/admin` — a new tabbed, tabular, drill-down dashboard.

## Goal

A unified internal BI view inside the admin panel: a competitor × metrics overview plus
Discounts, Ads, and Pricing/Inventory tabs, all from the data we already collect (incl. the
just-added ad media + discount brand/category breakdown). Tabular-first, switchable, with
client-side sort / filter / drill-down. Current-snapshot in v1; historical trends are a
fast-follow. It becomes the panel's landing page.

## Placement & auth

- Served at **`/admin`** (the existing "Dashboard" nav item / landing) — the current simple
  summary page (`pages/dashboard.ts`) is replaced by this richer dashboard.
- Behind the existing Google admin gate + MY:TIME brand styling. Read-only (no writes).

## Architecture

- Server-rendered shell (no framework, no build pipeline — matches the panel). The page
  handler gathers the data, **embeds it as a JSON blob** in a `<script type="application/json">`,
  and a single inline `<script>` of vanilla JS renders the interactive tables (tab switch,
  column sort, competitor/brand/category filter, expand-to-drill). All client-side on the
  embedded snapshot — no extra round-trips. (If payload grows heavy, lazy JSON endpoints are a
  later optimization; not needed for v1.)
- **Data gathering** (in the page module, via `adminWriteDb()` / raw `sql`):
  - Reuse `dailyDigest(db)` for the per-competitor block (sales counts/avgPct, `byBrand`/
    `byCategory`, ads `new`/`longestRunning`/`activeToday`, inventory `priceMoves`/`newProducts`/
    `newStockouts`, social follower deltas).
  - 3 extra queries for fuller drill-down lists (bounded for payload size):
    1. **Product count per competitor** (latest prices date) — for the Overview matrix.
    2. **On-sale items today** — competitor, name, brand, category, regular→sale, pct; cap ~100
       per competitor, ordered by discount depth.
    3. **Active ads today** — competitor, ad_title, days_running, media_url, media_type,
       link_url, snapshot_url; cap ~40 per competitor, ordered by days_running desc.

## Tabs

1. **Overview** — competitor × metrics matrix: products, on-sale, avg discount % (with a depth
   bar), active ads, new ads, follower Δ, new products, stockouts. Sortable; clicking a
   competitor filters the other tabs to it. KPI cards above (totals).
2. **Discounts** — the `byBrand` / `byCategory` rollups (count + avg depth, bar) and the on-sale
   items table (was→now, −% badge). Filter by competitor / brand / category; sort by depth.
3. **Ads** — a board: per competitor, active & new & best (longest-running) ads as cards with
   creative thumbnails (`<img>` for image, a video glyph + thumbnail for video), title, days
   running, "New"/"Best" badges, and a link to the FB Ad Library (`snapshot_url`). Filter by
   competitor; toggle new-only / best-only. (Media URLs from FB expire — broken thumbnails fall
   back to a placeholder; durable media hosting is a later step.)
4. **Pricing & inventory** — price moves (from→to, Δ%), new products, new stockouts per
   competitor. Head-to-head price comparison on matching `model_ref` is a **fast-follow** (noted,
   not in v1).

## Components / files

- **Rewrite** `mcp-server/src/admin/pages/dashboard.ts`: `render(req)` gathers data, returns the
  shell + embedded JSON + inline JS. Keep `esc()` use for any server-injected strings; the JSON
  blob is `JSON.stringify` + HTML-escaped for `</script>` safety.
- Reuse existing brand CSS in `admin/render.ts`; add a small dashboard-specific CSS block
  (tabs, KPI cards, depth bars, ad cards) either in `render.ts` or inline in the page.
- Router: `/admin` already maps to `dashboard` via `page("Dashboard", dashboard)` — unchanged.

## Error handling / edge cases

- Competitors with no data render as empty/"—" cells, not errors.
- Empty ad media → placeholder tile; video → thumbnail + play glyph (FB Ad Library link always
  present).
- Large numbers formatted with the MK thousands style already used (e.g. `2.854`).
- The whole gather is wrapped so one failing query degrades that tab, not the page.

## Testing

- Pure client JS isn't unit-tested (vanilla, in-page); correctness verified by build + a live
  smoke (load `/admin` after deploy, confirm tabs/sort/filter/drill work and numbers match the
  digest).
- `pnpm -r build` + Biome clean. Existing admin tests unaffected.
- Live: `/admin` returns the dashboard (302→login when unauth); after login, the four tabs show
  real data.

## Scope / YAGNI (v1)

- Current snapshot only (no trend charts / time series) — fast-follow.
- No head-to-head model_ref comparison yet — fast-follow.
- No CSV export, no saved views, no shareable link — later.
- Inline JSON + JS (no lazy endpoints, no charting lib).

## Success criteria

1. `/admin` shows a tabbed dashboard (Overview / Discounts / Ads / Pricing & inventory) in the
   brand style, behind admin auth.
2. Tabs switch; tables sort and filter by competitor (and brand/category on Discounts); clicking
   a competitor drills in; ad creatives render with FB Ad Library links.
3. Numbers reconcile with `dailyDigest`. Build + Biome clean; no regression to other admin pages.
