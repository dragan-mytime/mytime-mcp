import { describe, expect, it } from "vitest";
import { extractHandle, toDateOrNull } from "../../src/social/_social.js";

describe("extractHandle", () => {
  it("returns last URL path segment as handle", () => {
    expect(extractHandle("facebook", "https://facebook.com/mybrand")).toBe("mybrand");
    expect(extractHandle("instagram", "https://instagram.com/mytime_mk/")).toBe("mytime_mk");
  });

  // A11: profile.php?id=… URLs must not yield "profile.php" as a handle.
  it("A11: returns empty string for non-vanity FB profile.php URLs and warns", () => {
    const result = extractHandle("facebook", "https://facebook.com/profile.php?id=12345");
    expect(result).toBe("");
  });

  it("strips @ prefix from TikTok handles", () => {
    expect(extractHandle("tiktok", "https://tiktok.com/@mytime_mk")).toBe("mytime_mk");
  });
});

describe("toDateOrNull", () => {
  it("parses a valid ISO string to a Date", () => {
    const d = toDateOrNull("2026-06-20T10:00:00.000Z");
    expect(d).toBeInstanceOf(Date);
    expect(Number.isFinite(d?.getTime())).toBe(true);
  });

  it("A6: returns null for a locale-garbage date string", () => {
    expect(toDateOrNull("NOT A DATE AT ALL !!!")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(toDateOrNull(null)).toBeNull();
    expect(toDateOrNull(undefined)).toBeNull();
    expect(toDateOrNull("")).toBeNull();
  });
});
