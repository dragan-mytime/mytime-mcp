import { fileURLToPath } from "node:url";
import { loadTargets, logger } from "@mytime/shared";
import { collectors } from "./sources/index.js";

export interface RunSummary {
  runDate: string;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: { collector: string; target: string; error: string }[];
}

/**
 * Daily ingestion run. Phase 3 wires the routing/transform/write layer; this
 * scaffold already enforces the cross-cutting requirements: a UTC date stamp
 * for every run and per-source failure isolation (one collector throwing logs
 * and continues — it never aborts the others).
 */
export async function run(
  runDate: string = new Date().toISOString().slice(0, 10),
  targetsPath = "config/targets.json",
): Promise<RunSummary> {
  const targets = loadTargets(targetsPath);
  const summary: RunSummary = {
    runDate,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
  };

  logger.info(
    { runDate, collectors: collectors.length, targets: targets.length },
    "ingestion run starting",
  );

  for (const collector of collectors) {
    for (const target of targets.filter((t) => collector.appliesTo(t))) {
      summary.attempted++;
      try {
        const rows = await collector.collect({ target, runDate });
        // Phase 3: route → normalize → dedupe → write (idempotent per (entity, date)).
        logger.info({ collector: collector.id, target: target.id, rows: rows.length }, "collected");
        summary.succeeded++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        summary.failed++;
        summary.failures.push({ collector: collector.id, target: target.id, error });
        logger.error(
          { collector: collector.id, target: target.id, err },
          "collector failed (isolated)",
        );
      }
    }
  }

  logger.info({ ...summary }, "ingestion run complete");
  return summary;
}

// Run when invoked directly (cross-platform entrypoint check).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    logger.error({ err }, "fatal ingestion error");
    process.exit(1);
  });
}
