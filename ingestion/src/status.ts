import { createPool, requireEnv } from "@mytime/shared";

/** Print the recent ingestion run log (observability — brief §7). */
async function main(): Promise<void> {
  const pool = createPool(requireEnv("DATABASE_URL"));
  try {
    const { rows } = await pool.query(
      `SELECT run_date, collector, target_id, status, rows_written, error,
              started_at, finished_at
       FROM ingestion_runs
       WHERE started_at > now() - interval '2 days'
       ORDER BY started_at DESC
       LIMIT 40`,
    );
    if (rows.length === 0) {
      console.log("No ingestion runs in the last 2 days.");
      return;
    }
    const fmtDate = (d: unknown): string =>
      d instanceof Date
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        : String(d);
    console.log(`run_date    collector                target        status   rows`);
    for (const r of rows) {
      const line = [
        fmtDate(r.run_date),
        String(r.collector).padEnd(24),
        String(r.target_id ?? "-").padEnd(13),
        String(r.status).padEnd(8),
        r.rows_written,
      ].join(" ");
      console.log(`  ${line}${r.error ? `  ERR: ${r.error}` : ""}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
