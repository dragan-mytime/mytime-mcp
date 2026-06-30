# Product Taxonomy + Gender Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every product a canonical coarse `product_type` and recover `gender` across all vendors, from data we already scrape, so the admin dashboard filters read clean dimensions instead of a display-time regex.

**Architecture:** A pure `normalizeType()` joins the existing `normalizeGender()` in the ingestion normalize layer. Each collector is patched to read its real gender source (Bozinovski `pa_sex`, Watch Club category fallback, Hronometar `Пол` spec row) or apply a monobrand `womens` default (Pandora/Zia/Swarovski), and to emit `productType`. A new nullable `products.product_type` column (Drizzle migration) is persisted by the writer. A one-time backfill re-derives both from data already in the DB. The dashboard then filters on the column and drops `groupOf()`.

**Tech Stack:** TypeScript 6 (ESM, NodeNext, `.js` import specifiers), Drizzle ORM + drizzle-kit, Vitest 3, Biome 2, pnpm workspaces, Postgres (Supabase). Repo root: `C:\Users\DRAGAN.SALDJIEV\mytime-bi`.

**Spec:** `docs/superpowers/specs/2026-06-30-product-taxonomy-gender-normalization-design.md`

---

## File Structure

- `ingestion/src/pipeline/normalize.ts` — **modify**: add `ProductType` type + `normalizeType()`.
- `ingestion/test/normalize.test.ts` — **create**: unit tests for `normalizeType`.
- `shared/src/observation.ts` — **modify**: add `productType?` to `ProductObservation`.
- `db/src/writers.ts` — **modify**: persist `product_type` (insert values + conflict set).
- `db/src/schema.ts` — **modify**: add `productType` column + index.
- `db/migrations/0004_*.sql` — **generate**: the new column migration.
- `ingestion/src/sources/woocommerce.ts` — **modify**: multi-slug + category gender fallback; emit `productType`; export `mapProduct`.
- `ingestion/test/sources/woocommerce.test.ts` — **modify**: assert gender + type from `mapProduct`.
- `ingestion/src/sources/hronometar.ts` — **modify**: parse `Пол` spec row → gender, `Колекција` → collection; emit `productType`; export `specValue`.
- `ingestion/test/sources/hronometar.test.ts` — **modify**: assert gender from spec + `specValue`.
- `ingestion/src/sources/pandora.ts` — **modify**: gender `womens` default; emit `productType`; export `parseListing`.
- `ingestion/test/sources/pandora.test.ts` — **create**: assert default gender + type.
- `ingestion/src/sources/zia.ts` — **modify**: gender `?? "womens"`; emit `productType`; export `map`.
- `ingestion/test/sources/zia.test.ts` — **create**: assert default gender + type.
- `ingestion/src/sources/web-jsonld.ts` — **modify**: `parseOg` gains opts for swarovski `womens`/`jewelry` default; `parseProduct` emits `productType`.
- `ingestion/test/sources/web-jsonld.test.ts` — **modify**: assert swarovski default + saat-saat type.
- `ingestion/src/sources/mytime-feed.ts` — **modify**: emit `productType`.
- `db/scripts/backfill-taxonomy.mjs` — **create**: one-time backfill of `product_type` + Watch Club / monobrand gender.
- `mcp-server/src/admin/pages/dashboard.ts` — **modify**: select/emit `product_type`; replace `groupOf()` filtering.

---

### Task 1: `normalizeType()` in the normalize layer

**Files:**
- Modify: `ingestion/src/pipeline/normalize.ts`
- Test: `ingestion/test/normalize.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `ingestion/test/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeType } from "../src/pipeline/normalize.js";

describe("normalizeType", () => {
  it("classifies watches from MK category", () => {
    expect(normalizeType("Машки Часовник", "Hamilton Jazzmaster")).toBe("watches");
  });
  it("classifies jewelry from MK sub-types", () => {
    expect(normalizeType("огрлици", "Zia KR016")).toBe("jewelry");
    expect(normalizeType("Женски Накит-Прстен", null)).toBe("jewelry");
  });
  it("classifies eyewear before watches (a watch store also sells очила)", () => {
    expect(normalizeType("Очила", "Ray-Ban часовник lookalike")).toBe("eyewear");
  });
  it("classifies accessories", () => {
    expect(normalizeType("Додатоци", "2-in-1 Wallet")).toBe("accessories");
  });
  it("falls back to the per-vendor default when there is no text signal", () => {
    expect(normalizeType(null, "794461C01", "jewelry")).toBe("jewelry");
    expect(normalizeType(null, "SSA461J1", "watches")).toBe("watches");
  });
  it("returns 'other' when text exists but matches nothing and no fallback", () => {
    expect(normalizeType("Ваучери", "Подарок ваучер")).toBe("other");
  });
  it("returns null when there is neither text nor a fallback", () => {
    expect(normalizeType(null, null)).toBeNull();
    expect(normalizeType("", "  ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/normalize.test.ts`
Expected: FAIL — `normalizeType is not a function` (not exported yet).

- [ ] **Step 3: Implement `normalizeType`**

In `ingestion/src/pipeline/normalize.ts`, append after `normalizeGender` (after line 23):

```ts
export type ProductType = "watches" | "jewelry" | "accessories" | "eyewear" | "other";

/**
 * Coarse, cross-vendor product type from a raw vendor category + product name,
 * with an optional per-vendor fallback (monobrands: Pandora/Zia/Swarovski →
 * "jewelry", Hronometar → "watches"). Eyewear is matched first so a watch
 * store's "очила" never lands in watches. Returns null only when there is no
 * text and no fallback, keeping "other" meaningful.
 */
export function normalizeType(
  category: string | null,
  name: string | null,
  fallback: ProductType | null = null,
): ProductType | null {
  const s = `${category ?? ""} ${name ?? ""}`.toLowerCase().trim();
  if (!s) return fallback;
  if (/(очил|наочар|eyewear|sunglass|glasses)/.test(s)) return "eyewear";
  if (/(часовник|\bwatch|saat|zegar)/.test(s)) return "watches";
  if (
    /(накит|jewel|прстен|обетк|ѓердан|гердан|огрлиц|белегз|нараквиц|приврзок|привезоц|привез|синџир|ланч|алк[аи]|алка|чокер|choker|bracelet|necklace|earring|\bring\b|pendant|charm)/.test(
      s,
    )
  )
    return "jewelry";
  if (/(додатоц|ремч|ремен|каиш|strap|манжет|cufflink|новчаник|wallet|чанта|\bbag\b|футрол)/.test(s))
    return "accessories";
  return fallback ?? "other";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/normalize.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/pipeline/normalize.ts ingestion/test/normalize.test.ts
git commit -m "feat(ingestion): add normalizeType() coarse product taxonomy"
```

---

### Task 2: Add `productType` to the observation contract + writer

**Files:**
- Modify: `shared/src/observation.ts:17-20`
- Modify: `db/src/writers.ts:91-100`, `db/src/writers.ts:111-114`

- [ ] **Step 1: Add the field to `ProductObservation`**

In `shared/src/observation.ts`, add after the `category` line (line 17):

```ts
  category?: string | null;
  productType?: string | null; // watches | jewelry | accessories | eyewear | other | null
  gender?: string | null; // normalized: mens | womens | unisex | kids | null
```

- [ ] **Step 2: Persist it in the product insert values**

In `db/src/writers.ts`, in `productValues` (after the `category` line, ~line 91):

```ts
      category: o.category ?? null,
      productType: o.productType ?? null,
      gender: o.gender ?? null,
```

- [ ] **Step 3: Persist it in the conflict-update set**

In `db/src/writers.ts`, in the `onConflictDoUpdate` `set` (after the `category` line, ~line 111):

```ts
            category: sql`excluded.category`,
            productType: sql`excluded.product_type`,
            gender: sql`excluded.gender`,
```

(`products.productType` column is added in Task 3; the build of this task may run before the column exists — that is fine, `tsc` only needs the schema field, added next. If executing strictly in order, run Task 3's schema edit before building this task. To keep each task green on its own, do Step 4 of *this* task after Task 3 Step 1.)

- [ ] **Step 4: Build both packages**

Run: `pnpm --filter @mytime/shared build && pnpm --filter @mytime/db build`
Expected: exit 0 (no type errors). If `productType` is unknown on `products`, complete Task 3 Step 1 first, then re-run.

- [ ] **Step 5: Commit**

```bash
git add shared/src/observation.ts db/src/writers.ts
git commit -m "feat: carry productType through the observation contract + writer"
```

---

### Task 3: Schema column + migration

**Files:**
- Modify: `db/src/schema.ts:104-105`, `db/src/schema.ts:118-123`
- Generate: `db/migrations/0004_*.sql`

- [ ] **Step 1: Add the column + index to the schema**

In `db/src/schema.ts`, in the `products` table, add after `category` (line 104):

```ts
    category: text("category"),
    productType: text("product_type"), // watches | jewelry | accessories | eyewear | other | null
    gender: text("gender"), // normalized in ingestion: mens | womens | unisex | kids | null
```

And add to the products index list (inside the `(t) => [ ... ]` block, after the `products_model_ref_idx` line ~121):

```ts
    index("products_model_ref_idx").on(t.modelRef),
    index("products_product_type_idx").on(t.productType),
```

- [ ] **Step 2: Build the db package to confirm the schema compiles**

Run: `pnpm --filter @mytime/db build`
Expected: exit 0.

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @mytime/db generate`
Expected: a new file `db/migrations/0004_*.sql` containing `ALTER TABLE "products" ADD COLUMN "product_type" text;` and a `CREATE INDEX ... "products_product_type_idx" ...`. drizzle-kit also updates `db/migrations/meta/`.

- [ ] **Step 4: Eyeball the migration**

Run: `git status --short db/migrations`
Expected: one new `0004_*.sql` + modified `meta/_journal.json` + a new `meta/0004_snapshot.json`. Open the `.sql` and confirm it only adds the column + index (no destructive statements).

- [ ] **Step 5: Commit**

```bash
git add db/src/schema.ts db/migrations
git commit -m "feat(db): add products.product_type column + index (migration 0004)"
```

---

### Task 4: WooCommerce — gender slugs + category fallback + productType

**Files:**
- Modify: `ingestion/src/sources/woocommerce.ts:195-219`
- Test: `ingestion/test/sources/woocommerce.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `ingestion/test/sources/woocommerce.test.ts`:

```ts
import { mapProduct } from "../../src/sources/woocommerce.js";

const wc = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "JAZZMASTER OPEN HEART",
  slug: "jazzmaster-open-heart",
  prices: { regular_price: "4990000", currency_minor_unit: 2, currency_code: "MKD" },
  is_in_stock: true,
  categories: [{ name: "Часовници" }],
  images: [{ src: "https://x/a.jpg" }],
  permalink: "https://bozinovski.com.mk/proizvod/jazzmaster/",
  attributes: [],
  ...over,
});

describe("mapProduct gender + product type", () => {
  it("reads Bozinovski gender from the pa_sex attribute", () => {
    const o = mapProduct(
      wc({ attributes: [{ taxonomy: "pa_sex", terms: [{ name: "Женски" }] }] }) as never,
    );
    expect(o.gender).toBe("womens");
    expect(o.productType).toBe("watches");
  });
  it("reads B-Watch gender from pa_pol", () => {
    const o = mapProduct(
      wc({ attributes: [{ taxonomy: "pa_pol", terms: [{ name: "Машки" }] }] }) as never,
    );
    expect(o.gender).toBe("mens");
  });
  it("falls back to the category string for gender (Watch Club)", () => {
    const o = mapProduct(
      wc({ categories: [{ name: "Женски часовници" }], attributes: [] }) as never,
    );
    expect(o.gender).toBe("womens");
    expect(o.productType).toBe("watches");
  });
  it("leaves gender null when no slug and category has no gender word", () => {
    const o = mapProduct(wc({ categories: [{ name: "Часовници" }], attributes: [] }) as never);
    expect(o.gender ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/woocommerce.test.ts`
Expected: FAIL — `mapProduct` is not exported / `productType` undefined.

- [ ] **Step 3: Implement the change**

In `ingestion/src/sources/woocommerce.ts`:

(a) Add `normalizeType` to the normalize import (top of file, the `from "../pipeline/normalize.js"` block):

```ts
import {
  cleanText,
  deriveDiscount,
  normalizeBrand,
  normalizeGender,
  normalizeType,
} from "../pipeline/normalize.js";
```

(b) Export `mapProduct` and replace the gender line + add type. Change `function mapProduct` to `export function mapProduct` (line ~195), then inside it replace lines 200-214:

```ts
  const brand = normalizeBrand(termOf(p, "pa_brend"));
  const category =
    cleanText(p.categories?.find((c) => cleanText(c.name) !== brand)?.name) ??
    cleanText(p.categories?.[0]?.name);

  const GENDER_TAXONOMIES = ["pa_pol", "pa_sex", "pa_gender", "pa_rod"];
  const genderTerm = GENDER_TAXONOMIES.map((tx) => termOf(p, tx)).find((v) => v != null) ?? null;

  const inStock = p.is_in_stock !== false;
  const low = p.low_stock_remaining ?? null;

  return {
    externalId: String(p.sku || p.id),
    name: cleanText(p.name) ?? String(p.id),
    brand,
    modelRef: p.slug ? p.slug.toUpperCase() : null,
    category,
    productType: normalizeType(category, cleanText(p.name)),
    gender: normalizeGender(genderTerm) ?? normalizeGender(category),
    collection: null,
    attributes: null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/woocommerce.test.ts`
Expected: PASS (all, including the new 4).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/sources/woocommerce.ts ingestion/test/sources/woocommerce.test.ts
git commit -m "feat(ingestion): woocommerce gender via pa_sex/category fallback + product type"
```

---

### Task 5: Hronometar — gender from the `Пол` spec row + collection + productType

**Files:**
- Modify: `ingestion/src/sources/hronometar.ts:1-3`, `:43-75`
- Test: `ingestion/test/sources/hronometar.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `ingestion/test/sources/hronometar.test.ts`:

```ts
import { specValue } from "../../src/sources/hronometar.js";

describe("hronometar spec parsing", () => {
  // Real markup: entity-encoded Cyrillic labels, unclosed <td> cells.
  const SPEC =
    "<table class=data-table><tbody>" +
    "<tr class=odd><td class=spec-name>&#x41C;&#x435;&#x445;&#x430;&#x43D;&#x438;&#x437;&#x430;&#x43C;<td class=spec-value>&#x410;&#x432;&#x442;&#x43E;&#x43C;&#x430;&#x442;&#x438;&#x43A;" +
    "<tr class=odd><td class=spec-name>&#x41F;&#x43E;&#x43B;<td class=spec-value>Машки" +
    "<tr class=even><td class=spec-name>&#x41A;&#x43E;&#x43B;&#x435;&#x43A;&#x446;&#x438;&#x458;&#x430;<td class=spec-value>Coupole Classic</table>";

  it("reads the Пол spec value", () => {
    expect(specValue(SPEC, "Пол")).toBe("Машки");
  });
  it("reads the Колекција spec value", () => {
    expect(specValue(SPEC, "Колекција")).toBe("Coupole Classic");
  });
  it("returns null for an absent label", () => {
    expect(specValue(SPEC, "Бренд")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/hronometar.test.ts`
Expected: FAIL — `specValue` is not exported.

- [ ] **Step 3: Implement the change**

In `ingestion/src/sources/hronometar.ts`:

(a) Add `normalizeType` to the normalize import (line 2):

```ts
import { cleanText, deriveDiscount, normalizeGender, normalizeType } from "../pipeline/normalize.js";
```

(b) Add the helpers above `parseNop` (before line 43):

```ts
const decodeEntities = (h: string): string =>
  h
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(Number.parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)));

/**
 * Read a nopCommerce spec-table value by its (decoded) label. The table has
 * entity-encoded Cyrillic labels and unclosed cells:
 *   <td class=spec-name>Пол<td class=spec-value>Машки<tr…>
 */
export function specValue(html: string, label: string): string | null {
  const m = decodeEntities(html).match(
    new RegExp(`spec-name>\\s*${label}\\s*<td[^>]*>([^<]+)`, "i"),
  );
  return cleanText(m?.[1] ?? null);
}
```

(c) In `parseNop`, replace the `gender`/`category`/`collection` lines in the return (currently `category: null`, `gender: normalizeGender(name)`, `collection: null` around lines 72-74):

```ts
    category: null,
    productType: normalizeType(null, name, "watches"),
    gender: normalizeGender(specValue(html, "Пол")) ?? normalizeGender(name),
    collection: specValue(html, "Колекција"),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/hronometar.test.ts`
Expected: PASS (existing discount tests + 3 new spec tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/sources/hronometar.ts ingestion/test/sources/hronometar.test.ts
git commit -m "feat(ingestion): hronometar gender from Пол spec row + collection + type"
```

---

### Task 6: Monobrand defaults — Pandora, Zia, Swarovski

**Files:**
- Modify: `ingestion/src/sources/pandora.ts:1-5`, `:18`, `:36-41`
- Modify: `ingestion/src/sources/zia.ts:2`, `:30`, `:41-42`
- Modify: `ingestion/src/sources/web-jsonld.ts:239-273`, `:311-` (collector)
- Test: `ingestion/test/sources/pandora.test.ts` (create), `ingestion/test/sources/zia.test.ts` (create), `ingestion/test/sources/web-jsonld.test.ts`

- [ ] **Step 1: Write the failing Pandora test**

Create `ingestion/test/sources/pandora.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseListing } from "../../src/sources/pandora.js";

const fx = (f: string) =>
  readFileSync(new URL(`./fixtures/pandora/${f}`, import.meta.url), "utf8");

describe("pandora monobrand defaults", () => {
  it("defaults gender to womens and type to jewelry", () => {
    const items = parseListing(fx("listing.html"));
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.gender).toBe("womens");
      expect(it.productType).toBe("jewelry");
    }
  });
});
```

If no `fixtures/pandora/listing.html` exists, create one with two minimal Magento product cards copied from a live `https://www.pandorashop.mk/mk/proizvodi?p=1` fetch (only the `<li class="product-item">…</li>` blocks `parseListing` needs: product link, name, price). Keep it small (2 cards).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/pandora.test.ts`
Expected: FAIL — `parseListing` not exported / gender is null.

- [ ] **Step 3: Implement Pandora**

In `ingestion/src/sources/pandora.ts`:
(a) Add the import at the top: `import { normalizeType } from "../pipeline/normalize.js";` (merge with any existing normalize import).
(b) Change `function parseListing` → `export function parseListing` (line 18).
(c) Replace the `category`/`gender` lines (36-39) in the mapped object:

```ts
      category: null,
      productType: "jewelry",
      gender: "womens",
```

- [ ] **Step 4: Run to verify Pandora passes**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/pandora.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Zia test**

Create `ingestion/test/sources/zia.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { map } from "../../src/sources/zia.js";

const item = (over: Record<string, unknown> = {}) => ({
  _id: "1",
  name: "KR016",
  price: 990,
  status: "active",
  stock: 5,
  category: { name: "алки" },
  images: [{ url: "https://x/a.jpg" }],
  tags: [],
  ...over,
});

describe("zia monobrand defaults", () => {
  it("defaults gender to womens and classifies jewelry", () => {
    const o = map(item() as never, "https://zia.mk");
    expect(o.gender).toBe("womens");
    expect(o.productType).toBe("jewelry");
  });
  it("preserves an explicit kids signal in the category", () => {
    const o = map(item({ category: { name: "ZIA Kids" } }) as never, "https://zia.mk");
    expect(o.gender).toBe("kids");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/zia.test.ts`
Expected: FAIL — `map` not exported / gender null / type undefined.

- [ ] **Step 7: Implement Zia**

In `ingestion/src/sources/zia.ts`:
(a) Add `normalizeType` to the normalize import (line 2): `import { cleanText, deriveDiscount, normalizeGender, normalizeType } from "../pipeline/normalize.js";`
(b) Change `function map` → `export function map` (line 30).
(c) Replace the `category`/`gender` lines (41-42):

```ts
    category: cleanText(it.category?.name),
    productType: normalizeType(it.category?.name ?? null, name, "jewelry"),
    gender: normalizeGender(it.category?.name) ?? normalizeGender(name) ?? "womens",
```

- [ ] **Step 8: Run to verify Zia passes**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/zia.test.ts`
Expected: PASS (both — the `ZIA Kids` case resolves via `normalizeGender` "kid" rule before the `womens` default).

- [ ] **Step 9: Write the failing Swarovski (web-jsonld parseOg) test**

In `ingestion/test/sources/web-jsonld.test.ts`, add (adjust the fixture name to an existing swarovski/OG fixture; if none, create `fixtures/web-jsonld/swarovski-og.html` from a live `https://royalhouse.mk/p/...` page with the `og:title`/`og:image`/`product:price` meta tags `parseOg` reads):

```ts
import { parseOg } from "../../src/sources/web-jsonld.js";

describe("parseOg swarovski default", () => {
  it("applies womens + jewelry default when opts say so", () => {
    const o = parseOg(fx("swarovski-og.html"), "https://royalhouse.mk/p/2141/hyperbola-choker", {
      genderDefault: "womens",
      typeDefault: "jewelry",
    });
    expect(o?.gender).toBe("womens");
    expect(o?.productType).toBe("jewelry");
  });
  it("does NOT default gender when no opts (other OG sites)", () => {
    const o = parseOg(fx("swarovski-og.html"), "https://royalhouse.mk/p/2141/hyperbola-choker");
    expect(o?.gender ?? null).toBeNull();
  });
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/web-jsonld.test.ts`
Expected: FAIL — `parseOg` takes no third arg / no `productType`.

- [ ] **Step 11: Implement web-jsonld parseOg + collector gating**

In `ingestion/src/sources/web-jsonld.ts`:
(a) Ensure `normalizeType` is imported (add to the existing normalize import block near line 6).
(b) Change the `parseOg` signature and its `category`/`gender` lines (239, 272-273):

```ts
export function parseOg(
  html: string,
  url: string,
  opts: { genderDefault?: string; typeDefault?: "watches" | "jewelry" | "accessories" | "eyewear" | "other" } = {},
): ProductObservation | null {
```

and in its return (replace lines 272-273):

```ts
    category: null,
    productType: normalizeType(null, name, opts.typeDefault ?? null),
    gender: normalizeGender(name) ?? opts.genderDefault ?? null,
```

(c) In `parseProduct` (the JSON-LD path, saat-saat), add `productType` to its return (after `category: cleanText(node.category)`, line 208):

```ts
    category: cleanText(node.category),
    productType: normalizeType(cleanText(node.category), name),
    gender: normalizeGender(node.category) ?? normalizeGender(name),
```

(d) In the `webJsonLdCollector.collect` (line ~316), where it calls `parseOg(...)` for the OG path, pass swarovski opts gated by target id. Locate the `parseOg(html, url)` call and change it to:

```ts
const ogOpts =
  target.id === "swarovski" ? { genderDefault: "womens", typeDefault: "jewelry" as const } : {};
const obs = parseOg(html, url, ogOpts);
```

(Match the existing variable names in the collector; the key change is threading `ogOpts` into the `parseOg` call.)

- [ ] **Step 12: Run to verify web-jsonld passes**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/sources/web-jsonld.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 13: Commit**

```bash
git add ingestion/src/sources/pandora.ts ingestion/src/sources/zia.ts ingestion/src/sources/web-jsonld.ts ingestion/test/sources/pandora.test.ts ingestion/test/sources/zia.test.ts ingestion/test/sources/web-jsonld.test.ts ingestion/test/sources/fixtures
git commit -m "feat(ingestion): monobrand womens default + product type (pandora/zia/swarovski)"
```

---

### Task 7: Remaining collectors emit `productType` (saat-saat covered; mytime-feed)

**Files:**
- Modify: `ingestion/src/sources/mytime-feed.ts:65-66`

- [ ] **Step 1: Add productType to the self feed**

In `ingestion/src/sources/mytime-feed.ts`, add `normalizeType` to the normalize import, then replace the `category`/`gender` lines (65-66):

```ts
    category: cleanText(it.fileUnder),
    productType: normalizeType(cleanText(it.fileUnder), name),
    gender: null,
```

- [ ] **Step 2: Build ingestion**

Run: `pnpm --filter @mytime/ingestion build`
Expected: exit 0. (`web-jsonld` parseProduct/parseOg, woocommerce, hronometar, zia, pandora, mytime-feed all now set `productType`.)

- [ ] **Step 3: Run the full ingestion test suite**

Run: `pnpm --filter @mytime/ingestion test`
Expected: PASS (all source + normalize tests).

- [ ] **Step 4: Commit**

```bash
git add ingestion/src/sources/mytime-feed.ts
git commit -m "feat(ingestion): self-feed emits product type"
```

---

### Task 8: One-time backfill script

**Files:**
- Create: `db/scripts/backfill-taxonomy.mjs`

- [ ] **Step 1: Write the backfill script**

Create `db/scripts/backfill-taxonomy.mjs`:

```js
// One-time backfill: product_type for all active products + gender for Watch Club
// (from stored category) and the monobrand womens vendors. Re-derives from data
// already in the DB — no re-scrape. Idempotent. Run from repo root on the VPS:
//   node db/scripts/backfill-taxonomy.mjs            # dry run (counts only)
//   node db/scripts/backfill-taxonomy.mjs --apply    # write
import pg from "pg";
import { normalizeGender, normalizeType } from "../../ingestion/dist/pipeline/normalize.js";

const APPLY = process.argv.includes("--apply");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_NO_VERIFY === "true" ? { rejectUnauthorized: false } : undefined,
});

// Per-vendor type fallback (monobrands / single-category stores).
const TYPE_FALLBACK = {
  pandora: "jewelry",
  swarovski: "jewelry",
  zia: "jewelry",
  hronometar: "watches",
};
const WOMENS_VENDORS = new Set(["pandora", "swarovski", "zia"]);

const { rows } = await pool.query(
  `SELECT id, target_id, name, category, gender FROM products WHERE active = true`,
);

let typeSet = 0;
let genderSet = 0;
const client = await pool.connect();
try {
  if (APPLY) await client.query("BEGIN");
  for (const r of rows) {
    const type = normalizeType(r.category, r.name, TYPE_FALLBACK[r.target_id] ?? null);

    // gender: only fill where currently null. Watch Club ← category; monobrands ← womens.
    let gender = r.gender;
    if (gender == null) {
      if (r.target_id === "watch-club") gender = normalizeGender(r.category);
      if (gender == null && WOMENS_VENDORS.has(r.target_id)) gender = "womens";
    }

    if (APPLY) {
      if (type != null) {
        await client.query("UPDATE products SET product_type = $1 WHERE id = $2", [type, r.id]);
      }
      if (gender !== r.gender && gender != null) {
        await client.query("UPDATE products SET gender = $1 WHERE id = $2", [gender, r.id]);
      }
    }
    if (type != null) typeSet++;
    if (gender !== r.gender && gender != null) genderSet++;
  }
  if (APPLY) await client.query("COMMIT");
} catch (e) {
  if (APPLY) await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

console.log(
  `${APPLY ? "APPLIED" : "DRY RUN"}: ${rows.length} active products | product_type set: ${typeSet} | gender filled: ${genderSet}`,
);
await pool.end();
process.exit(0);
```

- [ ] **Step 2: Verify it builds/lints**

Run: `pnpm exec biome check db/scripts/backfill-taxonomy.mjs`
Expected: exit 0 (Biome clean). It is a plain `.mjs` (not part of `tsc`).

- [ ] **Step 3: Commit**

```bash
git add db/scripts/backfill-taxonomy.mjs
git commit -m "feat(db): one-time product_type + gender backfill script"
```

(The script is **run** against prod in Task 10, after deploy.)

---

### Task 9: Dashboard reads `product_type`, drops `groupOf()`

**Files:**
- Modify: `mcp-server/src/admin/pages/dashboard.ts`

- [ ] **Step 1: Add `product_type` to the gather queries + payload**

In `mcp-server/src/admin/pages/dashboard.ts`:
(a) `DiscRow`, `MoveRow`, `StockRow` interfaces — add `product_type: string | null;`.
(b) In the on-sale (`disc`) query SELECT, add `p.product_type` to both the inner `onsale` CTE select and the outer select. In the price-moves (`moves`) and stockouts (`stock`) queries, add `p.product_type` to the ranked CTE and carry it through to the final select.
(c) In the payload maps (`discounts`, `priceMoves`, `stockouts`), add `productType: r.product_type` to each item.

- [ ] **Step 2: Replace the category classifier with product_type filtering**

In `DASH_JS`:
(a) Delete the `groupOf(cat,name)` function.
(b) In `renderDiscounts`, change the category `<select id="f-group">` options to the five canonical buckets and have it filter on `d.productType` (instead of `groupOf(...)`). Replace the hard-coded `<option>Watches</option>...` group with:

```js
+'<select id="f-group"><option value="">All types</option>'
+'<option value="watches">Watches</option><option value="jewelry">Jewelry</option>'
+'<option value="accessories">Accessories</option><option value="eyewear">Eyewear</option>'
+'<option value="other">Other</option></select>'
```

and the items filter predicate becomes `(!grp || d.productType===grp)` where `grp` is read from the `#f-group` select.
(c) Wherever the price-moves / stockout tables show a derived group, use `m.productType` / `s.productType` directly.

- [ ] **Step 3: Build + lint**

Run: `pnpm --filter @mytime/mcp-server build && pnpm exec biome check mcp-server/src/admin/pages/dashboard.ts`
Expected: both exit 0. (If Biome reports formatting, run `pnpm exec biome check --write mcp-server/src/admin/pages/dashboard.ts` and re-check.)

- [ ] **Step 4: Smoke-render locally against prod DB is done in Task 10; for now confirm types/JS compile.**

Run: `pnpm --filter @mytime/mcp-server build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/admin/pages/dashboard.ts
git commit -m "feat(admin): dashboard filters on product_type, drop groupOf() classifier"
```

---

### Task 10: Full verification + deploy + backfill run

**Files:** none (ops).

- [ ] **Step 1: Whole-repo build + tests + lint**

Run: `pnpm -r build && pnpm -r test && pnpm exec biome check .`
Expected: all exit 0.

- [ ] **Step 2: Deploy code to the VPS + run the migration**

Push/sync the branch to the VPS repo at `/home/mytime/mytime-bi`, then on the VPS (as user `mytime`, Node-24 PATH):

```bash
export PATH=/home/mytime/.local/node/bin:$PATH
cd ~/mytime-bi
pnpm -r build
pnpm --filter @mytime/db migrate     # applies 0004 (adds product_type column + index)
```

Expected: migrate reports `0004_*` applied.

- [ ] **Step 3: Dry-run the backfill, then apply**

```bash
cd ~/mytime-bi
node db/scripts/backfill-taxonomy.mjs            # DRY RUN — prints counts
node db/scripts/backfill-taxonomy.mjs --apply    # writes
```

Expected: dry run prints `product_type set: ~12000+` and `gender filled: ~2400+` (Watch Club category-derived + Pandora/Zia/Swarovski womens). Apply repeats with `APPLIED`.

- [ ] **Step 4: Restart the service + re-run the coverage audit**

```bash
systemctl restart mytime-mcp && sleep 2 && systemctl is-active mytime-mcp
node db/scripts/../../coverage.mjs 2>/dev/null || true   # or re-run the audit query inline
```

Verify with this inline check (run on the VPS):

```bash
node -e '
import("pg").then(async ({default:pg})=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL, ssl:process.env.DATABASE_SSL_NO_VERIFY==="true"?{rejectUnauthorized:false}:undefined});
  const q=`SELECT t.name,
     count(*) FILTER (WHERE p.active) total,
     round(100.0*count(*) FILTER (WHERE p.active AND p.product_type IS NOT NULL)/NULLIF(count(*) FILTER (WHERE p.active),0)) type_pct,
     round(100.0*count(*) FILTER (WHERE p.active AND p.gender IS NOT NULL)/NULLIF(count(*) FILTER (WHERE p.active),0)) gender_pct
   FROM targets t LEFT JOIN products p ON p.target_id=t.id WHERE t.is_self=false GROUP BY t.name ORDER BY total DESC`;
  const {rows}=await pool.query(q); console.table(rows); await pool.end();
});'
```

Expected: `type_pct` ~100 for every vendor; `gender_pct` high for B-Watch, Saat&Saat, Watch Club, Pandora, Zia, Swarovski. (Bozinovski + Hronometar gender stays 0 until the **next daily ingest** runs the patched collectors — note this; it is expected, not a failure.)

- [ ] **Step 5: Trigger one ingest for the collector-derived vendors (optional, to confirm)**

Run the Bozinovski + Hronometar collectors once (however ingestion is invoked on the VPS — the standard daily entrypoint or a targeted run), then re-run the Step 4 audit and confirm Bozinovski + Hronometar `gender_pct` jump (Bozinovski → ~100 via `pa_sex`, Hronometar → high via the `Пол` spec row).

- [ ] **Step 6: Live dashboard smoke**

Render `/admin` (or call `render({})` as in prior verification) and confirm the discounts/pricing tabs' type `<select>` filters by the five buckets and the vendor/gender filters now have dense data. Confirm no `groupOf` reference remains: `grep -n groupOf mcp-server/src/admin/pages/dashboard.ts` → no matches.

- [ ] **Step 7: Commit any final fixups, then finish the branch**

Use **superpowers:finishing-a-development-branch**.

---

## Self-Review

**1. Spec coverage:**
- normalizeType (5 buckets, eyewear-first, vendor fallback) → Task 1. ✅
- WooCommerce pa_sex/pa_pol + category gender fallback → Task 4. ✅
- Hronometar `Пол` spec row + `Колекција` → Task 5. ✅
- Pandora/Zia/Swarovski womens default (kids preserved) → Task 6 (Zia kids case tested). ✅
- product_type column + index + migration → Task 3. ✅
- Writer persistence + observation field → Task 2. ✅
- Backfill (type all; Watch Club + monobrand gender; Bozinovski/Hronometar deferred to next ingest) → Task 8 + Task 10. ✅
- Dashboard reads column, drops groupOf → Task 9. ✅
- Deferred (Bozinovski brand, rich attributes) → intentionally out, per spec. ✅

**2. Placeholder scan:** No TBD/“handle edge cases”/bare “write tests” — every code step has real code. Two fixtures (`pandora/listing.html`, `web-jsonld/swarovski-og.html`) may need creating from a live fetch; the step says exactly what they must contain. ✅

**3. Type consistency:** `productType` field name used consistently (camel in TS, `product_type` in SQL/Drizzle `excluded.product_type`); `normalizeType(category, name, fallback?)` signature identical across Tasks 1/4/5/6/7; `ProductType` union matches the column comment and the dashboard buckets. `mapProduct`, `parseListing`, `map`, `specValue`, `parseOg(…, opts)` are each exported in the task that first tests them. ✅

**Note for the implementer:** the schema field in Task 2 (`products.productType`) is only valid after Task 3 Step 1. If executing strictly task-by-task, apply Task 3’s schema edit before building Task 2 (call-out included in Task 2 Step 3).
