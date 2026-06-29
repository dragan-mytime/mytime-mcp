import { describe, expect, it } from "vitest";
import { checkCsrf, issueSession, readCookie, verifySession } from "../src/admin/session.js";

if (!process.env.MCP_JWT_SECRET) {
  process.env.MCP_JWT_SECRET = "test-secret-至少32chars-长aaaaaaaaaaaaaaaa";
}

describe("issueSession / verifySession", () => {
  it("round-trips email and csrf", async () => {
    const token = await issueSession("x@mytime.mk");
    const result = await verifySession(token);
    expect(result).not.toBeNull();
    expect(result?.email).toBe("x@mytime.mk");
    expect(typeof result?.csrf).toBe("string");
    expect(result?.csrf.length).toBeGreaterThan(0);
  });

  it("returns null for a garbage token", async () => {
    const result = await verifySession("garbage.token.here");
    expect(result).toBeNull();
  });
});

describe("readCookie", () => {
  it("extracts mt_admin value from a multi-cookie header", () => {
    expect(readCookie("a=1; mt_admin=abc; b=2")).toBe("abc");
  });

  it("returns null when header is undefined", () => {
    expect(readCookie(undefined)).toBeNull();
  });
});

describe("checkCsrf", () => {
  it("returns true when tokens match", () => {
    expect(checkCsrf("tok", "tok")).toBe(true);
  });

  it("returns false when tokens differ", () => {
    expect(checkCsrf("tok", "other")).toBe(false);
  });

  it("returns false when formCsrf is undefined", () => {
    expect(checkCsrf("tok", undefined)).toBe(false);
  });
});
