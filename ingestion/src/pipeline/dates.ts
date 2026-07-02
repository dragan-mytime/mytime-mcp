// Pure date helpers. No I/O.

/**
 * Current calendar date (YYYY-MM-DD) in Europe/Skopje — the market the scrapes
 * observe. Using the UTC date instead would file post-22:00/23:00 local runs
 * under the previous day (sv-SE locale formats as ISO YYYY-MM-DD).
 */
export function skopjeDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Skopje" }).format(d);
}
