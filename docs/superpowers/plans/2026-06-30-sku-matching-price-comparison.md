# SKU Matching + Price Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Tasks are grouped into **parallel waves** — tasks in the same wave touch disjoint files and run concurrently in isolated git worktrees; waves are sequential. Steps use `- [ ]`.

**Goal:** Extract real manufacturer references per vendor, widen cross-vendor SKU overlap, and add a `compare_skus` MCP tool for head-to-head price comparison.

**Architecture:** A shared `parseModelRef`/`normalizeModelKey`/`brandMatchKey` in the ingestion normalize layer feeds every collector + a backfill (no re-scrape — refs are recovered from stored `name`/`sku`). A new MCP tool joins MY:TIME to each competitor on the normalized key (query-time), brand-aware and Casio/G-Shock-correct.

**Tech Stack:** TS 6 ESM (`.js` specifiers), Vitest 3, Biome 2, Postgres. Repo: `C:\Users\DRAGAN.SALDJIEV\mytime-bi`. Spec: `docs/superpowers/specs/2026-06-30-sku-matching-price-comparison-design.md`.

**Execution waves:**
- **Wave 1 (concurrent):** Task 1 (shared helpers) ‖ Task 4 (MCP tool — independent, query-time SQL).
- **Wave 2 (concurrent, after Task 1 merged):** Task 2 (woocommerce) ‖ Task 3 (other collectors) ‖ Task 5 (backfill).
- **Wave 3 (solo):** Task 6 — integrate, build, run backfill on prod, verify overlap, deploy.

---

### Task 1 — Shared reference + match helpers  *(Wave 1)*

**Files:** Modify `ingestion/src/pipeline/normalize.ts`; Test `ingestion/test/model-ref.test.ts` (create).

- [ ] **Step 1 — failing test** (`ingestion/test/model-ref.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { brandMatchKey, normalizeModelKey, parseModelRef } from "../src/pipeline/normalize.js";

describe("parseModelRef", () => {
  it("prefers a real sku over name/slug", () => {
    expect(parseModelRef("CARSON", "H76615130", "carson-4")).toBe("H76615130");
  });
  it("ignores a numeric db-id sku and finds the code in the name", () => {
    expect(parseModelRef("Casio Timeless A168WA-1W", "24602", "casio-timeless-a168wa-1w")).toBe(
      "A168WA-1W",
    );
  });
  it("extracts a dotted manufacturer code mid-name", () => {
    expect(parseModelRef("PIERRE CARDIN CF.1019.LB.1", null, null)).toBe("CF.1019.LB.1");
  });
  it("extracts a leading code", () => {
    expect(parseModelRef("JC1L359M0075 Eterna Set", null, null)).toBe("JC1L359M0075");
  });
  it("falls back to the slug when the name has no code", () => {
    expect(parseModelRef("Notes of Coral", null, "notes-of-coral")).toBe("NOTES-OF-CORAL");
  });
  it("returns null when there is nothing usable", () => {
    expect(parseModelRef("Watch", null, null)).toBeNull();
  });
});

describe("normalizeModelKey", () => {
  it("strips punctuation and uppercases", () => {
    expect(normalizeModelKey("A168WA-1W")).toBe("A168WA1W");
    expect(normalizeModelKey("dkj.5.50006-3")).toBe("DKJ5500063");
  });
  it("returns null for keys shorter than 5 alphanumerics", () => {
    expect(normalizeModelKey("AB-1")).toBeNull();
    expect(normalizeModelKey(null)).toBeNull();
  });
});

describe("brandMatchKey", () => {
  it("collapses Casio sub-lines and flags G-Shock", () => {
    expect(brandMatchKey("Casio Timeless", "A168WA-1W")).toEqual({ brand: "CASIO", isGShock: false });
    expect(brandMatchKey("Casio Vintage", "...")).toEqual({ brand: "CASIO", isGShock: false });
    expect(brandMatchKey("Casio", "G-SHOCK GA-2100")).toEqual({ brand: "CASIO", isGShock: true });
  });
  it("passes other brands through uppercased; empty when unknown", () => {
    expect(brandMatchKey("Seiko", "SPB375J1")).toEqual({ brand: "SEIKO", isGShock: false });
    expect(brandMatchKey(null, "x")).toEqual({ brand: "", isGShock: false });
  });
});
```

- [ ] **Step 2 — run, expect FAIL:** `pnpm --filter @mytime/ingestion exec vitest run test/model-ref.test.ts`

- [ ] **Step 3 — implement** (append to `ingestion/src/pipeline/normalize.ts`):

```ts
/** True for strings that look like a manufacturer reference (not a pure db id). */
function refScore(raw: string): number {
  const t = raw.replace(/[(),]/g, "").trim();
  if (t.length < 5) return 0;
  if (/^[0-9]+$/.test(t)) return 0; // pure number → a db id / year, not a ref
  if (!/[0-9]/.test(t)) return 0; // no digit → a word
  if (!/^[A-Za-z0-9.\-/]+$/.test(t)) return 0; // contains spaces/other → not a single code
  let s = t.length;
  if (/[.\-/]/.test(t)) s += 3; // internal separators are ref-like
  if (/[A-Za-z]/.test(t) && /[0-9]/.test(t)) s += 3; // mixed letters+digits
  return s;
}

/**
 * Best manufacturer reference from a product: a ref-like `sku`, else the most
 * ref-like token anywhere in the `name`, else the `slug`. Uppercased. Used as the
 * cross-vendor match key (after normalizeModelKey). Returns null if nothing usable.
 */
export function parseModelRef(
  name: string | null,
  sku: string | null,
  slug: string | null,
): string | null {
  if (sku && refScore(sku) > 0) return sku.replace(/[(),]/g, "").trim().toUpperCase();
  let best: string | null = null;
  let bestScore = 0;
  for (const tok of (name ?? "").split(/\s+/)) {
    const sc = refScore(tok);
    if (sc > bestScore) {
      bestScore = sc;
      best = tok.replace(/[(),]/g, "").trim();
    }
  }
  if (best) return best.toUpperCase();
  const s = (slug ?? "").trim();
  return s.length >= 5 ? s.toUpperCase() : null;
}

/** Cross-vendor match key: uppercase alphanumerics only; null if < 5 chars. */
export function normalizeModelKey(ref: string | null): string | null {
  const k = (ref ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k.length >= 5 ? k : null;
}

/** Brand normalized for matching: Casio sub-lines collapsed; G-Shock flagged. */
export function brandMatchKey(
  brand: string | null,
  name: string | null,
): { brand: string; isGShock: boolean } {
  const b = (brand ?? "").toUpperCase().trim();
  const hay = `${b} ${(name ?? "").toUpperCase()}`;
  const isGShock = /G[\s-]?SHOCK/.test(hay);
  const norm = b.startsWith("CASIO") ? "CASIO" : b;
  return { brand: norm, isGShock };
}
```

- [ ] **Step 4 — run, expect PASS** (all). **Step 5 — Biome** `--write` both files, recheck.
- [ ] **Step 6 — commit:** `git add ingestion/src/pipeline/normalize.ts ingestion/test/model-ref.test.ts && git commit -m "feat(ingestion): parseModelRef + normalizeModelKey + brandMatchKey"`

---

### Task 4 — `compare_skus` MCP tool  *(Wave 1 — independent; query-time SQL, no Task 1 dep)*

**Files:** Modify `mcp-server/src/tools/index.ts` (register + implement). (If the file is large, a `mcp-server/src/tools/compareSkus.ts` module imported by index is fine — match the existing tool structure.)

- [ ] **Step 1 — inspect** an existing tool in `mcp-server/src/tools/index.ts` (e.g. `price_assortment`) to copy the exact shape: `{ name, title, description, inputSchema, requiredRole, run(pool, args) }`. `inputSchema` uses the same zod/shape style already present. `run` receives the read `pool`.

- [ ] **Step 2 — implement** `compare_skus` with `requiredRole: "analyst"`, `inputSchema` = an optional `competitor` string (a target id). The `run(pool, { competitor })` executes:

```sql
WITH latest AS (
  SELECT DISTINCT ON (product_id) product_id, COALESCE(sale_price, price)::float8 AS eff
  FROM prices ORDER BY product_id, captured_date DESC
),
norm AS (
  SELECT t.is_self, p.target_id,
    regexp_replace(upper(p.model_ref), '[^A-Z0-9]', '', 'g') AS key,
    p.name, p.brand, l.eff,
    CASE WHEN upper(coalesce(p.brand,'')) LIKE 'CASIO%' THEN 'CASIO'
         ELSE upper(coalesce(p.brand,'')) END AS bkey,
    (upper(coalesce(p.brand,'') || ' ' || p.name) ~ 'G[ -]?SHOCK') AS gshock
  FROM products p JOIN targets t ON t.id = p.target_id
  JOIN latest l ON l.product_id = p.id
  WHERE p.active AND p.model_ref IS NOT NULL
    AND length(regexp_replace(upper(p.model_ref),'[^A-Z0-9]','','g')) >= 5
),
mt AS (
  SELECT key, max(name) AS name, max(bkey) AS bkey, bool_or(gshock) AS gshock, min(eff) AS eff
  FROM norm WHERE is_self GROUP BY key
),
comp AS (
  SELECT target_id, key, max(name) AS name, max(bkey) AS bkey, bool_or(gshock) AS gshock, min(eff) AS eff
  FROM norm WHERE NOT is_self GROUP BY target_id, key
)
SELECT comp.target_id, mt.key, mt.name AS mt_name, comp.name AS comp_name,
  mt.eff AS mt_price, comp.eff AS comp_price,
  round(100.0*(comp.eff - mt.eff)/NULLIF(comp.eff,0)) AS mt_vs_comp_pct
FROM mt JOIN comp ON comp.key = mt.key
  AND (mt.bkey = comp.bkey OR mt.bkey = '' OR comp.bkey = '')
  AND mt.gshock = comp.gshock
WHERE ($1::text IS NULL OR comp.target_id = $1)
ORDER BY comp.target_id, abs(mt.eff - comp.eff) DESC
```

Run with param `[competitor ?? null]`. Then in JS, group rows by `target_id` into:
`{ competitor, matches, mytimeCheaper, competitorCheaper, same, items: top 50 by |Δ| as { ref, mytime, competitor, mtName, deltaPct } }`. Return `{ comparedAt: <date>, results: [...] }`. Keep the per-competitor `items` capped (≤ 50) to bound payload.

- [ ] **Step 3 — register** the tool in the `tools` array. **Step 4 — build** `pnpm --filter @mytime/mcp-server build` (exit 0). **Step 5 — Biome** clean.
- [ ] **Step 6 — commit:** `git commit -am "feat(mcp): compare_skus head-to-head price tool"` (only the tool files).

> Note: results are weak until Task 5's backfill runs (Wave 3); that's expected — the tool is correct regardless of how many refs are populated.

---

### Task 2 — WooCommerce model_ref via parseModelRef  *(Wave 2)*

**Files:** Modify `ingestion/src/sources/woocommerce.ts`; update `ingestion/test/sources/woocommerce.test.ts`.

- [ ] **Step 1 — failing test** (append to `woocommerce.test.ts`, reuse the existing `wc(...)` fixture helper from the gender tests; add `sku`/`slug` fields):

```ts
describe("mapProduct model_ref", () => {
  it("uses the sku when it is a real reference (Bozinovski)", () => {
    const o = mapProduct(wc({ name: "CARSON", sku: "H76615130", slug: "carson-4" }) as never);
    expect(o.modelRef).toBe("H76615130");
  });
  it("extracts the code from the name when sku is a numeric id (Watch Club)", () => {
    const o = mapProduct(
      wc({ name: "PIERRE CARDIN CF.1019.LB.1", sku: "39027", slug: "pierre-cardin-cf-1019-lb-1" }) as never,
    );
    expect(o.modelRef).toBe("CF.1019.LB.1");
  });
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `parseModelRef` to the normalize import in `woocommerce.ts`. In `mapProduct`, replace `modelRef: p.slug ? p.slug.toUpperCase() : null,` with:

```ts
    modelRef: parseModelRef(cleanText(p.name), cleanText(p.sku), cleanText(p.slug)),
```

(Confirm `WcProduct` has `sku` + `slug` fields; both are read elsewhere — `externalId: String(p.sku || p.id)`, `modelRef: p.slug…`. They exist.)

- [ ] **Step 4 — run, expect PASS** (incl. existing gender/type/sale tests). **Step 5 — build + Biome.**
- [ ] **Step 6 — commit** the two files.

---

### Task 3 — Route remaining collectors through parseModelRef  *(Wave 2)*

**Files:** Modify `ingestion/src/sources/mytime-feed.ts`, `web-jsonld.ts`, `hronometar.ts`, `zia.ts`, `pandora.ts`; touch their tests where they assert `modelRef`.

- [ ] **Step 1 — for each collector**, import `parseModelRef` and set `modelRef` from the best available fields (keep behavior equal-or-better):
  - `mytime-feed.ts`: `modelRef: parseModelRef(name, cleanText(it.sku ?? null), null)` (was `parseModelFromName(name)`). Fixes mid-name Casio codes.
  - `web-jsonld.ts` `parseProduct`: `modelRef: parseModelRef(name, cleanText(node.mpn ?? node.sku ?? null), null)` (was `nameCode ?? parseModelFromName`). `parseOg`: `modelRef: parseModelRef(name, null, null)`.
  - `hronometar.ts` `parseNop`: `modelRef: parseModelRef(name, null, null)` (was a page code; keep the page code if it already computes one — pass it as the `sku` arg so it wins when present: `parseModelRef(name, code ?? null, null)`).
  - `zia.ts` `map`: `modelRef: parseModelRef(name, null, null)` (was `modelRef: name`).
  - `pandora.ts` `parseListing`: `modelRef: parseModelRef(name, null, null)` (was a name-code regex).

- [ ] **Step 2 — update any test** that asserts a specific `modelRef` for these collectors (e.g. zia/web-jsonld/hronometar fixtures) to the value `parseModelRef` now yields (run the suite, read the actual value, assert it — it should be the manufacturer code).
- [ ] **Step 3 — run the full ingestion suite:** `pnpm --filter @mytime/ingestion test` (all pass). **Step 4 — build + Biome.**
- [ ] **Step 5 — commit** all touched collectors + tests.

---

### Task 5 — Backfill `model_ref` in place  *(Wave 2)*

**Files:** Create `db/scripts/backfill-model-ref.mjs`.

- [ ] **Step 1 — write** the script (mirrors `backfill-taxonomy.mjs`: `pg` Pool, `--apply`, DATABASE_URL guard, dry-run counts):

```js
// Re-derive products.model_ref from stored fields using the shared parser — no re-scrape.
//   node --env-file=.env db/scripts/backfill-model-ref.mjs [--apply]
import pg from "pg";
import { parseModelRef } from "../../ingestion/dist/pipeline/normalize.js";

const APPLY = process.argv.includes("--apply");
if (!process.env.DATABASE_URL) { console.error("ERROR: DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_NO_VERIFY === "true" ? { rejectUnauthorized: false } : undefined,
});

// external_id holds the WooCommerce sku (numeric where there is none); current model_ref holds
// the old slug for woo sites. Re-derive from (name, sku=external_id, slug=old model_ref).
const { rows } = await pool.query(
  `SELECT id, target_id, name, external_id, model_ref FROM products WHERE active = true`,
);
let changed = 0;
const perVendor = {};
const client = await pool.connect();
try {
  if (APPLY) await client.query("BEGIN");
  for (const r of rows) {
    const sku = /^[0-9]+$/.test(r.external_id ?? "") ? null : r.external_id; // numeric ext = db id
    const next = parseModelRef(r.name, sku, r.model_ref);
    if (next && next !== r.model_ref) {
      if (APPLY) await client.query("UPDATE products SET model_ref = $1 WHERE id = $2", [next, r.id]);
      changed++;
      perVendor[r.target_id] = (perVendor[r.target_id] ?? 0) + 1;
    }
  }
  if (APPLY) await client.query("COMMIT");
} catch (e) { if (APPLY) await client.query("ROLLBACK"); throw e; } finally { client.release(); }
console.log(`${APPLY ? "APPLIED" : "DRY RUN"}: ${rows.length} products | model_ref changed: ${changed}`);
console.log("per vendor:", JSON.stringify(perVendor));
await pool.end();
process.exit(0);
```

- [ ] **Step 2 — Biome** clean (`pnpm exec biome check db/scripts/backfill-model-ref.mjs`). It is **not** run locally (no DB) — Wave 3 runs it on prod.
- [ ] **Step 3 — commit** the script.

---

### Task 6 — Integrate + deploy + verify  *(Wave 3, solo)*

- [ ] **Step 1 — merge** all Wave-1/2 task branches into the feature branch; resolve any trivial import-order conflicts. `pnpm -r build && pnpm -r test && pnpm exec biome check .` (build/test green; no new Biome diagnostics).
- [ ] **Step 2 — deploy** the feature branch to the VPS (`git archive HEAD | ssh …`, Node-24 PATH, `pnpm -r build`).
- [ ] **Step 3 — backfill on prod:** `node --env-file=.env db/scripts/backfill-model-ref.mjs` (dry run → sane per-vendor counts, esp. bozinovski/watch-club/mytime), then `--apply`. Restart `mytime-mcp`.
- [ ] **Step 4 — verify overlap rose:** re-run the overlap audit (MY:TIME vs each competitor on normalized `model_ref`). Expect Bozinovski/Watch Club/B-Watch to gain materially and Casio MY:TIME↔B-Watch to now match.
- [ ] **Step 5 — verify the tool:** call `compare_skus` `run(pool, {})` against prod — confirm per-competitor matches + price deltas are sane (Saat&Saat ≥ 88, Hronometar ≥ 66, plus new Woo numbers), and that no Casio row is matched to a G-Shock.
- [ ] **Step 6 — merge to `main`, push, deploy.** (One MCP reconnect not needed — auth persists now.)

---

## Self-Review

- **Spec coverage:** parseModelRef/normalizeModelKey/brandMatchKey → T1; woo sku/name → T2; other collectors → T3; backfill → T5; compare_skus tool (brand-aware, Casio/G-Shock) → T4; verify overlap+tool → T6. ✅
- **Placeholders:** none — code is concrete; T3 says to read-then-assert the actual parser output for fixture tests (the one place exact strings depend on fixtures). ✅
- **Type consistency:** `parseModelRef(name, sku, slug)`, `normalizeModelKey(ref)`, `brandMatchKey(brand,name)→{brand,isGShock}` used identically in T2/T3/T5 and mirrored in T4's SQL (regexp_replace key, `CASIO%` collapse, `G[ -]?SHOCK`). ✅
- **Parallelism safety:** Wave-1 files (normalize.ts ‖ tools/index.ts) and Wave-2 files (woocommerce.ts ‖ {feed,web-jsonld,hronometar,zia,pandora} ‖ db/scripts) are disjoint; Wave 2 starts only after Task 1 is merged so the parser import resolves. ✅
