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
          targetId: t.id,
          url: row.url,
          externalId: row.externalId,
          dataMismatches: diffVsDb(truth, row),
          driftFlags: llm ? diffVsLlm(truth, llm) : [],
        });
      } catch (err) {
        logger.error({ target: t.id, url: row.url, err }, "validation fetch failed (isolated)");
      }
    }
  }

  const { md } = writeReport(results, dateIso);
  const errors = results.reduce(
    (a, r) => a + r.dataMismatches.filter((m) => m.severity === "error").length,
    0,
  );
  logger.info({ products: results.length, errors, report: md }, "validation complete");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    logger.error({ err }, "fatal validation error");
    process.exit(1);
  });
}
