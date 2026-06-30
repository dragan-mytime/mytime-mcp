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
