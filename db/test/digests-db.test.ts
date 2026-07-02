import { describe, expect, it } from "vitest";
import {
  isDue,
  maskGeminiKey,
  parseRecipients,
  slugify,
  validRecipients,
  validSendAt,
} from "../src/digests-db.js";

describe("maskGeminiKey", () => {
  it("reports not set for empty/null/whitespace", () => {
    expect(maskGeminiKey(null)).toBe("not set");
    expect(maskGeminiKey(undefined)).toBe("not set");
    expect(maskGeminiKey("   ")).toBe("not set");
  });
  it("shows only the last 4 chars of a key", () => {
    expect(maskGeminiKey("AIzaSyABCD1234")).toBe("set (…1234)");
  });
});

describe("slugify", () => {
  it("kebab-cases and trims", () => {
    expect(slugify("Daily Default!")).toBe("daily-default");
  });
  it("never returns empty", () => {
    expect(slugify("***")).toBe("item");
  });
});

describe("validSendAt", () => {
  it("accepts HH:MM in range", () => {
    expect(validSendAt("07:00")).toBe(true);
    expect(validSendAt("23:59")).toBe(true);
  });
  it("rejects out-of-range / malformed", () => {
    expect(validSendAt("24:00")).toBe(false);
    expect(validSendAt("7:00")).toBe(false);
    expect(validSendAt("abc")).toBe(false);
  });
});

describe("parseRecipients / validRecipients", () => {
  it("splits lines and trims", () => {
    expect(parseRecipients("a@x.com\n b@y.com \n\n")).toEqual(["a@x.com", "b@y.com"]);
  });
  it("validates email shape", () => {
    expect(validRecipients(["a@x.com"])).toBe(true);
    expect(validRecipients(["nope"])).toBe(false);
  });
});

describe("isDue", () => {
  const base = { sendAt: "07:00", enabled: true, lastRunOn: null as string | null };
  it("due when enabled, time matches, not run today", () => {
    expect(isDue(base, "2026-06-29", "07:00")).toBe(true);
  });
  it("not due when disabled", () => {
    expect(isDue({ ...base, enabled: false }, "2026-06-29", "07:00")).toBe(false);
  });
  it("not due before the send time", () => {
    expect(isDue(base, "2026-06-29", "06:59")).toBe(false);
  });
  it("catch-up: due later the same day when the exact minute was missed", () => {
    expect(isDue(base, "2026-06-29", "07:23")).toBe(true);
    expect(isDue(base, "2026-06-29", "23:59")).toBe(true);
  });
  it("catch-up is idempotent: not due once already run today, even later", () => {
    expect(isDue({ ...base, lastRunOn: "2026-06-29" }, "2026-06-29", "07:23")).toBe(false);
  });
  it("not due when already run today", () => {
    expect(isDue({ ...base, lastRunOn: "2026-06-29" }, "2026-06-29", "07:00")).toBe(false);
  });
  it("due again on a later day", () => {
    expect(isDue({ ...base, lastRunOn: "2026-06-28" }, "2026-06-29", "07:00")).toBe(true);
  });
  it("disabled schedule never fires even past its time", () => {
    expect(isDue({ ...base, enabled: false }, "2026-06-29", "12:00")).toBe(false);
  });
});
