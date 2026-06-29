import { createDb, type Db, dailyDigest, recordRun } from "@mytime/db";
import { logger, requireEnv } from "@mytime/shared";
import { renderDigestEmail } from "./render.js";
import { sendDigestEmail } from "./send.js";

/** Generate the competitor digest, render it bilingually, and email it. Failure-isolated + logged. */
export async function runDigestEmail(db: Db = createDb(requireEnv("DATABASE_URL"))): Promise<void> {
  const runDate = new Date().toISOString().slice(0, 10);
  const startedAt = new Date();
  try {
    const digest = await dailyDigest(db);
    await sendDigestEmail(await renderDigestEmail(digest));
    await recordRun(db, {
      runDate,
      collector: "digest-email",
      targetId: null,
      status: "success",
      rowsWritten: digest.competitors.length,
      startedAt,
    });
    logger.info({ competitors: digest.competitors.length }, "digest email sent");
  } catch (err) {
    await recordRun(db, {
      runDate,
      collector: "digest-email",
      targetId: null,
      status: "failed",
      rowsWritten: 0,
      error: err instanceof Error ? err.message : String(err),
      startedAt,
    }).catch(() => {});
    logger.error({ err }, "digest email failed (isolated)");
  }
}
