import { fileURLToPath } from "node:url";
import {
  createDb,
  deactivateMissingProducts,
  ensureSocialAccount,
  ensureTargetAndLocation,
  getAppSettings,
  loadTargetsFromDb,
  recordRun,
  writeAdObservations,
  writeObservations,
  writeSocialMetrics,
  writeSocialPosts,
} from "@mytime/db";
import { logger, optionalEnv, requireEnv } from "@mytime/shared";
import { collectCompetitorAds } from "./ads/meta-ads.js";
import { skopjeDate } from "./pipeline/dates.js";
import { deactivationDecision, type ProductCollectOutcome } from "./pipeline/deactivation.js";
import { extractHandle } from "./social/_social.js";
import { socialCollectors } from "./social/index.js";
import { collectOwnBrandMeta } from "./social/meta-own.js";
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

/**
 * Daily ingestion run. Per (collector × applicable target):
 *   ensure target+location → collect → idempotent write → log to ingestion_runs.
 * Per-source failure isolation: one collector throwing logs and continues — it
 * never aborts the others. Re-running the same day upserts, never duplicates.
 * runDate is the Europe/Skopje calendar date, not UTC.
 */
export async function run(runDate: string = skopjeDate()): Promise<RunSummary> {
  const db = createDb(requireEnv("DATABASE_URL"));
  const targets = await loadTargetsFromDb(db);
  // Admin knobs (app_settings), read once at run start with safe defaults:
  // ad_results_limit (meta-ads) and web_max_products (web collectors).
  const appSettings = await getAppSettings(db);
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

  // Per-target product-collect outcomes, so deactivation (below) runs once per
  // target and only when every product collector that ran for it succeeded.
  const productOutcomes = new Map<string, ProductCollectOutcome>();
  const outcomeFor = (id: string) => {
    let o = productOutcomes.get(id);
    if (!o) {
      o = { succeeded: 0, failed: 0, rows: 0 };
      productOutcomes.set(id, o);
    }
    return o;
  };

  for (const collector of productCollectors) {
    if (onlyCollectors && !onlyCollectors.includes(collector.id)) continue;
    for (const target of targets.filter(
      (t) => collector.appliesTo(t) && (!onlyTargets || onlyTargets.includes(t.id)),
    )) {
      summary.attempted++;
      const startedAt = new Date();
      try {
        const locationId = await ensureTargetAndLocation(db, target);
        const obs = await collector.collect({
          target,
          runDate,
          maxProducts: appSettings.webMaxProducts ?? undefined,
        });
        const rows = await writeObservations(db, target, locationId, runDate, collector.id, obs);
        summary.succeeded++;
        summary.rows += rows;
        const outcome = outcomeFor(target.id);
        outcome.succeeded++;
        outcome.rows += rows;
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
        outcomeFor(target.id).failed++;
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

  // ── Deactivate products missing from today's successful product collects ──
  // Once per target; skipped when any of the target's product collectors failed
  // (a failed collect must not deactivate the rows it would have refreshed) or
  // when zero products were observed (an empty feed must not wipe the catalog).
  for (const [targetId, o] of productOutcomes) {
    const decision = deactivationDecision(o);
    if (decision === "skip-failed") continue;
    if (decision === "skip-zero-rows") {
      logger.warn(
        { targetId, reason: "zero products collected — deactivation skipped" },
        "product deactivation skipped",
      );
      continue;
    }
    try {
      const deactivated = await deactivateMissingProducts(db, targetId, runDate);
      logger.info({ targetId, deactivated }, "deactivated products missing from feed");
    } catch (err) {
      logger.error({ targetId, err }, "product deactivation failed (isolated)");
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
        rows += await writeSocialPosts(db, sid, runDate, r.posts ?? []);
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

  // ── Competitor ad intelligence: Meta Ad Library via Apify (Subsystem B) ──
  if (optionalEnv("APIFY_TOKEN") && (!onlyCollectors || onlyCollectors.includes("meta-ads"))) {
    const pages = targets
      .filter(
        (t) =>
          !t.is_self && (!onlyTargets || onlyTargets.includes(t.id)) && Boolean(t.social.facebook),
      )
      .map((t) => ({ targetId: t.id, url: t.social.facebook as string }));
    if (pages.length) {
      summary.attempted++;
      const startedAt = new Date();
      try {
        const byTarget = await collectCompetitorAds(pages, runDate, appSettings.adResultsLimit);
        let rows = 0;
        for (const [tid, ads] of byTarget) rows += await writeAdObservations(db, tid, runDate, ads);
        summary.succeeded++;
        summary.rows += rows;
        await recordRun(db, {
          runDate,
          collector: "meta-ads",
          targetId: null,
          status: "success",
          rowsWritten: rows,
          startedAt,
        });
        logger.info(
          { collector: "meta-ads", pages: pages.length, rows },
          "competitor ads collected",
        );
      } catch (err) {
        summary.failed++;
        const error = err instanceof Error ? err.message : String(err);
        summary.failures.push({ collector: "meta-ads", target: "all", error });
        await recordRun(db, {
          runDate,
          collector: "meta-ads",
          targetId: null,
          status: "failed",
          rowsWritten: 0,
          error,
          startedAt,
        }).catch(() => {});
        logger.error({ collector: "meta-ads", err }, "competitor ads failed (isolated)");
      }
    }
  }

  // ── Own-brand social: MY:TIME via the official Meta Graph API (Step F) ──
  if (
    optionalEnv("META_ACCESS_TOKEN") &&
    (!onlyCollectors || onlyCollectors.includes("meta-own-brand"))
  ) {
    const self = targets.find((t) => t.is_self);
    if (self && (!onlyTargets || onlyTargets.includes(self.id))) {
      summary.attempted++;
      const startedAt = new Date();
      try {
        const results = await collectOwnBrandMeta();
        let rows = 0;
        for (const r of results) {
          const url = self.social[r.platform];
          if (!url) continue;
          const sid = await ensureSocialAccount(db, self.id, r.platform, url);
          rows += await writeSocialMetrics(db, sid, runDate, r.metrics, "meta-own-brand");
          rows += await writeSocialPosts(db, sid, runDate, r.posts ?? []);
        }
        summary.succeeded++;
        summary.rows += rows;
        await recordRun(db, {
          runDate,
          collector: "meta-own-brand",
          targetId: self.id,
          status: "success",
          rowsWritten: rows,
          startedAt,
        });
        logger.info(
          { collector: "meta-own-brand", target: self.id, rows },
          "own-brand social collected",
        );
      } catch (err) {
        summary.failed++;
        const error = err instanceof Error ? err.message : String(err);
        summary.failures.push({ collector: "meta-own-brand", target: self.id, error });
        await recordRun(db, {
          runDate,
          collector: "meta-own-brand",
          targetId: self.id,
          status: "failed",
          rowsWritten: 0,
          error,
          startedAt,
        }).catch(() => {});
        logger.error({ collector: "meta-own-brand", err }, "own-brand social failed (isolated)");
      }
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
