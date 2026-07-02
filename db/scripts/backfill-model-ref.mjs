// Re-derive products.model_ref from stored fields using the shared parser — no re-scrape.
// external_id holds the WooCommerce sku (numeric where there is none); the current model_ref
// holds the old slug for woo sites. Idempotent. Run from repo root on the VPS:
//   node --env-file=.env db/scripts/backfill-model-ref.mjs            # dry run
//   node --env-file=.env db/scripts/backfill-model-ref.mjs --apply    # write
import pg from "pg";
import { parseModelRef } from "../../ingestion/dist/pipeline/normalize.js";

const APPLY = process.argv.includes("--apply");
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_NO_VERIFY === "true" ? { rejectUnauthorized: false } : undefined,
});

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
    const parsed = parseModelRef(r.name, sku, r.model_ref);
    // Never use slug-derived refs as match keys (B7).
    const next = parsed?.source !== "slug" ? (parsed?.ref ?? null) : null;
    if (next && next !== r.model_ref) {
      if (APPLY)
        await client.query("UPDATE products SET model_ref = $1 WHERE id = $2", [next, r.id]);
      changed++;
      perVendor[r.target_id] = (perVendor[r.target_id] ?? 0) + 1;
    }
  }
  if (APPLY) await client.query("COMMIT");
} catch (e) {
  if (APPLY) await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
console.log(
  `${APPLY ? "APPLIED" : "DRY RUN"}: ${rows.length} products | model_ref changed: ${changed}`,
);
console.log("per vendor:", JSON.stringify(perVendor));
await pool.end();
process.exit(0);
