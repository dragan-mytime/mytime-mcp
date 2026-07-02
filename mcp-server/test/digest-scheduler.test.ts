import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Stateful in-memory mock of @mytime/db ────────────────────────────────────
// Mirrors the real due/mark/clear semantics (see db/src/digests-db.ts) so tick's
// catch-up + retry behavior is exercised against a fake clock.

interface Sched {
  id: string;
  name: string;
  body: string;
  recipients: string[] | null;
  sendAt: string;
  enabled: boolean;
  lastRunOn: string | null;
}

let schedules: Sched[] = [];
let digestEnabled = true;

const sendDigestEmail = vi.fn(async () => {});
const dailyDigest = vi.fn(async () => ({ generatedFor: "2026-06-29", note: "", competitors: [] }));
const renderDigestWithPrompt = vi.fn(async () => ({ subject: "s", html: "h", usedFallback: true }));
const resolveRecipients = vi.fn(async () => ["dragan@mytime.mk"]);
const resolveGeminiKey = vi.fn(async () => undefined);
const recordRun = vi.fn(async () => {});
const getAppSettings = vi.fn(async () => ({
  discountThresholdPct: 5,
  adResultsLimit: 50,
  webMaxProducts: null,
  digestEnabled,
}));
const dueSchedules = vi.fn(async (_db: unknown, today: string, hhmm: string) =>
  schedules
    .filter((s) => s.enabled && s.sendAt <= hhmm && (s.lastRunOn == null || s.lastRunOn < today))
    .map(({ id, name, body, recipients }) => ({ id, name, body, recipients })),
);
// Atomic claim, like the real UPDATE … WHERE not-run-today RETURNING.
const markScheduleRan = vi.fn(async (_db: unknown, id: string, today: string) => {
  const s = schedules.find((x) => x.id === id);
  if (!s || (s.lastRunOn != null && s.lastRunOn >= today)) return false;
  s.lastRunOn = today;
  return true;
});
const clearScheduleRun = vi.fn(async (_db: unknown, id: string, today: string) => {
  const s = schedules.find((x) => x.id === id);
  if (s && s.lastRunOn === today) s.lastRunOn = null;
});

vi.mock("@mytime/db", () => ({
  dailyDigest,
  dueSchedules,
  markScheduleRan,
  clearScheduleRun,
  getAppSettings,
  renderDigestWithPrompt,
  resolveRecipients,
  resolveGeminiKey,
  recordRun,
  sendDigestEmail,
}));

const { skopjeNow, tick } = await import("../src/digestScheduler.js");

const db = {} as never;
// 2026-06-29 05:00 UTC == 07:00 Europe/Skopje (UTC+2 in summer).
const at = (hhmmUtc: string, day = "29") => new Date(`2026-06-${day}T${hhmmUtc}:00Z`);

beforeEach(() => {
  vi.clearAllMocks();
  digestEnabled = true;
  schedules = [
    {
      id: "daily-0700",
      name: "Daily 07:00",
      body: "prompt",
      recipients: null,
      sendAt: "07:00",
      enabled: true,
      lastRunOn: null,
    },
  ];
});

describe("skopjeNow", () => {
  it("returns YYYY-MM-DD date and HH:MM in 24h", () => {
    const r = skopjeNow(new Date("2026-06-29T05:00:00Z"));
    expect(r.date).toBe("2026-06-29");
    expect(r.hhmm).toBe("07:00");
  });
});

describe("tick", () => {
  it("sends each due schedule once and marks it run", async () => {
    await tick(db, at("05:00"));
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(markScheduleRan).toHaveBeenCalledWith(db, "daily-0700", "2026-06-29");
  });

  it("marks the schedule ran BEFORE sending (crash mid-send skips, never double-sends)", async () => {
    await tick(db, at("05:00"));
    const markOrder = markScheduleRan.mock.invocationCallOrder[0];
    const sendOrder = sendDigestEmail.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(sendOrder);
  });

  it("does nothing before the send time", async () => {
    await tick(db, at("04:59")); // 06:59 Skopje
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("catch-up: a missed exact minute still fires later the same day", async () => {
    await tick(db, at("05:23")); // 07:23 Skopje — the 07:00 tick was missed
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(schedules[0]?.lastRunOn).toBe("2026-06-29");
  });

  it("already-ran-today does not refire on later ticks, but fires next day", async () => {
    await tick(db, at("05:00"));
    await tick(db, at("05:01"));
    await tick(db, at("09:30"));
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
    await tick(db, at("05:00", "30")); // next day 07:00 Skopje
    expect(sendDigestEmail).toHaveBeenCalledTimes(2);
  });

  it("send failure clears the run mark and the next tick retries", async () => {
    sendDigestEmail.mockRejectedValueOnce(new Error("resend down"));
    await tick(db, at("05:00"));
    expect(markScheduleRan).toHaveBeenCalledTimes(1);
    expect(clearScheduleRun).toHaveBeenCalledWith(db, "daily-0700", "2026-06-29");
    expect(schedules[0]?.lastRunOn).toBeNull();
    expect(recordRun).toHaveBeenCalledWith(db, expect.objectContaining({ status: "failed" }));

    await tick(db, at("05:01"));
    expect(sendDigestEmail).toHaveBeenCalledTimes(2); // 1 failed + 1 retry
    expect(schedules[0]?.lastRunOn).toBe("2026-06-29");
  });

  it("lost claim race: due row already claimed elsewhere → no send, claim untouched", async () => {
    // Another instance claimed today between our due query and our claim:
    // dueSchedules returns a stale row, but the atomic claim returns false.
    dueSchedules.mockResolvedValueOnce([
      { id: "daily-0700", name: "Daily 07:00", body: "prompt", recipients: null },
    ]);
    for (const s of schedules) s.lastRunOn = "2026-06-29";
    await tick(db, at("05:01"));
    expect(sendDigestEmail).not.toHaveBeenCalled();
    expect(clearScheduleRun).not.toHaveBeenCalled();
    expect(schedules[0]?.lastRunOn).toBe("2026-06-29"); // winner's claim intact
  });

  it("a disabled schedule never fires, even past its time", async () => {
    for (const s of schedules) s.enabled = false;
    await tick(db, at("05:00"));
    await tick(db, at("09:30"));
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });

  it("digest_enabled=false skips all sends; re-enabling resumes", async () => {
    digestEnabled = false;
    await tick(db, at("05:00"));
    expect(sendDigestEmail).not.toHaveBeenCalled();
    expect(dueSchedules).not.toHaveBeenCalled();

    digestEnabled = true;
    await tick(db, at("05:01"));
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
  });
});
