# Product taxonomy + gender normalization

**Date:** 2026-06-30
**Status:** Approved (build), iterate on production
**Area:** `ingestion/src/pipeline/normalize.ts`, the per-vendor collectors, `db/src/schema.ts`
(+ migration), a one-time backfill script, and `mcp-server/src/admin/pages/dashboard.ts`.

## Problem

The dashboard's vendor/gender/category filters sit on product dimensions that are inconsistent
across vendors:

- **No canonical product type.** Each vendor's `category` is its own raw, free-form string (in
  Macedonian), mixing type + gender + sub-type + even brand-lines (Bozinovski `Evergreen`). There
  is no shared "Watches vs Jewelry" axis, so cross-vendor comparison is impossible. The dashboard
  currently regex-guesses a group at display time (`groupOf()`), which mislabels (e.g. Bozinovski
  `Evergreen` → "Other").
- **Gender is missing for 7,040 of 13,013 active products** — but mostly because of collector
  bugs and un-set monobrand defaults, not absent data (see the audit below).

This spec adds a canonical `product_type` and recovers gender for nearly all of the 7,040 missing,
from data we already scrape (no re-scrape). It is the prerequisite for any further dashboard work.

## Gender audit (active products, prod 2026-06-30)

| Vendor | Total | Missing | Where gender lives | Plan |
|---|--:|--:|---|---|
| Bozinovski | 2,762 | 2,762 | `pa_sex` attribute (`Пол`: Женски/Машки) | Collector reads `pa_sex` |
| Watch Club | 1,650 | 1,068 | category string (`Женски/Машки часовници`) | Category fallback |
| Pandora | 1,359 | 1,359 | n/a — monobrand women's jewelry | Vendor default `womens` |
| Zia | 985 | 952 | n/a — women's fashion jewelry | Vendor default `womens` |
| Hronometar | 724 | 724 | product-page spec table — `Пол` row (Машки/Женски) | Parse `Пол` spec row |
| Swarovski | 84 | 84 | n/a — monobrand women's jewelry | Vendor default `womens` |
| B-Watch | 2,863 | 78 | `pa_pol` attribute | Already works (97%) |
| Saat&Saat | 2,586 | 13 | JSON-LD + name | Already works (99%) |

Result after this build: gender present for ~8/8 of product volume (only the small minority of
products that omit the relevant attribute/spec row stay null).

## Design

### 1. Canonical product type — `normalizeType()`

Add to `ingestion/src/pipeline/normalize.ts`, sibling to `normalizeGender()`:

```ts
export type ProductType = "watches" | "jewelry" | "accessories" | "eyewear" | "other";

/** Coarse, cross-vendor product type from raw category + name, with a per-vendor fallback. */
export function normalizeType(
  category: string | null,
  name: string | null,
  fallback: ProductType | null = null,
): ProductType | null {
  const s = `${category ?? ""} ${name ?? ""}`.toLowerCase();
  if (!s.trim()) return fallback;
  // Eyewear first (a watch+sunglasses store must not bucket "очила" as watches).
  if (/(очил|наочар|eyewear|sunglass|glasses)/.test(s)) return "eyewear";
  if (/(часовник|\bwatch|saat|zegar)/.test(s)) return "watches";
  if (/(накит|jewel|прстен|обетк|ѓердан|гердан|огрлиц|белегз|нараквиц|приврзок|привезоц|привез|синџир|ланч|алк[аи]|алка|чокер|choker|bracelet|necklace|earring|ring|pendant|charm)/.test(s))
    return "jewelry";
  if (/(додатоц|ремч|ремен|каиш|strap|манжет|cufflink|новчаник|wallet|чанта|bag|футрол)/.test(s))
    return "accessories";
  return fallback ?? "other";
}
```

Notes:
- Eyewear is checked before watches so "очила" never lands in watches.
- `fallback` carries per-vendor knowledge (monobrands): Pandora/Swarovski/Zia → `jewelry`,
  Hronometar → `watches`. When category+name give no signal, the fallback wins; otherwise the
  text wins (so a Pandora "наочари", if any, still becomes eyewear).
- Returns `null` only when there is no text **and** no fallback (keeps "Other" meaningful).

### 2. Gender recovery

**WooCommerce collector** (`woocommerce.ts`, serves B-Watch, Bozinovski, Watch Club) — generalize
the single-slug read to try the known gender taxonomies, then fall back to the category string:

```ts
const GENDER_TAXONOMIES = ["pa_pol", "pa_sex", "pa_gender", "pa_rod"];
const genderTerm = GENDER_TAXONOMIES.map((tx) => termOf(p, tx)).find((v) => v != null) ?? null;
// …
gender: normalizeGender(genderTerm) ?? normalizeGender(category),
```

This fixes Bozinovski (`pa_sex`) and Watch Club (category fallback) with no other change.

**Monobrand jewelry vendors** (Pandora, Zia, Swarovski) — apply a per-vendor default in each
collector, preserving any gender already derived (so `ZIA Kids` / Swarovski kids stay `kids`):

```ts
gender: normalizeGender(/* existing source */) ?? "womens",
```

- `pandora.ts`: `gender: "womens"` (was hardcoded `null`).
- `zia.ts`: `gender: normalizeGender(it.category?.name) ?? normalizeGender(name) ?? "womens"`.
- `swarovski` (via `web-jsonld.ts` OG path): `gender: normalizeGender(name) ?? "womens"`. The OG
  fallback path is shared, so gate the `womens` default to swarovski by target id (passed in
  collector context) — do **not** apply a blanket `womens` default to every OG-fallback site.

**Hronometar collector** (`hronometar.ts`, `parseNop`) — parse gender from the product-page spec
table. The table is server-rendered but its labels are HTML-entity-encoded Cyrillic and the cells
are unclosed (`<td class=spec-name>Пол<td class=spec-value>Машки<tr…>`). Decode entities, read the
`Пол` row's value, and feed it to `normalizeGender`, falling back to the name:

```ts
const decodeEntities = (h: string): string =>
  h.replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
   .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)));

function specValue(html: string, label: string): string | null {
  const m = decodeEntities(html).match(
    new RegExp(`spec-name>\\s*${label}\\s*<td[^>]*>([^<]+)`, "i"),
  );
  return m?.[1]?.trim() ?? null;
}
// in parseNop:
gender: normalizeGender(specValue(html, "Пол")) ?? normalizeGender(name),
```

The same `specValue` also yields `Колекција` → the existing `collection` column (a free bonus;
products lacking the `Пол` row simply stay null). Backfill cannot recover this from the DB (the
spec table was never stored), so it fills on the next daily ingest — same as Bozinovski.

**Type wiring** — every collector passes its `category`/`name` (+ fallback) into `normalizeType`
and sets the new `product_type` field on the `ProductObservation`:
- woocommerce: `normalizeType(category, name)`
- web-jsonld (saat-saat): `normalizeType(node.category, name)`; OG path
  `normalizeType(null, name, target==="swarovski" ? "jewelry" : null)`
- zia: `normalizeType(it.category?.name, name, "jewelry")`
- pandora: `normalizeType(null, name, "jewelry")`
- hronometar: `normalizeType(null, name, "watches")`
- mytime-feed (self): `normalizeType(it.fileUnder, name)`

`ProductObservation` (in `@mytime/shared`) gains `productType: ProductType | null`; the product
writer persists it to the new column.

### 3. Schema — `products.product_type`

Add a nullable text column + index in `db/src/schema.ts`:

```ts
productType: text("product_type"), // watches | jewelry | accessories | eyewear | other | null
// index:
index("products_product_type_idx").on(t.productType),
```

Generate the Drizzle migration. Nullable so existing rows are valid pre-backfill.

### 4. One-time backfill (`db/scripts/backfill-taxonomy.mjs`)

Re-derive from data already stored — no re-scrape:

- **product_type** for every active product: apply the same `normalizeType(category, name,
  vendorFallback)` using a per-target fallback map (pandora/zia/swarovski→jewelry,
  hronometar→watches, else null).
- **gender** for Watch Club: `normalizeGender(category)` where `gender IS NULL`.
- **gender** for Pandora / Zia / Swarovski: set `womens` where `gender IS NULL` (preserves the
  already-tagged kids rows).
- Bozinovski gender (`pa_sex`) and Hronometar gender (`Пол` spec row) are **not** backfillable
  from the DB (the source field was never stored) — both fill automatically on the next daily
  ingest once the collectors read them.

Run once against prod; idempotent (re-running yields the same values).

### 5. Dashboard — use the column

In `dashboard.ts`: select `p.product_type` in the discounts / price-move / stockout queries and
emit it on each payload item; replace the display-time `groupOf()` classifier and its category
`<select>` options with `product_type`-based filtering (the type set becomes the five canonical
buckets). Keep the vendor + gender filters as-is (they now have far better data underneath).

## Deferred (fast-follow, not in this build)

- **Bozinovski brand (0%):** their brand sits in the category tree / page, not `pa_brend`; parse
  and backfill.
- **Rich watch attributes:** Bozinovski and Hronometar expose diameter/mechanism/material/water-
  resistance/power-reserve spec rows we currently discard (`attributes: null`) — capture into the
  JSONB `attributes` column when we want spec-level filtering. (Hronometar's `Колекција` → the
  `collection` column is the one piece we take now, since we're already parsing that table.)

## Testing

- **Unit (`ingestion`, vitest):** `normalizeType` table tests — MK + EN category/name samples for
  each bucket, eyewear-before-watches precedence, fallback behavior, empty→null. Extend
  `normalizeGender` tests if needed (already covered).
- **Collector tests:** update woocommerce/zia/pandora/hronometar fixtures to assert the new
  `productType` and recovered `gender` (Bozinovski `pa_sex`, Watch Club category, Hronometar `Пол`
  spec row + entity-decoding, monobrand defaults).
- **Backfill:** dry-run count report (rows touched per vendor) before the write; assert no row
  loses an existing non-null gender.
- **Live verification:** after deploy + backfill (and one daily ingest for Bozinovski/Hronometar),
  re-run the coverage audit — gender ~8/8 of volume, `product_type` ~100%, and the dashboard's
  per-vendor `priceMoves`/`stockouts`/discounts carry a real type. `pnpm -r build` + tests + Biome
  clean.

## Scope / YAGNI

- Five coarse types only (no rings/necklaces/earrings split — the raw category keeps that detail
  if we ever want it).
- No Hronometar/Pandora gender crawl, no Bozinovski brand parse, no rich-attribute capture (all
  fast-follows).
- No new gender values; monobrand defaults are explicit and per-vendor, never blanket.

## Success criteria

1. `products.product_type` exists, indexed, populated ~100% (watches/jewelry/accessories/eyewear/
   other) across all vendors after backfill.
2. Gender present for ~8/8 of product volume: Bozinovski (`pa_sex`), Watch Club (category), and
   Hronometar (`Пол` spec row) recovered via collector fixes; Pandora/Zia/Swarovski defaulted to
   `womens` (kids preserved); B-Watch/Saat&Saat unchanged.
3. Dashboard filters read `product_type`; `groupOf()` removed. Build + tests + Biome clean; no
   regression to other admin pages or the digest.
