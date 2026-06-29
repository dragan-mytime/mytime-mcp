import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixEncoding } from "../../src/ads/decode.js";

// The fixture file stores raw UTF-8 bytes on disk.  When the ingestion pipeline
// mis-decodes those bytes as Latin-1 each UTF-8 byte becomes a separate Unicode
// code-point ≤ 255, producing classic "Ð¡ÐµÐ³Ð°" mojibake.  We recreate that
// mis-decode here so the test is grounded in the real captured sample.

const fixtureUrl = new URL("./fixtures/facebook-ads-sample.json", import.meta.url);

// Read the file as raw bytes, then decode as Latin-1 to get the mojibake string.
const rawBytes = readFileSync(fixtureUrl);

// Node's JSON.parse on a Buffer treats it as UTF-8, which would already fix the
// encoding.  Instead we decode the bytes as Latin-1 first, then parse JSON so
// every string value carries the mojibake characters as-is.
const fixtureText = rawBytes.toString("latin1");
const fixture = JSON.parse(fixtureText) as Array<Record<string, unknown>>;

// Locate the ad we validated manually: adArchiveID 1518690616473103
const ad = fixture.find(
  (x): x is typeof x & { adArchiveID: string } =>
    (x as { adArchiveID?: unknown }).adArchiveID === "1518690616473103",
);

const rawBodyText = (
  ad as {
    snapshot: { body: { text: string } };
  }
).snapshot.body.text;

describe("fixEncoding", () => {
  it("restores mojibake Macedonian Cyrillic to readable text", () => {
    const decoded = fixEncoding(rawBodyText);
    // The raw text starts with "Ð¡ÐµÐ³Ð°" — after fixing it should contain
    // the word "вистинскиот" (Macedonian for "genuine/real").
    expect(decoded).toContain("вистинскиот");
    // Full sentence start should also be present.
    expect(decoded).toContain("Сега");
  });

  it("returns null for null input", () => {
    expect(fixEncoding(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(fixEncoding(undefined)).toBeNull();
  });

  it("passes plain ASCII through unchanged", () => {
    expect(fixEncoding("plain ascii")).toBe("plain ascii");
  });

  it("passes already-clean Cyrillic through unchanged", () => {
    const clean = "Сега е вистинскиот момент";
    expect(fixEncoding(clean)).toBe(clean);
  });
});
