# Crawler Plan — Phase 1 site profiling & tool selection

**Date profiled:** 2026-06-27 · **Method:** FireCrawl scrape of each homepage + a representative product/category page (raw HTML + markdown + links), platform fingerprinting from HTML signatures and `generator` meta, plus a live probe of the WooCommerce Store API. No scraper code written — this document is the plan.

MY:TIME's own catalog is **not** crawled; it comes from the Adform XML feed (`MYTIME_FEED_URL`). The 8 web-trackable competitors below are the depletion-engine targets. Chapter 03 has no website (social-listening only) and is excluded here.

---

## 1. Headline findings

1. **Per-location (per-physical-store) stock is NOT exposed on any of the 8 sites.** Every storefront shows a single, site-wide online stock signal. Pandora has a *store locator*, but that is physical addresses only — not per-store inventory. **→ The brief's "in stock at 3 locations today, 1 tomorrow" model does not apply; depletion runs on the single online stock signal (see §3).** This is flagged per-site in the table.

2. **Stock granularity splits into two tiers:**
   - **Tier A — exact unit counts** (true unit-level depletion): **B-Watch, Bozinovski**. Their WooCommerce product pages expose the real stock quantity as the quantity selector's `max` (e.g. B-Watch `max="9"`, Bozinovski `max="5"`), and the WC Store API adds `low_stock_remaining`.
   - **Tier B — binary in/out** (availability-flip + assortment depletion): **Watch Club, Saat&Saat, Hronometar, Pandora, Zia, Swarovski**. These expose only `InStock`/`OutOfStock` (schema.org / OpenGraph / platform availability), no public quantity.

3. **The 3 WooCommerce sites have an open Store REST API** (`/wp-json/wc/store/v1/products?per_page=100&page=N`, all returned HTTP 200) yielding `id`, `name`, `prices`, `is_in_stock`, `stock_availability`, `low_stock_remaining` as JSON, 100 products/request. This is faster, cheaper, and more reliable than HTML scraping for catalog + price + availability — and should be the primary collector for those sites, with a product-page pass only to read the exact `qty max` where present.

4. **All sites are server-rendered** with structured data (schema.org JSON-LD or OpenGraph) present in the initial HTML — no JS execution required to read price/stock. **No anti-bot challenges** were encountered (only passive CookieYes consent banners on a couple of sites). All 8 scrapes succeeded first try.

5. **Currency is MKD (ден) everywhere.**

---

## 2. Per-site profile & tool choice

| # | Competitor | Platform | JS render | Price | Stock signal | Exact qty? | Per-location stock | Anti-bot | **Tool** |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **B-Watch** | WooCommerce (WP 7.0 / WC 10.6) | No (SSR) | ✅ MKD | schema `InStock` + WC Store API `is_in_stock` | ✅ **qty `max`** + `low_stock_remaining` | ❌ not exposed | none | **FireCrawl** (+ WC Store API) |
| 2 | **Bozinovski** | WooCommerce (WP / WPBakery) | No (SSR) | ✅ MKD | schema `InStock` + WC Store API | ✅ **qty `max`** + `low_stock_remaining` | ❌ not exposed | none | **FireCrawl** (+ WC Store API) |
| 3 | **Watch Club** | WooCommerce (WP 6.9 / WC 10.6 / Elementor) | No (SSR) | ✅ MKD | schema `InStock` + WC Store API | ⚠️ binary (qty mgmt off; `max=""`) | ❌ not exposed | CookieYes banner | **FireCrawl** (+ WC Store API) |
| 4 | **Saat&Saat** | Custom (`/en/product/…`, JSON-LD) | No (SSR) | ✅ MKD | schema `InStock` / `OutOfStock` | ❌ binary | ❌ not exposed | none | **FireCrawl** |
| 5 | **Hronometar** | nopCommerce (.NET) | No (SSR) | ✅ MKD | nopCommerce availability (In stock) | ❌ binary | ❌ not exposed | CookieYes banner | **FireCrawl** |
| 6 | **Pandora** ⚠️ monobrand | Magento 2 | No (SSR) | ✅ MKD | Magento availability `In/OutOfStock` | ❌ binary | ❌ store-locator = addresses only | none | **FireCrawl** |
| 7 | **Swarovski** ⚠️ monobrand | Custom (`/p/{id}`, `/c/{id}`; royalhouse.mk) | No (SSR) | ✅ MKD | OG `product:availability` + `data-stock` | ⚠️ qty `max="10"` looks like a generic cap — treat binary until verified | ❌ not exposed | none | **FireCrawl** |
| 8 | **Zia** | Custom headless (`/products/{id}`, JSON-LD) | No (prerendered SSR) | ✅ MKD | schema `InStock` (JSON-LD) | ❌ binary | ❌ not exposed | none | **FireCrawl** |

---

## 3. Depletion capability per site (what the engine can actually infer)

| Tier | Sites | Inference the engine can make |
|---|---|---|
| **A — unit-level** | B-Watch, Bozinovski | Day-over-day change in exact stock count → **estimated units sold** (the strongest signal). Plus assortment & price. |
| **B — availability + assortment** | Watch Club, Saat&Saat, Hronometar, Pandora, Zia, Swarovski | `InStock → OutOfStock` transitions and SKU appear/disappear → **a unit sold-out / restock event** (not a precise count). Watch Club additionally gets a partial count when WC `low_stock_remaining` fires. Plus full price tracking. |
| **All** | all 8 | Full **assortment** (catalog membership over time) and **price** time-series regardless of stock granularity. |

This is the degradation the brief asked to flag: for Tier-B sites, "units sold" is an availability-event estimate, not a counted depletion, and must be labeled as such in tool outputs.

---

## 4. Tool-choice rationale

**FireCrawl is the per-site pick for all 8 web catalogs**, because every site is server-rendered with structured data (schema.org JSON-LD / OpenGraph) in the initial HTML, none present anti-bot challenges, and FireCrawl's scrape/extract reads the fields cleanly (with JS rendering available as a fallback if a site changes). A per-site decision that lands on one tool for all eight is still a per-site decision — there was no site where Apify was the better fit today.

**Apify is reserved for** (consistent with the brief's "both, chosen per site"):
- **Competitor social collectors** (IG/FB/TikTok public actors) in Phase 3 — Apify's core value in this project.
- **Escalation** for any site that later deploys Cloudflare/anti-bot or requires browser interaction (clicks, infinite scroll) that FireCrawl scrape can't satisfy.
- **Cost/scale fallback** for the largest catalogs if daily full-catalog FireCrawl credit usage proves expensive.

**Optimization shortcut (not a third vendor, just a better endpoint):** for the 3 WooCommerce sites, hit the **WC Store API** directly for catalog/price/availability (100 SKUs/request, JSON) and only scrape product pages to read the exact `qty max`. This minimizes pages crawled and gives the cleanest data.

---

## 5. Fields available per site (for the Phase 2 schema & Phase 3 collectors)

- **All 8:** product id/slug, name, URL, price (MKD), `in_stock` boolean, first-seen / last-seen (for assortment), product image.
- **B-Watch, Bozinovski:** + exact `stock_quantity` (from qty `max`), + `low_stock_remaining`.
- **Watch Club:** + `low_stock_remaining` (only when low).
- **Pandora, Swarovski:** monobrand → depletion reflects demand for a single brand only (flag in outputs).

---

## 6. Open items / risks (to resolve in Phase 3, not blocking)

- **Catalog enumeration** per site: confirm the cleanest list source — WC Store API (Woo), `sitemap.xml` (Magento/nopCommerce/custom), or category pagination. Most expose a sitemap.
- **Swarovski qty cap:** verify whether `max="10"` reflects real stock or a fixed purchase cap; if fixed, treat as Tier B.
- **Zia internal API:** the headless storefront (`/products/{mongoId}`) likely has a JSON API that would be cheaper than page scraping — probe in Phase 3.
- **Restock vs new-SKU disambiguation:** Tier-B "sold out" events need the restock/gap handling planned for Phase 4's depletion logic.
- **Daily-crawl politeness:** rate-limit and identify a UA; revisit Apify if any site rate-limits FireCrawl.
