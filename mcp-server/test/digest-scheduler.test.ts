import { describe, expect, it, vi } from "vitest";

const sendDigestEmail = vi.fn(async () => {});
const markScheduleRan = vi.fn(async () => {});
const dailyDigest = vi.fn(async () => ({ generatedFor: "2026-06-29", note: "", competitors: [] }));
const renderDigestWithPrompt = vi.fn(async () => ({ subject: "s", html: "h", usedFallback: true }));
const resolveRecipients = vi.fn(async () => ["dragan@mytime.mk"]);
const recordRun = vi.fn(async () => {});
let dueRows: { id: string; name: string; body: string; recipients: string[] | null }[] = [];
const dueSchedules = vi.fn(async () => dueRows);

vi.mock("@mytime/db", () => ({
  dailyDigest,
  dueSchedules,
  markScheduleRan,
  renderDigestWithPrompt,
  resolveRecipients,
  recordRun,
  sendDigestEmail,
}));

const { skopjeNow, tick } = await import("../src/digestScheduler.js");

describe("skopjeNow", () => {
  it("returns YYYY-MM-DD date and HH:MM in 24h", () => {
    // 2026-06-29 05:00 UTC == 07:00 Europe/Skopje (UTC+2 in summer)
    const r = skopjeNow(new Date("2026-06-29T05:00:00Z"));
    expect(r.date).toBe("2026-06-29");
    expect(r.hhmm).toBe("07:00");
  });
});

describe("tick", () => {
  it("sends each due schedule once and marks it run", async () => {
    dueRows = [{ id: "daily-0700", name: "Daily 07:00", body: "prompt", recipients: null }];
    const db = {} as never;
    await tick(db, new Date("2026-06-29T05:00:00Z"));
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(markScheduleRan).toHaveBeenCalledWith(db, "daily-0700", "2026-06-29");
  });

  it("does nothing when no schedules are due", async () => {
    dueRows = [];
    sendDigestEmail.mockClear();
    await tick({} as never, new Date("2026-06-29T05:00:00Z"));
    expect(sendDigestEmail).not.toHaveBeenCalled();
  });
});
