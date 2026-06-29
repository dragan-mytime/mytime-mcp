import {
  type Db,
  dailyDigest,
  dueSchedules,
  markScheduleRan,
  recordRun,
  renderDigestWithPrompt,
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

/** One scheduler tick: send every due schedule once, failure-isolated per schedule. */
export async function tick(db: Db, now: Date = new Date()): Promise<void> {
  const { date, hhmm } = skopjeNow(now);
  const due = await dueSchedules(db, date, hhmm);
  for (const s of due) {
    const startedAt = new Date();
    try {
      const digest = await dailyDigest(db);
      const mail = await renderDigestWithPrompt(digest, s.body);
      const to = await resolveRecipients(db, s);
      await sendDigestEmail(mail, to);
      await markScheduleRan(db, s.id, date);
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
      await recordRun(db, {
        runDate: date,
        collector: `digest:${s.id}`,
        targetId: null,
        status: "failed",
        rowsWritten: 0,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
      }).catch(() => {});
      logger.error({ err, schedule: s.id }, "digest schedule failed (isolated)");
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
