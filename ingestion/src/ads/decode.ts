/**
 * Fix mojibake in ad copy fetched from the Meta Ad Library via Apify.
 *
 * Root cause: the scraper receives UTF-8 Macedonian Cyrillic text but the
 * bytes are mis-decoded as Latin-1 (ISO-8859-1) before being stored as a
 * JavaScript string.  Every UTF-8 two-byte sequence (0xD0–0xD1 0x80–0xBF)
 * therefore surfaces as two code-points ≤ 255 instead of one Cyrillic
 * code-point, producing "Ð¡ÐµÐ³Ð°" instead of "Сега".
 *
 * The repair is: treat each character in the broken string as a raw byte
 * (Latin-1 round-trip), collect the byte array, and re-interpret it as UTF-8.
 */

/** Regex that matches at least one Unicode replacement character. */
const REPLACEMENT = /�/;

/**
 * Returns true when the string looks like it was mis-decoded as Latin-1:
 * specifically, when it contains two-byte pairs matching the 0xD0–0xD1 /
 * 0x80–0xBF pattern that UTF-8 Cyrillic produces.
 */
function looksLikeMojibake(s: string): boolean {
  // A quick heuristic: UTF-8 Cyrillic lead bytes 0xD0 / 0xD1 in Latin-1
  // appear as Ð (U+00D0) or Ñ (U+00D1) followed by a continuation char in
  // the range U+0080–U+00BF.
  return /[ÐÑ][-¿]/.test(s);
}

/**
 * Restore Macedonian (or other UTF-8) text that was mis-decoded as Latin-1.
 *
 * - `null` / `undefined` → `null`
 * - Strings that do not look like mojibake are returned unchanged.
 * - If the attempted fix introduces replacement characters (`�`) the
 *   original string is returned unchanged (defensive pass-through).
 */
export function fixEncoding(s: string | null | undefined): string | null {
  if (s == null) return null;

  if (!looksLikeMojibake(s)) return s;

  try {
    const fixed = Buffer.from(s, "latin1").toString("utf8");
    if (REPLACEMENT.test(fixed)) return s;
    return fixed;
  } catch {
    return s;
  }
}
