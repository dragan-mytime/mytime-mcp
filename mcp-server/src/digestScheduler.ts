import {
  clearScheduleRun,
  type Db,
  dailyDigest,
  dueSchedules,
  getAppSettings,
  markScheduleRan,
  recordRun,
  renderDigestWithPrompt,
  resolveGeminiKey,
  resolveRecipients,
  sendDigestEmail,
} from "@mytime/db";
import { logger, optionalEnv } from "@mytime/shared";
import { adminWriteDb } from "./writePool.js";

/** Current date (YYYY-MM-DD) and time (HH:MM, 24h) in Europe/Skopje. */
export function skopjeNow(d: Date = new Date()): { date: string; hhmm: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Skopje",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * One scheduler tick: send every due schedule once, failure-isolated per
 * schedule. Due = send time reached and not yet run today (catch-up, see
 * `dueSchedules`). Each schedule is marked ran BEFORE sending: a hard crash
 * mid-send skips the day rather than double-sending; a thrown send clears the
 * mark so the next tick retries.
 */
export async function tick(db: Db, now: Date = new Date()): Promise<void> {
  const { date, hhmm } = skopjeNow(now);
  const { digestEnabled } = await getAppSettings(db);
  if (!digestEnabled) {
    logger.info("digest sends skipped this tick (digest_enabled is off in admin settings)");
    return;
  }
  const due = await dueSchedules(db, date, hhmm);
  for (const s of due) {
    const startedAt = new Date();
    try {
      await markScheduleRan(db, s.id, date);
      const digest = await dailyDigest(db);
      const apiKey = await resolveGeminiKey(db);
      const mail = await renderDigestWithPrompt(digest, s.body, apiKey);
      const to = await resolveRecipients(db, s);
      await sendDigestEmail(mail, to);
      await recordRun(db, {
        runDate: date,
        collector: `digest:${s.id}`,
        targetId: null,
        status: "success",
        rowsWritten: digest.competitors.length,
        startedAt,
      });
      logger.info({ schedule: s.id, to: to.length }, "digest sent");
    } catch (err) {
      await clearScheduleRun(db, s.id, date).catch((clearErr) =>
        logger.error(
          { err: clearErr, schedule: s.id },
          "failed to clear run mark after send failure — digest will NOT retry today",
        ),
      );
      await recordRun(db, {
        runDate: date,
        collector: `digest:${s.id}`,
        targetId: null,
        status: "failed",
        rowsWritten: 0,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
      }).catch(() => {});
      logger.error(
        { err, schedule: s.id },
        "digest send failed (isolated) — run mark cleared, retrying next tick",
      );
    }
  }
}

let _timer: ReturnType<typeof setInterval> | undefined;

/** Start the 60s scheduler loop. No-ops (logs) if RESEND_API_KEY is absent. */
export function startDigestScheduler(): void {
  if (!optionalEnv("RESEND_API_KEY")) {
    logger.warn("digest scheduler disabled (no RESEND_API_KEY)");
    return;
  }
  const db = adminWriteDb();
  const run = () => {
    tick(db).catch((err) => logger.error({ err }, "digest tick error"));
  };
  _timer = setInterval(run, 60_000);
  run();
  logger.info("digest scheduler started (Europe/Skopje, 60s tick)");
}
