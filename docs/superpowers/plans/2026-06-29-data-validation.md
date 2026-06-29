# Data Validation + Discount-Capture Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable validator that samples competitor products, fetches each live page independently, diffs every field against the DB (with an LLM drift cross-check), and then fix the systemic competitor discount-capture gap at the collector source and re-ingest.

**Architecture:** New `ingestion/src/validation/` module. A shared FireCrawl fetch feeds two extractors per product — a deterministic per-site **verifier** (ground truth) and a generic **LLM check** (drift signal). A diff engine compares verifier⇄DB (data mismatches) and verifier⇄LLM (structure drift), and a reporter writes dated markdown+JSON. Then per-site collector fixes are diagnosed from the captured live evidence (the WC Store API, for example, does **not** expose real sale prices, so its discount fix requires parsing the rendered page), TDD'd against saved HTML fixtures, and verified by re-running the validator + a fresh `pnpm ingest`.

**Tech Stack:** Node 24 / TS 6 (ESM, NodeNext), Drizzle, Biome, Vitest (existing test runner — confirm in Task 0), FireCrawl (`FIRECRAWL_API_KEY`, already in `.env`), Google Gemini API for the drift check (new `GEMINI_API_KEY`).

---

## Pre-flight facts (verified live during planning)

- `deriveDiscount(regular, sale)` (`ingestion/src/pipeline/normalize.ts`) returns nulls unless `sale < regular`. Correct — the bug is upstream (collectors don't supply a real `sale`).
- `web-jsonld.ts` JSON-LD path hard-passes `deriveDiscount(price, null)` → can never detect a discount (Saat&Saat, Swarovski/Royalhouse).
- `woocommerce.ts` **does** map `sale_price`, but the WC Store API returns `sale_price == regular_price` even when `on_sale=true` (verified on bwatch.mk: 100 products, 1 `on_sale`, 0 with `regular != sale`). **The API is the wrong source for discounts** — the rendered theme shows the sale, the JSON API does not.
- DB latest-day discount counts: every scraped competitor = 0; only MY:TIME (feed) captures discounts.
- `ProductObservation` (`shared/src/observation.ts`) is the collector output contract; prices split into `price`/`salePrice`/`discountAmount`/`discountPct`.

## File structure

```
ingestion/src/validation/
  types.ts            # LiveSnapshot, FieldMismatch, DriftFlag, DbProductRow
  fetch.ts            # fetchLive(url) -> { url, html, markdown } via FireCrawl
  sample.ts           # sampleProducts(db, targetId, n) from latest captured_date
  diff.ts             # diffVsDb(), diffVsLlm() — pure, unit-tested
  llm-check.ts        # llmExtract(markdown) -> LiveSnapshot via Anthropic
  report.ts           # writeReport(results) -> docs/validation/<date>.{md,json}
  verifiers/
    _verifier.ts      # SiteVerifier interface + registry
    woocommerce.ts    # bwatch, bozinovski, watch-club (rendered-page parse)
    web-jsonld.ts     # saat-saat, swarovski/royalhouse
    zia.ts            # zia
    hronometar.ts     # hronometar
    pandora.ts        # pandora
  run.ts              # CLI entrypoint
ingestion/test/validation/
  diff.test.ts
  verifiers/*.test.ts # fixture-based, no network
  fixtures/<site>/*.html
docs/validation/        # report output (gitignored except .gitkeep)
```

Pricing/discount fixes live in the existing collectors under `ingestion/src/sources/`.

---

## Task 0: Confirm test runner + scaffolding

**Files:**
- Inspect: `ingestion/package.json`, repo root `package.json`

- [ ] **Step 1: Determine the test runner**

Run: `cat ingestion/package.json && ls ingestion/test 2>/dev/null; grep -rn "vitest\|jest\|node:test" ingestion package.json 2>/dev/null | head`
Expected: identifies the configured runner (this plan assumes **Vitest**; if the repo uses `node:test`, translate the `describe/it/expect` blocks below to `node:test` + `assert` — the logic is identical).

- [ ] **Step 2: Create the directories**

Run:
```bash
mkdir -p ingestion/src/validation/verifiers ingestion/test/validation/verifiers ingestion/test/validation/fixtures docs/validation
printf '# Validation reports\n' > docs/validation/.gitkeep
```

- [ ] **Step 3: Gitignore generated reports (keep the dir)**

Append to `.gitignore`:
```
docs/validation/*.md
docs/validation/*.json
!docs/validation/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add ingestion/src/validation ingestion/test/validation docs/validation .gitignore
git commit -m "chore(validation): scaffold validation module dirs"
```

---

## Task 1: Core types

**Files:**
- Create: `ingestion/src/validation/types.ts`

- [ ] **Step 1: Write the types**

```ts
import type { StockState } from "@mytime/shared";

/** Normalized snapshot of what a live product page actually shows. */
export interface LiveSnapshot {
  externalId?: string | null;
  name?: string | null;
  brand?: string | null;
  modelRef?: string | null;
  category?: string | null;
  price?: number | null; // regular / list price displayed
  salePrice?: number | null; // displayed sale price when on promo, else null
  stockStatus?: StockState | null;
  attributes?: Record<string, unknown> | null;
}

/** The DB-side view of a product+latest price+stock, for comparison. */
export interface DbProductRow {
  productId: string;
  targetId: string;
  externalId: string;
  url: string | null;
  name: string;
  brand: string | null;
  modelRef: string | null;
  category: string | null;
  price: number | null;
  salePrice: number | null;
  discountPct: number | null;
  stockStatus: StockState | null;
}

export type Severity = "error" | "review";

export interface FieldMismatch {
  field: string;
  dbValue: unknown;
  liveValue: unknown;
  severity: Severity;
  note?: string;
}

/** One product's validation outcome. */
export interface ProductResult {
  targetId: string;
  url: string;
  externalId: string;
  dataMismatches: FieldMismatch[]; // verifier vs DB
  driftFlags: FieldMismatch[]; // verifier vs LLM
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @mytime/ingestion exec tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add ingestion/src/validation/types.ts
git commit -m "feat(validation): core snapshot/mismatch types"
```

---

## Task 2: Diff engine (pure, TDD)

**Files:**
- Create: `ingestion/src/validation/diff.ts`
- Test: `ingestion/test/validation/diff.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { diffVsDb, diffVsLlm } from "../../src/validation/diff.js";
import type { DbProductRow, LiveSnapshot } from "../../src/validation/types.js";

const db = (o: Partial<DbProductRow> = {}): DbProductRow => ({
  productId: "p1", targetId: "t", externalId: "x", url: "u",
  name: "Casio MTP-1", brand: "Casio", modelRef: "MTP-1", category: "Watches",
  price: 1000, salePrice: null, discountPct: null, stockStatus: "in_stock", ...o,
});

describe("diffVsDb", () => {
  it("flags a discount the DB missed as an error", () => {
    const live: LiveSnapshot = { price: 1000, salePrice: 800, stockStatus: "in_stock" };
    const m = diffVsDb(live, db());
    expect(m.find((x) => x.field === "salePrice")?.severity).toBe("error");
  });
  it("ignores price differences within tolerance", () => {
    const live: LiveSnapshot = { price: 1000.4, stockStatus: "in_stock" };
    expect(diffVsDb(live, db()).find((x) => x.field === "price")).toBeUndefined();
  });
  it("flags price differences beyond tolerance as error", () => {
    const live: LiveSnapshot = { price: 1200, stockStatus: "in_stock" };
    expect(diffVsDb(live, db()).find((x) => x.field === "price")?.severity).toBe("error");
  });
  it("flags stock mismatch as error", () => {
    const live: LiveSnapshot = { price: 1000, stockStatus: "out_of_stock" };
    expect(diffVsDb(live, db()).find((x) => x.field === "stockStatus")?.severity).toBe("error");
  });
  it("flags descriptive differences as review, not error", () => {
    const live: LiveSnapshot = { price: 1000, stockStatus: "in_stock", brand: "CASIO inc" };
    expect(diffVsDb(live, db()).find((x) => x.field === "brand")?.severity).toBe("review");
  });
  it("does not flag descriptive fields when the live value is absent", () => {
    const live: LiveSnapshot = { price: 1000, stockStatus: "in_stock", brand: null };
    expect(diffVsDb(live, db()).find((x) => x.field === "brand")).toBeUndefined();
  });
});

describe("diffVsLlm", () => {
  it("flags a price drift between verifier and LLM as review", () => {
    const verifier: LiveSnapshot = { price: 1000, salePrice: 800 };
    const llm: LiveSnapshot = { price: 1000, salePrice: null };
    expect(diffVsLlm(verifier, llm).find((x) => x.field === "salePrice")?.severity).toBe("review");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/validation/diff.test.ts`
Expected: FAIL ("diffVsDb is not a function").

- [ ] **Step 3: Implement `diff.ts`**

```ts
import type { DbProductRow, FieldMismatch, LiveSnapshot } from "./types.js";

const PRICE_TOL_ABS = 1; // MKD
const PRICE_TOL_PCT = 0.01;

const numClose = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(PRICE_TOL_ABS, Math.abs(b) * PRICE_TOL_PCT);

const norm = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Compare the live ground-truth snapshot against the stored DB row. */
export function diffVsDb(live: LiveSnapshot, db: DbProductRow): FieldMismatch[] {
  const out: FieldMismatch[] = [];

  // price (error, with tolerance)
  if (live.price != null && db.price != null && !numClose(live.price, db.price)) {
    out.push({ field: "price", dbValue: db.price, liveValue: live.price, severity: "error" });
  }

  // sale price / discount presence (the headline check, error)
  const liveOnSale = live.salePrice != null && live.price != null && live.salePrice < live.price;
  const dbOnSale = db.salePrice != null;
  if (liveOnSale !== dbOnSale) {
    out.push({
      field: "salePrice", dbValue: db.salePrice, liveValue: live.salePrice ?? null,
      severity: "error",
      note: liveOnSale ? "live shows a discount the DB missed" : "DB has a discount the live page no longer shows",
    });
  } else if (liveOnSale && dbOnSale && live.salePrice != null && db.salePrice != null && !numClose(live.salePrice, db.salePrice)) {
    out.push({ field: "salePrice", dbValue: db.salePrice, liveValue: live.salePrice, severity: "error" });
  }

  // stock (error, exact)
  if (live.stockStatus != null && db.stockStatus != null && live.stockStatus !== db.stockStatus) {
    out.push({ field: "stockStatus", dbValue: db.stockStatus, liveValue: live.stockStatus, severity: "error" });
  }

  // descriptive fields (review only, skip when live absent)
  for (const f of ["name", "brand", "modelRef", "category"] as const) {
    const lv = live[f];
    if (lv == null) continue;
    if (norm(lv) !== norm(db[f])) {
      out.push({ field: f, dbValue: db[f], liveValue: lv, severity: "review" });
    }
  }
  return out;
}

/** Drift signal: verifier vs the LLM's independent read of the same page. */
export function diffVsLlm(verifier: LiveSnapshot, llm: LiveSnapshot): FieldMismatch[] {
  const out: FieldMismatch[] = [];
  const onSale = (s: LiveSnapshot) => s.salePrice != null && s.price != null && s.salePrice < s.price;
  if (verifier.price != null && llm.price != null && !numClose(verifier.price, llm.price)) {
    out.push({ field: "price", dbValue: verifier.price, liveValue: llm.price, severity: "review", note: "verifier vs LLM price drift" });
  }
  if (onSale(verifier) !== onSale(llm)) {
    out.push({ field: "salePrice", dbValue: verifier.salePrice ?? null, liveValue: llm.salePrice ?? null, severity: "review", note: "verifier vs LLM disagree on sale — possible layout drift" });
  }
  for (const f of ["name", "brand", "stockStatus"] as const) {
    if (verifier[f] != null && llm[f] != null && norm(verifier[f]) !== norm(llm[f])) {
      out.push({ field: f, dbValue: verifier[f], liveValue: llm[f], severity: "review", note: "verifier vs LLM drift" });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/validation/diff.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/validation/diff.ts ingestion/test/validation/diff.test.ts
git commit -m "feat(validation): pure diff engine with DB + LLM-drift comparisons"
```

---

## Task 3: FireCrawl fetch

**Files:**
- Create: `ingestion/src/validation/fetch.ts`

- [ ] **Step 1: Implement `fetch.ts`**

```ts
import { requireEnv } from "@mytime/shared";

export interface FetchedPage {
  url: string;
  html: string;
  markdown: string;
}

/** Fetch a fully-rendered page once via FireCrawl /scrape (html + markdown). */
export async function fetchLive(url: string): Promise<FetchedPage> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireEnv("FIRECRAWL_API_KEY")}`,
    },
    body: JSON.stringify({ url, formats: ["html", "markdown"], onlyMainContent: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`FireCrawl scrape HTTP ${res.status} for ${url}`);
  const json = (await res.json()) as { data?: { html?: string; markdown?: string } };
  return { url, html: json.data?.html ?? "", markdown: json.data?.markdown ?? "" };
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm --filter @mytime/ingestion exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Smoke-test against one real URL (manual, throwaway)**

Run (from VPS where egress is clean, or locally if reachable):
```bash
node --env-file=.env -e "import('./ingestion/dist/validation/fetch.js').then(async m=>{const p=await m.fetchLive('https://saat-saat.mk/');console.log('html',p.html.length,'md',p.markdown.length)})"
```
Expected: non-zero html/markdown lengths. (Build first: `pnpm --filter @mytime/ingestion build`.)

- [ ] **Step 4: Commit**

```bash
git add ingestion/src/validation/fetch.ts
git commit -m "feat(validation): FireCrawl render fetch (html+markdown)"
```

---

## Task 4: Verifier interface + registry

**Files:**
- Create: `ingestion/src/validation/verifiers/_verifier.ts`

- [ ] **Step 1: Implement the interface + registry**

```ts
import type { LiveSnapshot } from "../types.js";

export interface SiteVerifier {
  /** target ids this verifier handles. */
  targets: string[];
  /** Extract ground truth from a fetched page (html primary, markdown optional). */
  extract(html: string, markdown: string, url: string): LiveSnapshot;
}

import { woocommerceVerifier } from "./woocommerce.js";
import { webJsonLdVerifier } from "./web-jsonld.js";
import { ziaVerifier } from "./zia.js";
import { hronometarVerifier } from "./hronometar.js";
import { pandoraVerifier } from "./pandora.js";

export const verifiers: SiteVerifier[] = [
  woocommerceVerifier,
  webJsonLdVerifier,
  ziaVerifier,
  hronometarVerifier,
  pandoraVerifier,
];

export function verifierFor(targetId: string): SiteVerifier | undefined {
  return verifiers.find((v) => v.targets.includes(targetId));
}
```

(Compilation will fail until the verifier files exist — that is expected; Task 5 adds them. If executing strictly task-by-task, create empty stub exports first, then fill in Task 5.)

- [ ] **Step 2: Commit (after Task 5 compiles)**

```bash
git add ingestion/src/validation/verifiers/_verifier.ts
git commit -m "feat(validation): site verifier interface + registry"
```

---

## Task 5: Per-site verifiers (fixture-driven TDD) — repeat for each site

This task is **repeated once per verifier file**: `web-jsonld` (do FIRST — Saat&Saat is the known case), then `woocommerce`, `zia`, `hronometar`, `pandora`. The loop is identical; the selectors differ per site and are written from the captured fixture.

**Files (per site `S`):**
- Create: `ingestion/src/validation/verifiers/<S>.ts`
- Test: `ingestion/test/validation/verifiers/<S>.test.ts`
- Fixture: `ingestion/test/validation/fixtures/<S>/<sku>.html`

- [ ] **Step 1: Capture a real fixture from a product KNOWN to be on sale**

Run (from the VPS for clean egress; pick a product the user can see is discounted):
```bash
# example for saat-saat — replace URL with a live discounted product
curl -fsSL -A 'MyTimeBI/1.0' '<live-discounted-product-url>' -o ingestion/test/validation/fixtures/saat-saat/<sku>.html
# inspect where the regular vs sale price render:
grep -oiE 'class="[^"]*(price|sale|old|discount|namaluvanje)[^"]*"|<del>|<ins>' ingestion/test/validation/fixtures/saat-saat/<sku>.html | sort -u | head
grep -oiE 'application/ld\+json' ingestion/test/validation/fixtures/saat-saat/<sku>.html | head
```
Expected: identifies the markup (struck `<del>`/`old-price` + `<ins>`/`sale-price`, or JSON-LD offers). Record the displayed regular and sale numbers you can see on the page — those become the test's expected values.

- [ ] **Step 2: Write the failing extraction test from the fixture**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webJsonLdVerifier } from "../../../src/validation/verifiers/web-jsonld.js";

const html = readFileSync(new URL("../fixtures/saat-saat/<sku>.html", import.meta.url), "utf8");

describe("saat-saat verifier", () => {
  it("extracts the regular AND sale price the page displays", () => {
    const s = webJsonLdVerifier.extract(html, "", "https://saat-saat.mk/...");
    expect(s.price).toBeCloseTo(<REGULAR_FROM_PAGE>, 0);
    expect(s.salePrice).toBeCloseTo(<SALE_FROM_PAGE>, 0);
  });
  it("reads the product name", () => {
    expect(webJsonLdVerifier.extract(html, "", "u").name).toContain("<expected-substring>");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/validation/verifiers/web-jsonld.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `extract()` parsing the fixture's actual markup**

Skeleton (fill selectors from Step 1). Use a tolerant HTML approach — regex for price nodes plus a JSON-LD parse fallback. Example shape:

```ts
import type { SiteVerifier } from "./_verifier.js";
import type { LiveSnapshot } from "../types.js";

const num = (s?: string | null): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.,]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const firstMatch = (html: string, re: RegExp): string | null => re.exec(html)?.[1] ?? null;

export const webJsonLdVerifier: SiteVerifier = {
  targets: ["saat-saat", "swarovski"],
  extract(html: string): LiveSnapshot {
    // 1) prefer visible struck/sale markup (the source of truth the customer sees)
    const regular = num(firstMatch(html, /<del[^>]*>[\s\S]*?([\d.,]+)\s*ден[\s\S]*?<\/del>/i))
      ?? num(firstMatch(html, /class="[^"]*old[^"]*price[^"]*"[^>]*>\s*([\d.,]+)/i));
    const sale = num(firstMatch(html, /<ins[^>]*>[\s\S]*?([\d.,]+)\s*ден[\s\S]*?<\/ins>/i))
      ?? num(firstMatch(html, /class="[^"]*sale[^"]*price[^"]*"[^>]*>\s*([\d.,]+)/i));
    const single = num(firstMatch(html, /class="[^"]*price[^"]*"[^>]*>\s*([\d.,]+)/i));
    const name = firstMatch(html, /<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i)?.replace(/<[^>]+>/g, "").trim() ?? null;
    return {
      name,
      price: regular ?? single ?? null,
      salePrice: regular != null ? (sale ?? null) : null, // only a discount if there is an original
    };
  },
};
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @mytime/ingestion exec vitest run test/validation/verifiers/web-jsonld.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit, then repeat Steps 1–5 for the next site**

```bash
git add ingestion/src/validation/verifiers/web-jsonld.ts ingestion/test/validation/verifiers/web-jsonld.test.ts ingestion/test/validation/fixtures/web-jsonld 2>/dev/null
git add ingestion/test/validation/fixtures/saat-saat
git commit -m "feat(validation): saat-saat/swarovski verifier (rendered price extraction)"
```

Repeat for: `woocommerce.ts` (parse the **rendered product page** for `<del>`/`<ins>` — NOT the Store API, which we verified hides discounts), `zia.ts`, `hronometar.ts`, `pandora.ts`. Each gets its own fixture from a known-discounted product, its own test with page-observed numbers, and its own `extract()`.

---

## Task 6: LLM drift check (Gemini)

**Files:**
- Create: `ingestion/src/validation/llm-check.ts`
- Modify: `.env` and `.env.example` (add `GEMINI_API_KEY`)

- [ ] **Step 1: Add the env var**

Append to `.env.example`:
```
# Validation drift cross-check (Google Gemini API)
GEMINI_API_KEY=
```
Add the real key to `.env` (user supplies; do not commit).

- [ ] **Step 2: Implement `llm-check.ts`**

```ts
import { optionalEnv } from "@mytime/shared";
import type { LiveSnapshot } from "./types.js";

const MODEL = "gemini-2.5-flash";
const SYS =
  "Extract product facts from the page markdown as STRICT JSON with keys " +
  "name, brand, price (number, regular/list price), salePrice (number or null, " +
  "the discounted price if shown), stockStatus (one of in_stock,out_of_stock,low_stock,unknown). " +
  "Prices are Macedonian denar; return plain numbers. Output JSON only.";

/** Independent LLM read of the page — used ONLY as a drift signal, never as truth. */
export async function llmExtract(markdown: string): Promise<LiveSnapshot | null> {
  const key = optionalEnv("GEMINI_API_KEY");
  if (!key) return null; // drift check is optional; skip cleanly when unconfigured
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYS }] },
      contents: [{ parts: [{ text: markdown.slice(0, 12_000) }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 400 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as LiveSnapshot;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Verify compile**

Run: `pnpm --filter @mytime/ingestion exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ingestion/src/validation/llm-check.ts .env.example
git commit -m "feat(validation): optional Gemini LLM drift cross-check"
```

---

## Task 7: Sampling

**Files:**
- Create: `ingestion/src/validation/sample.ts`

- [ ] **Step 1: Implement `sample.ts`**

```ts
import { sql } from "drizzle-orm";
import type { Pool } from "@mytime/shared";
import { createDb } from "@mytime/db";
import type { DbProductRow } from "./types.js";

/** Sample up to n products for a target from the latest captured_date,
 *  biased toward items already flagged on-sale, then random. */
export async function sampleProducts(
  dbUrl: string,
  targetId: string,
  n: number,
): Promise<DbProductRow[]> {
  const db = createDb(dbUrl);
  const r = await db.execute(sql`
    with latest as (select max(captured_date) d from prices)
    select pr.id as "productId", pr.target_id as "targetId", pr.external_id as "externalId",
           pr.url, pr.name, pr.brand, pr.model_ref as "modelRef", pr.category,
           p.price::float8 as price, p.sale_price::float8 as "salePrice",
           p.discount_pct::float8 as "discountPct",
           i.stock_status as "stockStatus"
    from products pr
    join latest on true
    join prices p on p.product_id = pr.id and p.captured_date = latest.d
    left join inventory_snapshots i on i.product_id = pr.id and i.captured_date = latest.d
    where pr.target_id = ${targetId} and pr.url is not null
    order by (p.sale_price is not null) desc, random()
    limit ${n}`);
  return (r.rows ?? r) as unknown as DbProductRow[];
}
```

(Verify the actual column names against `db/src/schema.ts` while implementing — adjust `pr.url`/`pr.external_id`/`i.stock_status` to the real columns; the planning grep confirmed `products`, `prices`, `inventory_snapshots` exist with per-day rows.)

- [ ] **Step 2: Verify compile + a live count**

Run: `pnpm --filter @mytime/ingestion build && node --env-file=.env -e "import('./ingestion/dist/validation/sample.js').then(async m=>{const r=await m.sampleProducts(process.env.DATABASE_URL,'saat-saat',5);console.log(r.length, r[0])})"`
Expected: prints up to 5 rows with a url.

- [ ] **Step 3: Commit**

```bash
git add ingestion/src/validation/sample.ts
git commit -m "feat(validation): product sampling from latest captured_date"
```

---

## Task 8: Reporter

**Files:**
- Create: `ingestion/src/validation/report.ts`

- [ ] **Step 1: Implement `report.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { ProductResult } from "./types.js";

export function writeReport(results: ProductResult[], dateIso: string): { md: string; json: string } {
  mkdirSync("docs/validation", { recursive: true });
  const md = `docs/validation/${dateIso}-validation.md`;
  const json = `docs/validation/${dateIso}-validation.json`;

  const byTarget = new Map<string, ProductResult[]>();
  for (const r of results) (byTarget.get(r.targetId) ?? byTarget.set(r.targetId, []).get(r.targetId)!).push(r);

  let out = `# Validation report — ${dateIso}\n\n`;
  for (const [t, rs] of byTarget) {
    const errs = rs.flatMap((r) => r.dataMismatches.filter((m) => m.severity === "error"));
    const drift = rs.flatMap((r) => r.driftFlags);
    out += `## ${t} — ${rs.length} sampled, ${errs.length} data errors, ${drift.length} drift flags\n\n`;
    for (const r of rs) {
      const e = r.dataMismatches.filter((m) => m.severity === "error");
      if (!e.length && !r.driftFlags.length) continue;
      out += `- ${r.externalId} <${r.url}>\n`;
      for (const m of e) out += `  - **${m.field}** db=${JSON.stringify(m.dbValue)} live=${JSON.stringify(m.liveValue)}${m.note ? ` (${m.note})` : ""}\n`;
      for (const m of r.driftFlags) out += `  - _drift_ ${m.field}: verifier=${JSON.stringify(m.dbValue)} llm=${JSON.stringify(m.liveValue)}\n`;
    }
    out += "\n";
  }
  writeFileSync(md, out);
  writeFileSync(json, JSON.stringify(results, null, 2));
  return { md, json };
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm --filter @mytime/ingestion exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ingestion/src/validation/report.ts
git commit -m "feat(validation): markdown+json report writer"
```

---

## Task 9: CLI runner (wires it together)

**Files:**
- Create: `ingestion/src/validation/run.ts`
- Modify: root `package.json` (add `"validate": "node ingestion/dist/validation/run.js"` script)

- [ ] **Step 1: Implement `run.ts`**

```ts
import { fileURLToPath } from "node:url";
import { loadTargets, logger, optionalEnv, requireEnv } from "@mytime/shared";
import { diffVsDb, diffVsLlm } from "./diff.js";
import { fetchLive } from "./fetch.js";
import { llmExtract } from "./llm-check.js";
import { writeReport } from "./report.js";
import { sampleProducts } from "./sample.js";
import type { ProductResult } from "./types.js";
import { verifierFor } from "./verifiers/_verifier.js";

const csv = (v?: string): string[] | null => (v ? v.split(",").map((s) => s.trim()) : null);

async function main(): Promise<void> {
  const dbUrl = requireEnv("DATABASE_URL");
  const sample = Number(optionalEnv("VALIDATE_SAMPLE", "25"));
  const onlyTargets = csv(optionalEnv("VALIDATE_TARGETS"));
  const targets = loadTargets("config/targets.json").filter(
    (t) => !t.is_self && (!onlyTargets || onlyTargets.includes(t.id)) && verifierFor(t.id),
  );
  const dateIso = new Date().toISOString().slice(0, 10);
  const results: ProductResult[] = [];

  for (const t of targets) {
    const verifier = verifierFor(t.id);
    if (!verifier) continue;
    const rows = await sampleProducts(dbUrl, t.id, sample);
    logger.info({ target: t.id, sampled: rows.length }, "validating");
    for (const row of rows) {
      if (!row.url) continue;
      try {
        const page = await fetchLive(row.url);
        const truth = verifier.extract(page.html, page.markdown, row.url);
        const llm = await llmExtract(page.markdown).catch(() => null);
        results.push({
          targetId: t.id, url: row.url, externalId: row.externalId,
          dataMismatches: diffVsDb(truth, row),
          driftFlags: llm ? diffVsLlm(truth, llm) : [],
        });
      } catch (err) {
        logger.error({ target: t.id, url: row.url, err }, "validation fetch failed (isolated)");
      }
    }
  }

  const { md } = writeReport(results, dateIso);
  const errors = results.reduce((a, r) => a + r.dataMismatches.filter((m) => m.severity === "error").length, 0);
  logger.info({ products: results.length, errors, report: md }, "validation complete");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    logger.error({ err }, "fatal validation error");
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add the root script**

In root `package.json` scripts: `"validate": "node ingestion/dist/validation/run.js"`.

- [ ] **Step 3: Build + Biome + run the first real validation**

Run:
```bash
pnpm --filter @mytime/ingestion build && pnpm exec biome check --write ingestion/src/validation
VALIDATE_TARGETS=saat-saat VALIDATE_SAMPLE=10 pnpm validate
cat docs/validation/*-validation.md
```
Expected: a report showing `salePrice` **error** rows for Saat&Saat products that are live-discounted (proving detection works).

- [ ] **Step 4: Commit**

```bash
git add ingestion/src/validation/run.ts package.json
git commit -m "feat(validation): CLI runner + pnpm validate script"
```

---

## Task 10: Diagnose → fix each collector → re-validate (per site)

For each site where the validator reports `salePrice` **errors**, fix the collector so future daily runs capture the discount. **Repeat per affected collector.**

- [ ] **Step 1: Read the validator evidence + the captured fixture** to confirm where the real sale price lives (rendered markup vs API vs JSON-LD).

- [ ] **Step 2: Fix the collector at the right source.** Known cases:
  - **web-jsonld** (`ingestion/src/sources/web-jsonld.ts`): stop passing `deriveDiscount(price, null)`. Parse the original+sale from the rendered HTML (mirror the verifier's `<del>`/`<ins>` logic) or from JSON-LD `priceSpecification`. Wire both into `deriveDiscount(regular, sale)`.
  - **woocommerce** (`ingestion/src/sources/woocommerce.ts`): the Store API hides discounts (verified). Add a rendered-page price read for items where `on_sale` is true OR always, using the same `<del>`/`<ins>` parse as the woocommerce verifier; pass the discovered sale into `deriveDiscount`. (Budget: this adds a page fetch per product — gate it behind `on_sale` or a sale-badge heuristic to limit cost; if the API truly never exposes sales, fetch the listing/product page for the sale price.)
  - **zia / hronometar / pandora**: apply the same pattern — read the displayed regular+sale, feed `deriveDiscount`.

- [ ] **Step 3: Add/extend the collector's own unit test** asserting the corrected discount extraction against the same fixture used by the verifier (TDD: write the failing assertion first, then fix).

Run: `pnpm --filter @mytime/ingestion exec vitest run`
Expected: PASS.

- [ ] **Step 4: Re-validate the site** and confirm the `salePrice` errors are gone:

Run: `pnpm --filter @mytime/ingestion build && VALIDATE_TARGETS=<site> VALIDATE_SAMPLE=15 pnpm validate && cat docs/validation/*-validation.md`
Expected: 0 (or near-0, accounting for items whose sale ended) `salePrice` errors for that site.

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/sources/<site>.ts ingestion/test/...
git commit -m "fix(ingestion): capture <site> sale price/discount at source"
```

---

## Task 11: Re-ingest today + verify discounts land in the DB

**Files:** none (operational)

- [ ] **Step 1: Run full ingestion (overwrites today's rows, idempotent)**

Run (on the VPS, matching prod): `cd /home/mytime/mytime-bi && git pull-equivalent (ship via the documented deploy), then run the ingest`. Locally for verification:
```bash
pnpm ingest
```

- [ ] **Step 2: Confirm competitor discounts are no longer uniformly zero**

Run:
```bash
node --env-file=.env -e "import('@mytime/db').then(async({createDb})=>{const {sql}=await import('drizzle-orm');const db=createDb(process.env.DATABASE_URL);const r=await db.execute(sql\`select t.id,count(*) filter(where p.discount_pct>0) as disc from prices p join products pr on pr.id=p.product_id join targets t on t.id=pr.target_id where p.captured_date=(select max(captured_date) from prices) group by t.id order by t.id\`);console.table(r.rows??r);process.exit(0)})"
```
Expected: scraped competitors now show non-zero discount counts that match what the validator (and the user) can see live.

- [ ] **Step 3: Final full test + build**

Run: `pnpm -r build && pnpm --filter @mytime/ingestion exec vitest run && pnpm exec biome check`
Expected: all green.

---

## Self-review notes (addressed)

- **Spec coverage:** validator (Tasks 1–9) covers all-field validation, reusable form, verifier+LLM hybrid, sampling, report; correction (Tasks 10–11) covers fix-collectors + re-ingest. ✓
- **WC discrepancy:** spec assumed "collector ignores sale_price"; live diagnosis proved the Store API hides discounts — Task 10 reflects the corrected, page-parse fix. ✓
- **Type consistency:** `LiveSnapshot`/`DbProductRow`/`FieldMismatch`/`ProductResult` defined in Task 1 and used unchanged in Tasks 2,5,6,7,8,9. `verifierFor`/`SiteVerifier` defined Task 4, used Task 9. ✓
- **Deferred/uncertain:** exact per-site selectors and the `sample.ts` column names are confirmed against live fixtures/schema *during* execution (Task 5 Step 1, Task 7 Step 1) rather than guessed — by design, since the whole point is that assumptions were wrong.
```
