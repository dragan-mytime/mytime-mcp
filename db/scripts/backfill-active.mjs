// One-time backfill: `products.active` stayed true forever before
// deactivateMissingProducts existed. For each target, take max(last_seen_date)
// over its products (its most recent successful product scrape) and deactivate
// every product last seen before that. Idempotent. Run from repo root:
//   node db/scripts/backfill-active.mjs           # dry run (per-target counts)
//   node db/scripts/backfill-active.mjs --apply   # write
import pg from "pg";

const APPLY = process.argv.includes("--apply");
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_NO_VERIFY === "true" ? { rejectUnauthorized: false } : undefined,
});

const { rows: targets } = await pool.query(
  `SELECT target_id, max(last_seen_date)::text AS latest
   FROM products GROUP BY target_id ORDER BY target_id`,
);

let total = 0;
const client = await pool.connect();
try {
  if (APPLY) await client.query("BEGIN");
  for (const t of targets) {
    let n;
    if (APPLY) {
      const res = await client.query(
        `UPDATE products SET active = false
         WHERE target_id = $1 AND last_seen_date < $2 AND active`,
        [t.target_id, t.latest],
      );
      n = res.rowCount;
    } else {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM products
         WHERE target_id = $1 AND last_seen_date < $2 AND active`,
        [t.target_id, t.latest],
      );
      n = res.rows[0].n;
    }
    console.log(
      `${t.target_id}: latest=${t.latest} ${APPLY ? "deactivated" : "would deactivate"}=${n}`,
    );
    total += n;
  }
  if (APPLY) await client.query("COMMIT");
} catch (e) {
  if (APPLY) await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

console.log(`${APPLY ? "APPLIED" : "DRY RUN"}: ${total} products across ${targets.length} targets`);
await pool.end();
process.exit(0);
