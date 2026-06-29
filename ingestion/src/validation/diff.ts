import type { DbProductRow, FieldMismatch, LiveSnapshot } from "./types.js";

const PRICE_TOL_ABS = 1; // MKD
const PRICE_TOL_PCT = 0.01;

const numClose = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(PRICE_TOL_ABS, Math.abs(b) * PRICE_TOL_PCT);

const norm = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Compare the live ground-truth snapshot against the stored DB row. */
export function diffVsDb(live: LiveSnapshot, db: DbProductRow): FieldMismatch[] {
  const out: FieldMismatch[] = [];

  if (live.price != null && db.price != null && !numClose(live.price, db.price)) {
    out.push({ field: "price", dbValue: db.price, liveValue: live.price, severity: "error" });
  }

  const liveOnSale = live.salePrice != null && live.price != null && live.salePrice < live.price;
  const dbOnSale = db.salePrice != null;
  if (liveOnSale !== dbOnSale) {
    out.push({
      field: "salePrice",
      dbValue: db.salePrice,
      liveValue: live.salePrice ?? null,
      severity: "error",
      note: liveOnSale
        ? "live shows a discount the DB missed"
        : "DB has a discount the live page no longer shows",
    });
  } else if (
    liveOnSale &&
    dbOnSale &&
    live.salePrice != null &&
    db.salePrice != null &&
    !numClose(live.salePrice, db.salePrice)
  ) {
    out.push({
      field: "salePrice",
      dbValue: db.salePrice,
      liveValue: live.salePrice,
      severity: "error",
    });
  }

  if (live.stockStatus != null && db.stockStatus != null && live.stockStatus !== db.stockStatus) {
    out.push({
      field: "stockStatus",
      dbValue: db.stockStatus,
      liveValue: live.stockStatus,
      severity: "error",
    });
  }

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
  const onSale = (s: LiveSnapshot) =>
    s.salePrice != null && s.price != null && s.salePrice < s.price;
  if (verifier.price != null && llm.price != null && !numClose(verifier.price, llm.price)) {
    out.push({
      field: "price",
      dbValue: verifier.price,
      liveValue: llm.price,
      severity: "review",
      note: "verifier vs LLM price drift",
    });
  }
  if (onSale(verifier) !== onSale(llm)) {
    out.push({
      field: "salePrice",
      dbValue: verifier.salePrice ?? null,
      liveValue: llm.salePrice ?? null,
      severity: "review",
      note: "verifier vs LLM disagree on sale — possible layout drift",
    });
  }
  for (const f of ["name", "brand", "stockStatus"] as const) {
    if (verifier[f] != null && llm[f] != null && norm(verifier[f]) !== norm(llm[f])) {
      out.push({
        field: f,
        dbValue: verifier[f],
        liveValue: llm[f],
        severity: "review",
        note: "verifier vs LLM drift",
      });
    }
  }
  return out;
}
