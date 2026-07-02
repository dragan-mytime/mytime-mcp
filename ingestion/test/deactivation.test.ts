import { describe, expect, it } from "vitest";
import { deactivationDecision } from "../src/pipeline/deactivation.js";

describe("deactivationDecision", () => {
  it("deactivates when all collects succeeded and products were observed", () => {
    expect(deactivationDecision({ succeeded: 1, failed: 0, rows: 250 })).toBe("deactivate");
    expect(deactivationDecision({ succeeded: 2, failed: 0, rows: 1 })).toBe("deactivate");
  });
  it("skips when any product collector for the target failed", () => {
    expect(deactivationDecision({ succeeded: 1, failed: 1, rows: 250 })).toBe("skip-failed");
    expect(deactivationDecision({ succeeded: 0, failed: 1, rows: 0 })).toBe("skip-failed");
  });
  it("skips when nothing succeeded (target never collected this run)", () => {
    expect(deactivationDecision({ succeeded: 0, failed: 0, rows: 0 })).toBe("skip-failed");
  });
  it("skips on zero observed products — an empty feed must not wipe the catalog", () => {
    expect(deactivationDecision({ succeeded: 1, failed: 0, rows: 0 })).toBe("skip-zero-rows");
  });
});
