import { fileURLToPath } from "node:url";
import {
  createDb,
  ensureSocialAccount,
  ensureTargetAndLocation,
  recordRun,
  writeObservations,
  writeSocialMetrics,
} from "@mytime/db";
import { loadTargets, logger, optionalEnv, requireEnv } from "@mytime/shared";
import { extractHandle } from "./social/_social.js";
import { socialCollectors } from "./social/index.js";
import { productCollectors } from "./sources/index.js";

// Optional filters for targeted/manual runs (comma-separated ids).
const csv = (v?: string): string[] | null => (v ? v.split(",").map((s) => s.trim()) : null);
const onlyCollectors = csv(optionalEnv("INGEST_COLLECTORS"));
const onlyTargets = csv(optionalEnv("INGEST_TARGETS"));

export interface RunSummary {
  runDate: string;
  attempted: number;
  succeeded: number;
  failed: number;
  rows: number;
  failures: { collector: string; target: string; error: string }[];
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Daily ingestion run. Per (collector × applicable target):
 *   ensure target+location → collect → idempotent write → log to ingestion_runs.
 * Per-source failure isolation: one collector throwing logs and continues — it
 * never aborts the others. Re-running the same day upserts, never duplicates.
 */
export async function run(
  runDate: string = today(),
  targetsPath = "config/targets.json",
): Promise<RunSummary> {
  const db = createDb(requireEnv("DATABASE_URL"));
  const targets = loadTargets(targetsPath);
  const summary: RunSummary = {
    runDate,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    rows: 0,
    failures: [],
  };

  logger.info(
    { runDate, collectors: productCollectors.length, targets: targets.length },
    "ingestion run starting",
  );

  for (const collector of productCollectors) {
    if (onlyCollectors && !onlyCollectors.includes(collector.id)) continue;
    for (const target of targets.filter(
      (t) => collector.appliesTo(t) && (!onlyTargets || onlyTargets.includes(t.id)),
    )) {
      summary.attempted++;
      const startedAt = new Date();
      try {
        const locationId = await ensureTargetAndLocation(db, target);
        const obs = await collector.collect({ target, runDate });
        const rows = await writeObservations(db, target, locationId, runDate, collector.id, obs);
        summary.succeeded++;
        summary.rows += rows;
        await recordRun(db, {
          runDate,
          collector: collector.id,
          targetId: target.id,
          status: "success",
          rowsWritten: rows,
          startedAt,
        });
        logger.info({ collector: collector.id, target: target.id, rows }, "collected");
      } catch (err) {
        summary.failed++;
        const error = err instanceof Error ? err.message : String(err);
        summary.failures.push({ collector: collector.id, target: target.id, error });
        await recordRun(db, {
          runDate,
          collector: collector.id,
          targetId: target.id,
          status: "failed",
          rowsWritten: 0,
          error,
          startedAt,
        }).catch(() => {});
        logger.error(
          { collector: collector.id, target: target.id, err },
          "collector failed (isolated)",
        );
      }
    }
  }

  // ── Social phase: competitor public metrics (Apify), one actor call per platform ──
  for (const sc of socialCollectors) {
    if (onlyCollectors && !onlyCollectors.includes(sc.id)) continue;
    const accounts = targets
      .filter(
        (t) =>
          !t.is_self &&
          (!onlyTargets || onlyTargets.includes(t.id)) &&
          Boolean(t.social[sc.platform]),
      )
      .map((t) => {
        const url = t.social[sc.platform] as string;
        return {
          targetId: t.id,
          platform: sc.platform,
          url,
          handle: extractHandle(sc.platform, url),
        };
      });
    if (accounts.length === 0) continue;
    summary.attempted++;
    const startedAt = new Date();
    try {
      const results = await sc.collect(accounts);
      let rows = 0;
      for (const r of results) {
        const acct = accounts.find((a) => a.targetId === r.targetId);
        if (!acct) continue;
        const sid = await ensureSocialAccount(db, r.targetId, sc.platform, acct.url, acct.handle);
        rows += await writeSocialMetrics(db, sid, runDate, r.metrics, sc.id);
      }
      summary.succeeded++;
      summary.rows += rows;
      await recordRun(db, {
        runDate,
        collector: sc.id,
        targetId: null,
        status: "success",
        rowsWritten: rows,
        startedAt,
      });
      logger.info({ collector: sc.id, accounts: accounts.length, rows }, "social collected");
    } catch (err) {
      summary.failed++;
      const error = err instanceof Error ? err.message : String(err);
      summary.failures.push({ collector: sc.id, target: sc.platform, error });
      await recordRun(db, {
        runDate,
        collector: sc.id,
        targetId: null,
        status: "failed",
        rowsWritten: 0,
        error,
        startedAt,
      }).catch(() => {});
      logger.error({ collector: sc.id, err }, "social collector failed (isolated)");
    }
  }

  logger.info({ ...summary, failures: summary.failures.length }, "ingestion run complete");
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    logger.error({ err }, "fatal ingestion error");
    process.exit(1);
  });
}
